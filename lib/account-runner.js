// File: lib/account-runner.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\lib\account-runner.js
// lib/account-runner.js
// Generic account runner — drives any scraper module (scrapers/<name>/index.js).
// Handles: browser lifecycle, session, tick loop, error recovery, hide/show.

const path = require('path')
const fs   = require('fs')
const { launchForAccount } = require('./browser')
const { hideWindow, showWindow } = require('./win-window')
const { tryClaim, forceClaim, release } = require('./scraper-lock')

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions')

class AccountRunner {
  constructor(account, scraperModule, dash) {
    this.account     = account
    this.module      = scraperModule
    this.dash        = dash

    this.browser     = null
    this.context     = null
    this.page        = null
    this.sessionPath = path.join(SESSIONS_DIR, `${account.id}.json`)

    this.timer       = null
    this.paused      = false
    this.stopped     = false
    this._ticking    = false // guards against an overlapping tick() while recovery is in flight
    this._emptyStreak = 0   // consecutive null/empty scrapes → triggers recovery
    this._errorStreak = 0   // consecutive thrown scrape() errors (unresponsive page / CRM error page) → triggers recovery
    this.isHeadless  = process.env.HEADLESS !== 'false'
    this._cdp        = null
    this._windowId   = null

    // manualLogin accounts (meta.manualLogin === true) never auto-fill credentials.
    // They open a visible browser, wait for the human to log in, and only start
    // ticking once the user runs `resume <id>` in the terminal.
    this.awaitingLogin = false

    // Set once init() runs — manualLogin accounts use a persistent on-disk
    // Chrome profile (see lib/browser.js) instead of a storageState() JSON
    // snapshot, so there's nothing to explicitly save on resume().
    this.isPersistentProfile = false

    // True when another scraper instance (a second `node scraper.js` run
    // deliberately kept as a backup/failover for the same accounts) already
    // holds this account's lock — no browser is launched while this is true;
    // see lib/scraper-lock.js and _enterAwaitingLock() below.
    this.awaitingLock   = false
    this._lockRetryTimer = null
  }

  get interval() {
    return this.module.meta?.interval
        || parseInt(process.env.SCRAPE_INTERVAL_MS)
        || 30000
  }

  // ── Init: claim the account lock, then launch browser + login ──────────────
  // Split so a second scraper instance (a manual backup/failover for the
  // SAME accounts) can be told "not yet, someone else has it" instead of
  // launching a competing browser session — see lib/scraper-lock.js.
  async init(force = false) {
    this.stopped = false

    const gotLock = force ? await forceClaim(this.account.id) : await tryClaim(this.account.id)
    if (!gotLock) {
      this._enterAwaitingLock()
      return
    }
    this.awaitingLock = false
    if (force) this.dash.log(this.account.id, '⚠ Force-claimed lock from other instance')
    await this._launchAndLogin()
  }

  // ── Force-take the lock while sitting in standby (awaitingLock) and launch
  // immediately, instead of waiting for the other holder's heartbeat to go
  // stale — see the `force <id>` command in scraper.js. ─────────────────────
  async forceTakeover() {
    if (this._lockRetryTimer) { clearInterval(this._lockRetryTimer); this._lockRetryTimer = null }
    await forceClaim(this.account.id)
    this.awaitingLock = false
    this.dash.log(this.account.id, '⚠ Force-claimed lock from other instance — taking over')
    await this._launchAndLogin()
    this.start()
  }

  // ── Another instance already holds this account — stand by and keep
  // checking; takes over automatically once that instance's heartbeat goes
  // stale (crash, network loss) or it releases the lock on graceful stop. ───
  _enterAwaitingLock() {
    this.awaitingLock = true
    this.dash.update(this.account.id, { info: 'standby (locked by another instance)', ok: false })
    this.dash.warn(this.account.id, '⏸ Another scraper instance already holds this account — standing by as backup...')
    if (this._lockRetryTimer) return
    this._lockRetryTimer = setInterval(async () => {
      if (this.stopped) { clearInterval(this._lockRetryTimer); this._lockRetryTimer = null; return }
      const got = await tryClaim(this.account.id)
      if (!got) return
      clearInterval(this._lockRetryTimer)
      this._lockRetryTimer = null
      this.awaitingLock = false
      this.dash.log(this.account.id, '▶ Lock acquired — taking over as active scraper')
      await this._launchAndLogin()
      this.start()
    }, 15000)
  }

