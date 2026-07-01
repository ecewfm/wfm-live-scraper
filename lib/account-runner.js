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
    this.isHeadless  = process.env.HEADLESS !== 'false'
    this._cdp        = null
    this._windowId   = null
  }

  get interval() {
    return this.module.meta?.interval
        || parseInt(process.env.SCRAPE_INTERVAL_MS)
        || 30000
  }

  // ── Init: launch browser + login ────────────────────────────────────────────
  async init() {
    this.stopped = false

    // Temporarily override HEADLESS env so launchForAccount reads the right value
    const prev = process.env.HEADLESS
    process.env.HEADLESS = this.isHeadless ? 'true' : 'false'
    const launched = await launchForAccount(this.account)
    process.env.HEADLESS = prev

    this.browser     = launched.browser
    this.context     = launched.context
    this.page        = launched.page
    this.sessionPath = launched.sessionPath || this.sessionPath

    // Module login (navigate, fill credentials, etc.)
    await this.module.login(this.page, this.context, this.account, this.sessionPath)

    // CDP window setup (for hide/show without browser restart)
    if (!this.isHeadless) await this._setupCDP()

    const type = this.module.meta?.type || 'custom'
    this.dash.log(this.account.id, `✅ Logged in — ${this.isHeadless ? 'headless' : 'visible'} [${type}]`)
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
      if (this.module.isSessionExpired?.(this.page)) {
        this.dash.warn(this.account.id, 'Session expired — re-logging in...')
        await this.module.login(this.page, this.context, this.account, this.sessionPath)
      }

      const data = await this.module.scrape(this.page, this.account)

      if (!data) {
        this.dash.update(this.account.id, {
          time: new Date().toLocaleTimeString(), ok: false, info: 'empty scrape'
        })
        return
      }

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
        if (!this.stopped) await this.init()
      }
    }
  }

  // ── Start/pause/resume/stop ──────────────────────────────────────────────────
  start() {
    if (this.stopped) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.interval)
    this.dash.log(this.account.id, `▶ Scraping every ${this.interval / 1000}s`)
  }

  pause() {
    this.paused = true
    this.dash.update(this.account.id, { info: 'paused' })
    this.dash.log(this.account.id, '⏸ Paused — scraping stopped, browser stays alive')
  }

  resume() {
    this.paused = false
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
    if (this.timer) clearInterval(this.timer)
    this.module = newModule
    try {
      // Re-run login with new module (reuses open browser/session)
      await this.module.login(this.page, this.context, this.account, this.sessionPath)
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
