// lib/scrape.js
// Aircall "Live Monitoring +" scraper (redesigned UI, ~Sept 2026).
//
// Aircall split what used to be one page into two views under the same KPI
// tile strip: /live_monitoring_plus/users (per-agent status table) and
// /live_monitoring_plus/calls (active calls table) — both share the same
// query-string filters (time_range, users, sla_threshold, etc.), only the
// path segment differs. Every tick visits both, keyed off whichever view the
// account's saved Aircall filter currently defaults to (that default can
// change any time a human clicks "Save filter" in Aircall itself with a
// different tab selected — buildViewUrl() below is robust to that by always
// deriving the target URL from the CURRENT one rather than assuming a fixed
// starting view).
//
// KPI tile values moved from separate tile-number/tile-duration/tile-header/
// tile-extra data-test hooks to a single unified tile-value (getTileValue
// below) — the old getTile() silently returned garbage once Aircall made
// this change, since none of the attributes it looked for existed anymore.
//
// Per-agent status used to be scraped by regex-parsing document.body.innerText
// looking for a "User status\nUser status" marker — fragile, and broken by
// this redesign anyway. The new Users table exposes status cleanly per row
// via data-test="user-status" (e.g. "Available for 40min 28s") plus a
// data-test="user-status-badge-<STATUS>" enum, so scrapeUsersView() reads
// that directly instead.

// ── Expand collapsed agent status sections ───────────────────────────────────
// Kept from the pre-redesign UI as a harmless no-op safety net — the
// redesigned tables haven't shown any collapsed sections in testing, but if
// Aircall reintroduces any, this still handles them.
async function ensureExpanded(page) {
  await page.evaluate(() => {
    const statusLabels = /Available|Ringing|In call|After call work|Offline|Not available|On a break/i;
    document.querySelectorAll('[aria-expanded="false"], [data-state="closed"]').forEach(el => {
      if (statusLabels.test(el.innerText || '')) {
        try { el.click(); } catch (_) {}
      }
    });
  });
  await page.waitForTimeout(300);
}

// ── Swap the view segment of a live_monitoring_plus URL, keeping every other
// query param (time_range, users, sla_threshold, etc.) untouched. ───────────
function buildViewUrl(currentUrl, view) {
  return currentUrl.replace(/\/live_monitoring_plus\/(calls|users|numbers)(?=[/?]|$)/, `/live_monitoring_plus/${view}`);
}

// Waits for the total-calls tile specifically to have a populated
// tile-value child — not just for the tile CONTAINER to exist. The
// container renders immediately with just its label; the actual number
// arrives a moment later from a separate, slower metrics call, so checking
// only for the container's presence was a race that let scrapeCallsView()
// run while every tile still only had its label text in the DOM (the exact
// cause of KPI values coming back as e.g. "SLA"/"Calls waiting" instead of
// real numbers).
async function waitForKpiTiles(page, maxMs = 30000) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-test="total-calls-tile"]');
      return !!(el && el.querySelector('[data-test="tile-value"]'));
    },
    { timeout: maxMs }
  ).catch(() => {});
}

// ── Calls view — KPI tiles (shown on every view, so scraped here as the one
// canonical read) + the active calls table. ─────────────────────────────────
async function scrapeCallsView(page) {
  return await page.evaluate(() => {
    function getTileValue(id) {
      const el = document.querySelector(`[data-test="${id}"]`);
      if (!el) return 'N/A';
      const v = el.querySelector('[data-test="tile-value"]');
      if (v) return v.innerText.trim().replace(/\n/g, ' ');
      // sla-tile (and possibly others) render their number without a
      // tile-value child at all — fall back to the tile's own leading text.
      // sla-tile's raw text has a stray space INSIDE the number itself (e.g.
      // "83 .3% SLA", from two separately-rendered text nodes) — the % must
      // be captured as part of the same match so it survives the whitespace
      // strip below instead of being cut off wherever the space happened to
      // land.
      const raw = el.innerText.trim();
      const m = raw.match(/^([\d.,\s]+%)/);
      if (m) return m[1].replace(/\s+/g, '');
      return raw.split('\n')[0].replace(/\s+/g, ' ').trim();
    }

    const kpis = {};
    kpis['sla']              = getTileValue('sla-tile');
    kpis['total_calls']      = getTileValue('total-calls-tile');
    kpis['outbound']         = getTileValue('outbound-tile');
    kpis['inbound']          = getTileValue('inbound-tile');
    kpis['answered']         = getTileValue('answered-tile');
    kpis['unanswered']       = getTileValue('unanswered-tile');
    kpis['time_to_answer']   = getTileValue('time-to-answer-tile');
    kpis['longest_waiting']  = getTileValue('longest-waiting-tile');
    kpis['available_users']  = getTileValue('available-users-tile');
    kpis['calls_waiting']    = getTileValue('calls-waiting-tile');

    const calls = [];
    const container = document.querySelector('[data-test="calls-table-container"]');
    if (container) {
      container.querySelectorAll('tbody tr').forEach(row => {
        const iconEl = row.querySelector('svg.lucide');
        let direction = 'Unknown';
        if (iconEl) {
          if (iconEl.classList.contains('lucide-phone-outgoing')) direction = 'Outbound';
          else if (iconEl.classList.contains('lucide-phone-incoming')) direction = 'Inbound';
        }
        const nameEl   = row.querySelector('[data-test="typography-stack-primary"]');
        const lineEl   = row.querySelector('[data-test="line-title"]');
        const numberEl = row.querySelector('[data-test="user-number"]');
        const statusEl = row.querySelector('[data-test="call-status"]');

        // "Started at" has no unique data-test hook of its own — find the
        // table-cell whose text matches a plain time-of-day pattern instead.
        let startedAt = '';
        const cells = row.querySelectorAll('[data-test="table-cell"]');
        for (const cell of cells) {
          const t = cell.innerText.trim();
          if (/^\d{1,2}:\d{2}:\d{2}\s*[AP]M$/.test(t)) { startedAt = t; break; }
        }

        calls.push({
          direction,
          user:       nameEl ? nameEl.innerText.trim() : '',
          number:     numberEl ? numberEl.innerText.trim() : '',
          customer:   lineEl ? lineEl.innerText.trim() : '',
          status:     statusEl ? statusEl.innerText.trim() : '',
          started_at: startedAt,
        });
      });
    }

    return { kpis, calls };
  });
}