  // ── Launch browser + login (the actual former body of init()) ──────────────
  async _launchAndLogin() {
    const isManual = !!this.module.meta?.manualLogin

    // Temporarily override HEADLESS env so launchForAccount reads the right value.
    // manualLogin accounts always get a visible window — a human has to see it
    // to log in, so HEADLESS=true would make that impossible.
    const prev = process.env.HEADLESS
    process.env.HEADLESS = isManual ? 'false' : (this.isHeadless ? 'true' : 'false')
    // manualLogin accounts get a persistent on-disk Chrome profile instead of
    // a cookie-only session file — MFA "remember this device" trust tokens
    // commonly live in IndexedDB, which the cookie/localStorage snapshot used
    // for the other accounts never captures. See lib/browser.js.
    const launched = await launchForAccount(this.account, { persistent: isManual })
    process.env.HEADLESS = prev
    if (isManual) this.isHeadless = false
    this.isPersistentProfile = isManual

    this.browser     = launched.browser
    this.context     = launched.context
    this.page        = launched.page
    this.sessionPath = launched.sessionPath || this.sessionPath

    // Module login (navigate, fill credentials, etc. — or for manualLogin
    // modules, just navigate and leave the rest to the human)
    await this.module.login(this.page, this.context, this.account, this.sessionPath)

    // CDP window setup (for hide/show without browser restart)
    if (!this.isHeadless) await this._setupCDP()

    const type = this.module.meta?.type || 'custom'

    if (isManual) {
      const expired = this.module.isSessionExpired
        ? await this.module.isSessionExpired(this.page)
        : true
      if (expired) {
        this._enterAwaitingLogin()
        return
      }
    }

    this.awaitingLogin = false
    this.dash.log(this.account.id, `✅ Logged in — ${this.isHeadless ? 'headless' : 'visible'} [${type}]`)
  }

  // ── Pause ticking and prompt the human to log in + resume manually ──────────
  _enterAwaitingLogin() {
    this.awaitingLogin = true
    this.paused        = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.dash.update(this.account.id, { info: 'awaiting manual login', ok: false })
    this.dash.warn(this.account.id, `⏸ Waiting for manual login — log in in the browser window, then run: resume ${this.account.id}`)
  }

