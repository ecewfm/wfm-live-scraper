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
    type:        'custom',   // Label shown in terminal dashboard (e.g. 'Aircall', 'Talkdesk')
    interval:    30000,      // Scrape interval in ms. Remove to use global SCRAPE_INTERVAL_MS

    // DEFAULT: manualLogin = true. Most CRMs are hard to script login for
    // (SSO, MFA, captchas, per-tenant login pages) — so by default this runner
    // opens a VISIBLE browser at startup, navigates to the login page, and then
    // WAITS. It does not touch the tick loop until you log in by hand in that
    // window and run `resume <account-id>` in the scraper.js terminal.
    //
    // Only set this to false once you've written a real fill/submit flow below
    // AND verified it works unattended (see perfectserve/uniters/7cs-live for
    // examples of fully-automated login) — false means the runner assumes
    // login() logs in for real, every time, with no human involved.
    manualLogin: true,
  },

  // ── Login ───────────────────────────────────────────────────────────────────
  // Called once on startup (and again on session expiry / reload).
  //
  // page:        Playwright Page object
  // context:     Playwright BrowserContext
  // account:     { id, ...any extra fields from config.json, e.g. dashboardUrl }
  // sessionPath: file path where cookies get saved after a successful manual
  //              login (via resume()) — reused next run so you don't have to
  //              log in again as long as the session is still valid.
  //
  // manualLogin mode (default): just navigate to the dashboard/login URL and
  // return. Do NOT fill credentials — the human does that in the visible window.
  async login(page, context, account, sessionPath) {
    await page.goto(account.dashboardUrl || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})

    // ── If you set manualLogin: false above, replace the line above with a
    //    real automated flow instead, e.g.:
    // await page.goto('https://your-crm.com/login')
    // await page.fill('#email', account.email)
    // await page.fill('#password', account.password)
    // await page.click('button[type="submit"]')
    // await page.waitForURL('**/dashboard**', { timeout: 30000 })
    // await context.storageState({ path: sessionPath })
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

  // ── isSessionExpired — REQUIRED when manualLogin: true ───────────────────────
  // This is how the runner decides whether to gate for manual login: called
  // right after login() on init(), on every tick, and after reload(). Return
  // true = not logged in (runner will pause + wait for `resume <id>`).
  // If omitted while manualLogin is true, the runner assumes "always expired"
  // and will gate on every single init/reload.
  //
  // Adjust the URL pattern once you know what this CRM's login/SSO page looks
  // like (e.g. 'login', 'signin', 'sso', 'okta', 'auth0' are common substrings).
  isSessionExpired(page) {
    return /login|signin|sso|auth0|okta/i.test(page.url())
  },

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
