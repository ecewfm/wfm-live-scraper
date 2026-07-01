// File: scrapers/_template/index.js
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-scraper\scrapers\_template\index.js
// scrapers/_template/index.js
// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE — copy this folder to scrapers/<your-account-id>/ and edit below.
//
// The folder name = the account ID (must match config.json "id" field).
//
// Required exports:  meta, login, scrape, write
// Optional exports:  isSessionExpired, getDisplayInfo, onScrapeSuccess
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {

  // ── Metadata ────────────────────────────────────────────────────────────────
  meta: {
    type:     'custom',   // Label shown in terminal dashboard (e.g. 'Aircall', 'Talkdesk')
    interval: 30000,      // Scrape interval in ms. Remove to use global SCRAPE_INTERVAL_MS
  },

  // ── Login ───────────────────────────────────────────────────────────────────
  // Called once on startup (and again on session expiry / reload).
  // Set up the browser, log in, and navigate to the live monitoring page.
  //
  // page:        Playwright Page object
  // context:     Playwright BrowserContext
  // account:     { id, email, password, ...any extra fields from config.json }
  // sessionPath: file path where cookies should be saved (for auto-login next run)
  //
  async login(page, context, account, sessionPath) {
    // Example:
    // await page.goto('https://your-crm.com/login')
    // await page.fill('#email', account.email)
    // await page.fill('#password', account.password)
    // await page.click('button[type="submit"]')
    // await page.waitForURL('**/dashboard**', { timeout: 30000 })
    // await context.storageState({ path: sessionPath })
    throw new Error('login() not implemented — edit scrapers/<account>/index.js')
  },

  // ── Scrape ──────────────────────────────────────────────────────────────────
  // Called every `interval` ms.
  // Return an object with your scraped data, or null if nothing to report.
  // The runner will call write() with this result if it's not null.
  //
  async scrape(page, account) {
    return await page.evaluate(() => {
      // Your DOM scraping logic here.
      // This runs inside the browser — use document.querySelector etc.
      return {
        hasData: true,

        // Standard display fields (shown in terminal dashboard):
        sla:          document.querySelector('.sla-value')?.textContent?.trim() || '--',
        callsWaiting: document.querySelector('.queue-count')?.textContent?.trim() || '0',

        // Agent list (optional but useful):
        agents: [],

        // Any extra data you need for write():
        raw: {}
      }
    })
  },

  // ── Write to Supabase ────────────────────────────────────────────────────────
  // Called after a successful scrape. Persist data to Supabase.
  // Use supabaseUpsert from ../../lib/db-utils or write via fetch directly.
  //
  async write(data, accountId) {
    // Example:
    // const SUPABASE_URL = process.env.SUPABASE_URL
    // const SUPABASE_KEY = process.env.SUPABASE_KEY
    // await fetch(`${SUPABASE_URL}/rest/v1/my_table`, {
    //   method: 'POST',
    //   headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
    //              'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    //   body: JSON.stringify([{ id: accountId, account_id: accountId, ...data }])
    // })
    console.log(`[${accountId}] write() not implemented`)
  },

  // ── Optional: check if session expired ──────────────────────────────────────
  // Return true if the current page indicates the session has expired.
  // If omitted, the runner won't auto-detect session expiry.
  //
  // isSessionExpired(page) {
  //   return page.url().includes('/login')
  // },

  // ── Optional: custom display info ───────────────────────────────────────────
  // Return display values for the terminal dashboard.
  // If omitted, the runner extracts from common field names (sla, callsWaiting, etc.)
  //
  // getDisplayInfo(data) {
  //   return {
  //     sla:     data.sla,
  //     waiting: data.queue,
  //     agents:  String(data.agents.length),
  //     info:    `calls:${data.calls}`
  //   }
  // },

  // ── Optional: success hook ───────────────────────────────────────────────────
  // Called after every successful scrape + write.
  //
  // onScrapeSuccess(data, accountId) {
  //   console.log(`[${accountId}] scrape OK`)
  // }
}