  // ── Recovery: retry module.login() up to 5 times (3s apart), checking after
  // each attempt whether the session actually looks valid again. Used when
  // scraping has gone stale (session silently expired, or a dashboard's live
  // widgets froze) — replaces the old single-attempt-then-give-up-for-90s
  // behavior. If all 5 attempts still leave the session looking expired,
  // forces a hard page.reload() before trying login() once more — a plain
  // goto() to the same URL is a no-op on hash-routed SPAs (e.g. NICE CXone's
  // .../#/dashboard/wrapper/dashboards) that are already "at" that URL, so a
  // real reload is what's actually needed to revive a stuck page.
  async _attemptRecovery() {
    const RETRIES = 5
    const DELAY_MS = 3000

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      this.dash.warn(this.account.id, `Recovery attempt ${attempt}/${RETRIES}...`)
      try {
        await this.module.login(this.page, this.context, this.account, this.sessionPath)
        const stillExpired = await this.module.isSessionExpired?.(this.page)
        if (!stillExpired) {
          this.dash.log(this.account.id, `✅ Recovered on attempt ${attempt}/${RETRIES}`)
          return
        }
      } catch (e) {
        this.dash.warn(this.account.id, `Recovery attempt ${attempt}/${RETRIES} failed: ${e.message}`)
      }
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, DELAY_MS))
    }

    this.dash.warn(this.account.id, `${RETRIES} recovery attempts failed — forcing a full page reload...`)
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      this.dash.warn(this.account.id, `Page reload failed: ${e.message}`)
    }
    try {
      await this.module.login(this.page, this.context, this.account, this.sessionPath)
    } catch (e) {
      this.dash.warn(this.account.id, `Post-reload login failed: ${e.message}`)
    }
  }

  async _setupCDP() {
    try {
      this._cdp = await this.context.newCDPSession(this.page)
      const { windowId } = await this._cdp.send('Browser.getWindowForTarget')
      this._windowId = windowId
    } catch (_) {
      this._cdp = null; this._windowId = null
    }
  }

  // ── Single scrape tick ───────────────────────────────────────────────────────
  async tick() {
    if (this.paused || this.stopped || this._ticking) return
    // Recovery can now sleep for several seconds across retries — long enough
    // that the interval timer could fire a second, overlapping tick() on the
    // same Playwright page before the first one finishes. This flag makes
    // tick() a no-op while one is already in flight instead of racing.
    this._ticking = true

    try {
      // Renew this instance's lock on the account every tick — also the
      // mechanism that would detect a takeover by another instance (only
      // possible if this one's own heartbeats had lapsed past STALE_MS,
      // e.g. a long network outage). Stepping back to standby here avoids
      // two instances actively driving the same CRM session at once.
      if (!(await tryClaim(this.account.id))) {
        this.dash.warn(this.account.id, 'Lock lost to another instance — stepping back to standby...')
        if (this.timer) { clearInterval(this.timer); this.timer = null }
        try { await this.browser?.close() } catch (_) {}
        this._enterAwaitingLock()
        return
      }

      // Optional session-expiry check (module can implement this)
      if (await this.module.isSessionExpired?.(this.page)) {
        if (this.module.meta?.manualLogin) {
          // Give the module's own login() a chance first — some manualLogin
          // modules (e.g. edenhealth) now attempt an optimistic auto-login
          // (credentials only, no MFA) that succeeds whenever the persisted
          // session's "remember this device" trust is still valid, even
          // though the plain session cookie itself expired. Only gate for a
          // human if the module tried and we're STILL not logged in
          // afterward (e.g. an MFA prompt actually appeared).
          await this.module.login(this.page, this.context, this.account, this.sessionPath).catch(() => {})
          const stillExpired = await this.module.isSessionExpired?.(this.page)
          if (stillExpired) {
            this._enterAwaitingLogin()
            return
          }
          this.dash.log(this.account.id, '✅ Session auto-recovered — no manual login needed this time')
        } else {
          this.dash.warn(this.account.id, 'Session expired — attempting recovery...')
          await this._attemptRecovery()
        }
      }

      const data = await this.module.scrape(this.page, this.account)

      if (!data || data.hasData === false) {
        // A stale/blank dashboard (esp. Five9 after idle) returns nothing but the
        // URL still looks valid, so isSessionExpired() won't catch it. After a few
        // consecutive empty scrapes, force recovery — for Five9 this reloads the
        // supervisor page and revives the live widgets.
        this._emptyStreak++
        this.dash.update(this.account.id, {
          time: new Date().toLocaleTimeString(), ok: false,
          info: `empty scrape (${this._emptyStreak})`
        })
        if (this._emptyStreak >= 3) {
          this.dash.warn(this.account.id, `${this._emptyStreak} empty scrapes — attempting recovery...`)
          this._emptyStreak = 0
          await this._attemptRecovery()
        }
        return
      }
      this._emptyStreak = 0
      this._errorStreak = 0

      // Write to Supabase
      await this.module.write(data, this.account.id)

      // Extract display values — module can provide getDisplayInfo() or we try common names
      const display = this.module.getDisplayInfo?.(data) || _extractDisplay(data)

      this.dash.update(this.account.id, {
        time:    new Date().toLocaleTimeString(),
        ok:      data.hasData ?? true,
        sla:     display.sla,
        waiting: display.waiting,
        agents:  display.agents,
        info:    display.info,
        error:   null
      })

    } catch (err) {
      this.dash.update(this.account.id, {
        time: new Date().toLocaleTimeString(), ok: false,
        error: err.message.substring(0, 40)
      })
      this.dash.error(this.account.id, err.message)

      if (_isBrowserCrash(err.message)) {
        this.dash.warn(this.account.id, 'Browser closed — relaunching...')
        try { await this.browser.close() } catch (_) {}
        await new Promise(r => setTimeout(r, 3000))
        if (!this.stopped) {
          await this.init()
          this._ensureTimer()   // re-establish the tick loop after relaunch
        }
      } else {
        // scrape() threw but the browser process itself is still alive — most
        // often a hung/unresponsive page (a selector wait or evaluate() that
        // never resolves) or the CRM rendering its own error page instead of
        // the dashboard. A couple of these in a row means the page won't come
        // back on its own, so fall back to the same login-retry + hard-reload
        // recovery used for expired sessions and empty scrapes.
        this._errorStreak++
        if (this._errorStreak >= 2) {
          this.dash.warn(this.account.id, `${this._errorStreak} scrape errors in a row — page may be unresponsive, attempting recovery...`)
          this._errorStreak = 0
          await this._attemptRecovery()
        }
      }
    } finally {
      this._ticking = false
    }
  }

  // ── Start/pause/resume/stop ──────────────────────────────────────────────────
  start() {
    if (this.stopped) return
    if (this.awaitingLock) return // already logging/retrying in _enterAwaitingLock(); no browser to tick yet
    if (this.awaitingLogin) {
      this.dash.log(this.account.id, `⏸ Awaiting manual login — run: resume ${this.account.id}`)
      return
    }
    this.tick()
    this._ensureTimer()
    this.dash.log(this.account.id, `▶ Scraping every ${this.interval / 1000}s`)
  }

  // Idempotent: (re)create the interval only if one isn't already running.
  _ensureTimer() {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => this.tick(), this.interval)
  }

  pause() {
    this.paused = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.dash.update(this.account.id, { info: 'paused' })
    this.dash.log(this.account.id, '⏸ Paused — scraping stopped, browser stays alive')
  }

  resume() {
    if (this.stopped) return
    if (this.awaitingLogin) {
      this.awaitingLogin = false
      // Persistent-profile accounts (all manualLogin ones) write cookies/
      // localStorage/IndexedDB to disk continuously as a real Chrome profile —
      // nothing to explicitly snapshot. Only the legacy storageState() model
      // needs this save-on-resume.
      if (!this.isPersistentProfile) {
        this.context?.storageState({ path: this.sessionPath }).catch(() => {})
      }
      this.dash.log(this.account.id, '✅ Manual login confirmed — starting scrape loop')
    }
    this.paused = false
    this._ensureTimer()   // restart the loop — don't rely on a possibly-cleared timer
    this.dash.log(this.account.id, '▶ Resumed')
    this.tick()
  }

  async stop() {
    this.stopped = true
    this.paused  = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this._lockRetryTimer) { clearInterval(this._lockRetryTimer); this._lockRetryTimer = null }
    try { await this.browser?.close() } catch (_) {}
    // Explicit release (rather than just letting the heartbeat go stale) so
    // a backup instance can take over immediately instead of waiting out
    // STALE_MS — matters for an intentional stop, not just a crash.
    await release(this.account.id)
    this.dash.update(this.account.id, { info: 'stopped', ok: false })
    this.dash.log(this.account.id, '⏹ Stopped')
  }

  // ── Reload: swap scraper module without full browser restart ─────────────────
  async reload(newModule) {
    this.dash.log(this.account.id, '🔄 Reloading scraper module...')
    // Stop tick loop but keep browser open
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.module = newModule
    try {
      // Re-run login with new module (reuses open browser/session)
      await this.module.login(this.page, this.context, this.account, this.sessionPath)
      if (this.module.meta?.manualLogin) {
        const expired = this.module.isSessionExpired
          ? await this.module.isSessionExpired(this.page)
          : true
        if (expired) { this._enterAwaitingLogin(); return }
      }
      this.awaitingLogin = false
      this.dash.log(this.account.id, '✅ Module reloaded — restarting scrape loop')
    } catch (err) {
      this.dash.warn(this.account.id, `Re-login after reload failed: ${err.message} — full restart...`)
      try { await this.browser?.close() } catch (_) {}
      await new Promise(r => setTimeout(r, 1000))
      await this.init()
    }
    this.start()
  }

  // ── Hide / show browser window ───────────────────────────────────────────────
  async hide() {
    if (this.isHeadless) { this.dash.log(this.account.id, 'Already headless'); return }
    if (this._cdp && this._windowId) {
      try { await this._cdp.send('Browser.setWindowBounds', { windowId: this._windowId, bounds: { windowState: 'minimized' } }) } catch (_) {}
    }
    const title = await this.page?.title().catch(() => '')
    hideWindow(this.browser, title, this.account.id)
    this.dash.log(this.account.id, '✅ Hidden from taskbar — scraping continues')
  }

  async show() {
    if (this.isHeadless) { this.dash.log(this.account.id, 'Running headless'); return }
    const title = await this.page?.title().catch(() => '')
    showWindow(this.browser, title, this.account.id)
    await new Promise(r => setTimeout(r, 300))
    if (this._cdp && this._windowId) {
      try { await this._cdp.send('Browser.setWindowBounds', { windowId: this._windowId, bounds: { windowState: 'normal' } }) } catch (_) {}
    }
    this.dash.log(this.account.id, '✅ Window restored')
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _extractDisplay(data) {
  return {
    sla:     String(data.sla || data.kpi?.sla || data.displaySla || '--').replace(/\s+/g, ''),
    waiting: String(data.callsWaiting ?? data.calls_waiting ?? data.kpi?.calls_waiting ?? data.displayWaiting ?? '0'),
    agents:  String(Array.isArray(data.agents) ? data.agents.length : (data.displayAgents ?? '--')),
    info:    data.displayInfo || (Array.isArray(data.calls) ? `calls:${data.calls.length}` : ''),
  }
}

function _isBrowserCrash(msg) {
  return msg.includes('Target closed') || msg.includes('page has been closed') ||
         msg.includes('Session closed') || msg.includes('Browser has disconnected')
}

module.exports = AccountRunner
