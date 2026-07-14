// File: lib/account-runner.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\lib\account-runner.js
// lib/account-runner.js
// Generic account runner — drives any scraper module (scrapers/<name>/index.js).
// Handles: browser lifecycle, session, tick loop, error recovery, hide/show.

const path = require('path')
const fs   = require('fs')
const { launchForAccount } = require('./browser')
const { hideWindow, showWindow } = require('./win-window')

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
    this._emptyStreak = 0   // consecutive null/empty scrapes → triggers recovery
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
  }

  get interval() {
    return this.module.meta?.interval
        || parseInt(process.env.SCRAPE_INTERVAL_MS)
        || 30000
  }

  // ── Init: launch browser + login ────────────────────────────────────────────
  async init() {
    this.stopped = false

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
    if (this.paused || this.stopped) return

    try {
      // Optional session-expiry check (module can implement this)
      if (await this.module.isSessionExpired?.(this.page)) {
        if (this.module.meta?.manualLogin) {
          // Manual-login accounts can't be auto-relogged-in — gate again and
          // wait for the human to log back in and run `resume <id>`.
          await this.module.login(this.page, this.context, this.account, this.sessionPath).catch(() => {})
          this._enterAwaitingLogin()
          return
        }
        this.dash.warn(this.account.id, 'Session expired — re-logging in...')
        await this.module.login(this.page, this.context, this.account, this.sessionPath)
      }

      const data = await this.module.scrape(this.page, this.account)

      if (!data || data.hasData === false) {
        // A stale/blank dashboard (esp. Five9 after idle) returns nothing but the
        // URL still looks valid, so isSessionExpired() won't catch it. After a few
        // consecutive empty scrapes, force a re-login — for Five9 this reloads the
        // supervisor page and revives the live widgets.
        this._emptyStreak++
        this.dash.update(this.account.id, {
          time: new Date().toLocaleTimeString(), ok: false,
          info: `empty scrape (${this._emptyStreak})`
        })
        if (this._emptyStreak >= 3) {
          this.dash.warn(this.account.id, `${this._emptyStreak} empty scrapes — re-logging in to recover...`)
          this._emptyStreak = 0
          try {
            await this.module.login(this.page, this.context, this.account, this.sessionPath)
          } catch (e) {
            this.dash.warn(this.account.id, `Recovery re-login failed: ${e.message}`)
          }
        }
        return
      }
      this._emptyStreak = 0

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
      }
    }
  }

  // ── Start/pause/resume/stop ──────────────────────────────────────────────────
  start() {
    if (this.stopped) return
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
    try { await this.browser?.close() } catch (_) {}
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
    hideWindow(this.browser, title)
    this.dash.log(this.account.id, '✅ Hidden from taskbar — scraping continues')
  }

  async show() {
    if (this.isHeadless) { this.dash.log(this.account.id, 'Running headless'); return }
    const title = await this.page?.title().catch(() => '')
    showWindow(this.browser, title)
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
