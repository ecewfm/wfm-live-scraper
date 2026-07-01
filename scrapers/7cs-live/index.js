// File: scrapers/7cs-live/index.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\scrapers\7cs-live\index.js
// scrapers/7cs-live/index.js
// Aircall Live Monitoring scraper for 7cs-live.
// Uses the existing lib/browser.js login + lib/scrape.js DOM scraping.

const { login: aircallLogin, gotoLiveMonitoring, isSessionExpired: aircallSessionExpired } = require('../../lib/browser')
const { scrapeWithRetry } = require('../../lib/scrape')
const { writeSnapshot }   = require('../../lib/db')

module.exports = {
  meta: {
    type:     'Aircall',
    interval: 30000,
  },

  // ── Login ───────────────────────────────────────────────────────────────────
  async login(page, context, account, sessionPath) {
    await aircallLogin(page, context, account, sessionPath)
    await gotoLiveMonitoring(page, account.id)
  },

  // ── Session expiry check ─────────────────────────────────────────────────────
  isSessionExpired(page) {
    return aircallSessionExpired(page)
  },

  // ── Scrape ──────────────────────────────────────────────────────────────────
  async scrape(page, account) {
    return await scrapeWithRetry(page, account.id)
  },

  // ── Write ───────────────────────────────────────────────────────────────────
  async write(data, accountId) {
    if (data && data.hasData) await writeSnapshot(data, accountId)
  },

  // ── Display info for terminal dashboard ─────────────────────────────────────
  getDisplayInfo(data) {
    const slaVal     = data.sla || data.kpi?.sla || '--'
    const waitingVal = data.callsWaiting ?? data.calls_waiting ?? data.kpi?.calls_waiting ?? '0'
    return {
      sla:     String(slaVal).replace(/\s+/g, ''),
      waiting: String(waitingVal),
      agents:  String(Array.isArray(data.agents) ? data.agents.length : '--'),
      info:    Array.isArray(data.calls) ? `calls:${data.calls.length}` : '',
    }
  }
}
