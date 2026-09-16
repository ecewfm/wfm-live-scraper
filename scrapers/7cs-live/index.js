// File: scrapers/7cs-live/index.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\scrapers\7cs-live\index.js
// scrapers/7cs-live/index.js
// Aircall Live Monitoring scraper for 7cs-live.
// Uses the existing lib/browser.js login + lib/scrape.js DOM scraping.
//
// TWO TABS, ONE PER VIEW — Aircall's Live Monitoring splits into /calls and
// /users. The old version reused the single primary tab for both, navigating
// it back and forth between the two URLs every 30s tick — visibly "reloading/
// switching page" if this account is ever run non-headless, and a needless
// full page reload+re-render for data that's already live-updating in place.
// Now the primary tab stays parked on /calls permanently, and a second tab
// (opened once via ensureUsersPage, same "one Page per purpose, reused across
// ticks" pattern as scrapers/wyze/index.js's ensureSecondaryPage) stays
// parked on /users — every tick just re-reads both DOMs, no navigation.

const { login: aircallLogin, gotoLiveMonitoring, isSessionExpired: aircallSessionExpired } = require('../../lib/browser')
const { scrapeWithRetry, buildViewUrl, waitForUsersTableReady } = require('../../lib/scrape')
const { writeSnapshot }   = require('../../lib/db')

// One secondary "/users" tab per account, reused across ticks — mirrors
// scrapers/wyze/index.js's SECONDARY_PAGES cache.
const USERS_PAGES = new Map() // accountId -> Page

async function ensureUsersPage(context, account, currentCallsUrl) {
  let p = USERS_PAGES.get(account.id)
  if (p && !p.isClosed()) return p

  p = await context.newPage()
  USERS_PAGES.set(account.id, p)
  p.on('console', () => {})
  p.on('pageerror', () => {})

  const usersUrl = buildViewUrl(currentCallsUrl, 'users')
  await p.goto(usersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[${account.id}] users tab goto failed: ${e.message}`)
  })
  await waitForUsersTableReady(p)
  return p
}

module.exports = {
  meta: {
    type:     'Aircall',
    interval: 30000,
  },

  // ── Login ───────────────────────────────────────────────────────────────────
  async login(page, context, account, sessionPath) {
    await aircallLogin(page, context, account, sessionPath)
    await gotoLiveMonitoring(page, account.id)
    await ensureUsersPage(context, account, page.url())
  },

  // ── Session expiry check ─────────────────────────────────────────────────────
  isSessionExpired(page) {
    return aircallSessionExpired(page)
  },

  // ── Scrape ──────────────────────────────────────────────────────────────────
  async scrape(page, account) {
    const usersPage = await ensureUsersPage(page.context(), account, page.url())
    // Both tabs share the same login session — if the /users tab specifically
    // drifted off its view (e.g. Aircall redirected it independently), reuse
    // the shared session cookies with a plain goto rather than a full re-login.
    if (aircallSessionExpired(usersPage)) {
      await usersPage.goto(buildViewUrl(page.url(), 'users'), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
    return await scrapeWithRetry(page, usersPage, account.id)
  },

  // ── Write ───────────────────────────────────────────────────────────────────
  async write(data, accountId) {
    if (data && data.hasData) await writeSnapshot(data, accountId)
  },

  // ── Display info for terminal dashboard ─────────────────────────────────────
  getDisplayInfo(data) {
    const slaVal     = data.kpis?.sla || '--'
    const waitingVal = data.kpis?.calls_waiting ?? '0'
    return {
      sla:     String(slaVal).replace(/\s+/g, ''),
      waiting: String(waitingVal),
      agents:  String(Array.isArray(data.agents) ? data.agents.length : '--'),
      info:    Array.isArray(data.calls) ? `calls:${data.calls.length}` : '',
    }
  }
}
