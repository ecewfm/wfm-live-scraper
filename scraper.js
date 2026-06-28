// scraper.js — WFM Live Scraper
// Supports: aircall, talkdesk (Ashley Phones)
//
// Usage:
//   node scraper.js                               — always headless
//   HEADLESS=false node scraper.js                — visible browser
//   HEADLESS=false AUTO_HIDE=true node scraper.js — visible, hides after first scrape
//
// Commands (type + Enter):
//   hide <id>    — hide browser window from screen AND taskbar
//   show <id>    — restore browser window
//   hide / show  — applies to all accounts
//   retry <id>   — immediately re-scrape
//   status       — print current KPI state
//   help         — list commands

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const { launchForAccount, login, isSessionExpired, gotoLiveMonitoring } = require('./lib/browser');
const { scrapeWithRetry }              = require('./lib/scrape');
const { writeSnapshot }                = require('./lib/db');
const { runTalkdeskAccount }           = require('./lib/scrape-talkdesk');
const TerminalDash                     = require('./lib/terminal-dash');
const { hideWindow, showWindow, getPid } = require('./lib/win-window');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) { console.error('❌ config.json not found.'); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_KEY must be set in .env'); process.exit(1);
}

const ACCOUNTS    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS) || 30000;
const AUTO_HIDE   = process.env.AUTO_HIDE === 'true';

// ── Terminal dashboard ────────────────────────────────────────────────────────
const dash = new TerminalDash(ACCOUNTS, INTERVAL_MS);
dash.init();

// ── Command registries ────────────────────────────────────────────────────────
const retryFns = {};
const hideFns  = {};
const showFns  = {};

// ── CDP helpers ───────────────────────────────────────────────────────────────
async function cdpGetWindowId(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    return { cdp, windowId };
  } catch (e) { return null; }
}

async function cdpSetState(cdp, windowId, windowState) {
  try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } }); } catch (_) {}
}

// ── Aircall account runner ────────────────────────────────────────────────────
async function runAircallAccount(account) {
  let browser, context, page, sessionPath;
  let isHeadless  = process.env.HEADLESS !== 'false';
  let firstScrape = true;
  let _cdp = null;
  let _windowId = null;

  async function init(forceHeadless) {
    const prev = process.env.HEADLESS;
    if (forceHeadless !== undefined) process.env.HEADLESS = forceHeadless ? 'true' : 'false';
    ({ browser, context, page, sessionPath } = await launchForAccount(account));
    process.env.HEADLESS = prev;

    await login(page, context, account, sessionPath);
    await gotoLiveMonitoring(page, account.id);

    // Set up CDP for window control (only when visible)
    _cdp = null; _windowId = null;
    if (!isHeadless) {
      const r = await cdpGetWindowId(context, page);
      if (r) { _cdp = r.cdp; _windowId = r.windowId; }
    }

    dash.log(account.id, `Logged in — ${isHeadless ? 'headless' : 'visible'}`);
  }

  async function hideBrowser() {
    if (isHeadless) { dash.log(account.id, 'Already running headless'); return; }
    if (_cdp && _windowId) {
      await cdpSetState(_cdp, _windowId, 'minimized');
    }
    // Get page title to uniquely identify this Chrome window among multiple instances
    const title = await page.title().catch(() => '')
    if (title) dash.log(account.id, `Window title: "${title}"`)
    const ok = hideWindow(browser, title);
    dash.log(account.id, ok
      ? '✅ Hidden from screen and taskbar — scraping continues'
      : '⚠️ Minimized to taskbar (Win32 hide unavailable)');
  }

  async function showBrowser() {
    if (isHeadless) {
      dash.log(account.id, 'Relaunching with visible window...');
      isHeadless = false;
      try { await browser.close(); } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
      await init(false);
      dash.log(account.id, '✅ Browser is now visible');
      return;
    }
    // Restore from Win32 hide first, then CDP unminimize
    const title = await page.title().catch(() => '')
    showWindow(browser, title);
    await new Promise(r => setTimeout(r, 300));
    if (_cdp && _windowId) await cdpSetState(_cdp, _windowId, 'normal');
    dash.log(account.id, '✅ Window restored');
  }

  async function tick() {
    try {
      if (isSessionExpired(page)) {
        dash.warn(account.id, 'Session expired — re-logging in...');
        await login(page, context, account, sessionPath);
        await gotoLiveMonitoring(page, account.id);
      }

      const scraped = await scrapeWithRetry(page, account.id);
      if (!scraped) {
        dash.update(account.id, { time: new Date().toLocaleTimeString(), ok: false, info: 'empty scrape' });
        return;
      }

      await writeSnapshot(scraped, account.id);

      // Try every known field name for SLA and queue depth
      const slaVal     = scraped.sla || scraped.kpis?.sla || scraped.kpi?.sla || scraped.data?.sla || '--';
      const waitingVal = scraped.callsWaiting ?? scraped.calls_waiting ?? scraped.kpis?.callsWaiting ?? scraped.kpi?.calls_waiting ?? '0';

      dash.update(account.id, {
        time:    new Date().toLocaleTimeString(),
        ok:      scraped.hasData,
        sla:     String(slaVal).replace(/\s+/g, ''),
        waiting: String(waitingVal),
        agents:  String(scraped.agents.length),
        info:    `calls:${scraped.calls.length}`,
        error:   null
      });

      if (firstScrape && scraped.hasData && AUTO_HIDE && !isHeadless) {
        firstScrape = false;
        dash.log(account.id, '✅ First scrape OK — hiding browser (AUTO_HIDE=true)');
        setTimeout(hideBrowser, 1500);
      } else {
        firstScrape = false;
      }

    } catch (err) {
      dash.update(account.id, { time: new Date().toLocaleTimeString(), ok: false, error: err.message.substring(0, 40) });
      dash.error(account.id, err.message);

      if (err.message.includes('Target closed') || err.message.includes('page has been closed')) {
        dash.warn(account.id, !isHeadless
          ? 'Window closed — relaunching headless...'
          : 'Browser crashed — restarting...');
        isHeadless = true; _cdp = null; _windowId = null;
        try { await browser.close(); } catch (_) {}
        await new Promise(r => setTimeout(r, 3000));
        await init(true);
      }
    }
  }

  await init();
  await tick();
  const timer = setInterval(tick, INTERVAL_MS);

  retryFns[account.id] = tick;
  hideFns[account.id]  = hideBrowser;
  showFns[account.id]  = showBrowser;

  return async () => { clearInterval(timer); try { await browser.close(); } catch (_) {} };
}