// ── Users view — per-agent status, read straight off each row's clean
// data-test hooks instead of the old body-text regex parse. ────────────────
async function scrapeUsersView(page) {
  return await page.evaluate(() => {
    const agents = [];
    const statusCounts = {};

    const container = document.querySelector('[data-test="users-table-container"]');
    const userRows = container ? container.querySelectorAll('[data-test="user"]') : [];

    userRows.forEach(userEl => {
      const name = userEl.innerText.trim();
      const row = userEl.closest('tr');
      if (!row) return;
      const statusEl = row.querySelector('[data-test="user-status"]');
      const statusText = statusEl ? statusEl.innerText.trim() : '';
      // "Available for 40min 28s" -> status="Available", duration="40min 28s"
      const m = statusText.match(/^(.+?)\s+for\s+(.+)$/);
      const status   = m ? m[1].trim() : statusText;
      const duration = m ? m[2].trim() : '';
      if (name) agents.push({ name, status, duration });
      if (status) statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    return { agents, totalUsers: userRows.length, userStatus: statusCounts };
  });
}

// Same race as the KPI tiles above — wait for an actual agent ROW, not just
// the table container (which renders before its rows populate).
async function waitForUsersTableReady(page, maxMs = 30000) {
  await page.waitForFunction(
    () => {
      const c = document.querySelector('[data-test="users-table-container"]');
      return !!(c && c.querySelector('[data-test="user"]'));
    },
    { timeout: maxMs }
  ).catch(() => {});
}

// ── Core scrape function — reads both views every tick from their OWN tabs.
// Each tab stays permanently parked on its view (see scrapers/7cs-live/
// index.js's ensureUsersPage()) — Aircall's Live Monitoring is a live-
// updating SPA, so re-reading the DOM is enough to pick up fresh data; no
// navigation is needed on a steady-state tick, unlike the old single-tab
// version that flipped the one visible page between /calls and /users every
// 30s (the "reloading/switching page" behavior this was replaced to fix). ──
async function scrapeAircallTwoPages(callsPage, usersPage) {
  await ensureExpanded(callsPage);
  await waitForKpiTiles(callsPage);
  await ensureExpanded(callsPage);
  const callsData = await scrapeCallsView(callsPage);

  await ensureExpanded(usersPage);
  await waitForUsersTableReady(usersPage);
  await ensureExpanded(usersPage);
  const usersData = await scrapeUsersView(usersPage);

  const kpis = callsData.kpis;
  kpis['calls_in_table'] = String(callsData.calls.length);
  kpis['total_users']    = String(usersData.totalUsers);

  // total-calls-tile is always a bare integer — if it isn't, getTileValue()
  // fell back to label text (tile-value hadn't rendered yet), the same
  // failure mode waitForKpiTiles() above is meant to prevent. Treating that
  // as "no data" lets scrapeWithRetry() below retry instead of writing
  // garbage to Supabase.
  const kpisLookValid = /^\d+$/.test(kpis['total_calls']);
  const hasData = kpisLookValid && Object.values(kpis).some(v => v && v !== 'N/A' && v !== '-' && v !== '');

  return {
    kpis,
    calls:      callsData.calls,
    userStatus: usersData.userStatus,
    agents:     usersData.agents,
    hasData,
  };
}

// ── Retry wrapper — mirrors doSnap() retry logic ─────────────────────────────
// Retries up to maxAttempts if KPIs come back empty (tiles still rendering).
async function scrapeWithRetry(callsPage, usersPage, accountId, maxAttempts = 3) {
  const tag = `[${accountId}]`;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await scrapeAircallTwoPages(callsPage, usersPage);
    lastResult = data;

    if (data.hasData) return data;

    if (attempt < maxAttempts) {
      console.warn(`${tag} KPIs empty on attempt ${attempt}/${maxAttempts} — retrying in 1s...`);
      await callsPage.waitForTimeout(1000);
    }
  }

  if (lastResult && !lastResult.hasData) {
    console.warn(`${tag} All ${maxAttempts} attempts returned empty KPIs — tiles may still be loading.`);
  }

  return lastResult;
}

module.exports = { scrapeWithRetry, buildViewUrl, waitForUsersTableReady };
