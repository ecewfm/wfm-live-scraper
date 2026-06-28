// lib/browser.js
// Handles Playwright browser lifecycle, login to Aircall, and session file persistence.
// Each account gets its own browser context + session JSON so they stay independent.

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const SESSIONS_DIR   = path.join(__dirname, '..', 'sessions');
const TARGET_URL     = 'https://dashboard.aircall.io/live_monitoring_plus/calls';
const DASHBOARD_HOST = 'dashboard.aircall.io';

// ── Launch a browser + context for one account ───────────────────────────────
async function launchForAccount(account) {
  const headless    = process.env.HEADLESS !== 'false';
  const sessionPath = path.join(SESSIONS_DIR, `${account.id}.json`);

const browser = await chromium.launch({
  headless,
  executablePath: process.env.CHROME_PATH,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});

  // Load existing session if we have one
  const contextOpts = fs.existsSync(sessionPath)
    ? { storageState: sessionPath }
    : {};

  const context = await browser.newContext(contextOpts);
  const page    = await context.newPage();

  // Suppress noisy console output from the Aircall SPA
  page.on('console', () => {});
  page.on('pageerror', () => {});

  return { browser, context, page, sessionPath };
}

// ── Full login flow ───────────────────────────────────────────────────────────
// Handles both the dashboard /login stub and the auth.aircall.io form.
async function login(page, context, account, sessionPath) {
  const tag = `[${account.id}]`;

  console.log(`${tag} Logging in...`);

  // Step 1 — navigate to dashboard. If not logged in it will show /login.
  await page.goto('https://dashboard.aircall.io', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Step 2 — if we landed on the dashboard /login page, click "Sign in to Aircall"
  if (/\/login/.test(page.url())) {
    console.log(`${tag} On /login — clicking Sign in to Aircall...`);
    const btn = await page.waitForSelector(
      'button:has-text("Sign in to Aircall"), a:has-text("Sign in to Aircall")',
      { timeout: 15000 }
    ).catch(() => null);

    if (btn) {
      await btn.click();
    } else {
      // Fallback: try navigating directly to auth
      console.log(`${tag} Sign-in button not found, going directly to auth...`);
      await page.goto('https://auth.aircall.io/login', { waitUntil: 'domcontentloaded' });
    }
  }

  // Step 3 — wait for auth.aircall.io form
  if (page.url().includes('auth.aircall.io')) {
    console.log(`${tag} Filling credentials on auth.aircall.io...`);
    await page.waitForSelector('#email',         { timeout: 20000 });
    await page.waitForSelector('#password',       { timeout: 5000 });
    await page.waitForSelector('#signin-button',  { timeout: 5000 });

    // Playwright handles React inputs correctly — no setNativeValue hack needed
    await page.fill('#email',    account.email);
    await page.fill('#password', account.password);

    await page.waitForTimeout(300);
    await page.click('#signin-button');

    console.log(`${tag} Submitted — waiting for redirect to dashboard...`);
    await page.waitForURL(`**/${DASHBOARD_HOST}/**`, { timeout: 30000 });
    console.log(`${tag} Login successful!`);

    // Persist session so the next run skips this step
    await context.storageState({ path: sessionPath });
    console.log(`${tag} Session saved → ${sessionPath}`);
  }
}

// ── Check if current page is still on a valid dashboard route ────────────────
function isSessionExpired(page) {
  const url = page.url();
  return url.includes('auth.aircall.io') || /\/login/.test(url) || !url.includes(DASHBOARD_HOST);
}

// ── Navigate to Live Monitoring and wait for KPI tiles ───────────────────────
async function gotoLiveMonitoring(page, accountId) {
  const tag = `[${accountId}]`;

  if (page.url() !== TARGET_URL) {
    console.log(`${tag} Navigating to live monitoring...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  console.log(`${tag} Waiting for KPI tiles to render...`);
  const found = await page.waitForSelector(
    '[data-test="sla-tile"], [data-test="total-calls-tile"], [data-test="calls-waiting-tile"], [data-test="available-users-tile"]',
    { timeout: 60000 }
  ).then(() => true).catch(() => false);

  if (!found) {
    console.warn(`${tag} KPI tiles not detected after 60s — will try scraping anyway.`);
  } else {
    console.log(`${tag} Live monitoring ready.`);
  }
}

module.exports = { launchForAccount, login, isSessionExpired, gotoLiveMonitoring };