// ── Talkdesk account runner ───────────────────────────────────────────────────
async function runTalkdeskAccountWithDash(account) {
  const { chromium } = require('playwright');

  account._onUpdate = (data) => {
    dash.update(account.id, {
      time:    new Date().toLocaleTimeString(),
      ok:      data.hasData,
      sla:     data.sla     || '--',
      waiting: data.waiting || '0',
      agents:  String(data.agents || '--'),
      info:    data.hasData ? `LOBs:${data.lobs}` : 'empty',
      error:   data.error || null
    });
    if (data.logMsg) dash.log(account.id, data.logMsg);
    if (data.error)  dash.error(account.id, data.error);
  };

  account._onLog    = (msg) => dash.log(account.id, msg);
  account._onWarn   = (msg) => dash.warn(account.id, msg);
  account._onErr    = (msg) => dash.error(account.id, msg);
  account._autoHide = AUTO_HIDE;

  retryFns[account.id] = () => {
    if (typeof account._tick === 'function') { dash.log(account.id, 'Retrying...'); account._tick(); }
    else dash.warn(account.id, 'Not ready yet');
  };
  hideFns[account.id] = () => {
    if (typeof account._hide === 'function') account._hide();
    else dash.warn(account.id, 'Not ready yet');
  };
  showFns[account.id] = () => {
    if (typeof account._show === 'function') account._show();
    else dash.warn(account.id, 'Not ready yet');
  };

  return runTalkdeskAccount(account, { chromium, INTERVAL_MS });
}

// ── Command handler ───────────────────────────────────────────────────────────
function handleCommand(raw) {
  const line  = raw.trim().replace(/['"]/g, '');
  if (!line) return;
  const parts = line.split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg   = parts[1];

  switch (cmd) {
    case 'hide': {
      const ids = arg ? [arg] : Object.keys(hideFns);
      if (arg && !hideFns[arg]) { dash.log(null, `Unknown: "${arg}"  Available: ${Object.keys(hideFns).join(', ')}`); return; }
      ids.forEach(id => hideFns[id]?.());
      break;
    }
    case 'show': {
      const ids = arg ? [arg] : Object.keys(showFns);
      if (arg && !showFns[arg]) { dash.log(null, `Unknown: "${arg}"  Available: ${Object.keys(showFns).join(', ')}`); return; }
      ids.forEach(id => showFns[id]?.());
      break;
    }
    case 'retry': {
      if (!arg) { dash.log(null, `Usage: retry <id>  Available: ${Object.keys(retryFns).join(', ')}`); return; }
      if (!retryFns[arg]) { dash.log(null, `Unknown: "${arg}"`); return; }
      dash.log(null, `▶ Retrying ${arg}...`); retryFns[arg]();
      break;
    }
    case 'status':
      ACCOUNTS.forEach(a => {
        const s  = dash.states[a.id];
        const st = s.error ? `❌ ${s.error}` : s.ok ? `✅ SLA:${s.sla} Q:${s.waiting} Agt:${s.agents}` : `⏳ ${s.info}`;
        dash.log(null, `${a.id.padEnd(20)} ${s.time || '--:--'}  ${st}`);
      });
      break;
    case 'help': case '?':
      dash.log(null, 'hide <id>  |  show <id>  |  retry <id>  |  status  |  help');
      dash.log(null, `Accounts : ${ACCOUNTS.map(a => a.id).join(', ')}`);
      break;
    default:
      dash.log(null, `Unknown: "${cmd}"  — type help`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const cleanups = [];
  try {
    for (const account of ACCOUNTS) {
      const type = account.type || 'aircall';
      dash.update(account.id, { info: `starting (${type})...` });
      if (type === 'talkdesk') {
        runTalkdeskAccountWithDash(account).catch(err => {
          dash.error(account.id, `Fatal: ${err.message}`);
          dash.update(account.id, { ok: false, error: err.message.substring(0, 40) });
        });
      } else {
        const cleanup = await runAircallAccount(account);
        cleanups.push(cleanup);
      }
    }
  } catch (err) {
    dash.error(null, `Fatal: ${err.message}`);
    process.exit(1);
  }

  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let _buf = '';
  process.stdin.on('data', chunk => {
    _buf += chunk;
    const lines = _buf.split(/\r?\n/);
    _buf = lines.pop();
    lines.forEach(l => handleCommand(l));
  });

  setTimeout(() => {
    if (process.env.HEADLESS === 'false')
      dash.log(null, '👁  Visible mode — type "hide <id>" to hide, "show <id>" to restore');
    dash.log(null, 'Commands: hide <id>  |  show <id>  |  retry <id>  |  status  |  help');
  }, 2000);

  process.on('SIGINT', async () => {
    dash.log(null, 'Shutting down...');
    for (const cleanup of cleanups) { try { await cleanup(); } catch (_) {} }
    process.stdout.write('\x1b[r\x1b[?25h\n');
    process.exit(0);
  });
})();
