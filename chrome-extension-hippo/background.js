// background.js — Hippo Dashboard Scraper (WFM Live)
// Ports wfm-live-scraper/scrapers/hippo/index.js's Supabase write logic into
// a browser extension service worker. Hippo switched to YubiKey-only login,
// which our Node/Playwright scraper can't script (a hardware key can't be
// automated), so this extension runs in the ALREADY-LOGGED-IN human's own
// browser instead and writes to the exact same Supabase tables.
//
// Keep this file's KNOWN_WIDGETS / write logic in sync with
// wfm-live-scraper/scrapers/hippo/index.js — both write to the same tables,
// so a schema/column change on one side needs the same change on the other.

const SUPABASE_URL = 'https://frycbdxuyvdcybsiwhpt.supabase.co';
// Public anon key — the SAME one already shipped client-side in the WFM Live
// dashboard's own bundle (NEXT_PUBLIC_SUPABASE_ANON_KEY). Safe to embed here;
// never put a service-role key in a distributed extension.
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyeWNiZHh1eXZkY3lic2l3aHB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MjQ0ODAsImV4cCI6MjA5ODIwMDQ4MH0.WeEnWeMIZZ-Uem3aQkkDMNZNrCLP9gpEA2Vi4UkxUQ8';
const ACCOUNT_ID = 'hippo';

async function supabaseUpsert(table, rows) {
  if (!rows || rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase ${table} error: ${res.status} ${txt.substring(0, 120)}`);
  }
}

// ── Departed-row tracking, persisted to chrome.storage.local ────────────────
// An MV3 service worker can be killed and restarted between snapshots — it
// doesn't stay resident the way the Node scraper's own long-lived process
// does — so an in-memory-only "last seen ids" map would lose track on almost
// every tick and silently disable departure cleanup. Persisting it keeps
// this working the same way the Node scraper's does.
const STORAGE_KEY_LAST_SEEN = 'hippo_last_seen_ids'; // { [table]: string[] }

async function getLastSeenMap() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY_LAST_SEEN], res => {
      resolve(res[STORAGE_KEY_LAST_SEEN] || {});
    });
  });
}
function persistLastSeenMap(map) {
  chrome.storage.local.set({ [STORAGE_KEY_LAST_SEEN]: map });
}

async function fetchExistingIds(table, accountId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?account_id=eq.${encodeURIComponent(accountId)}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map(r => r.id);
  } catch (e) {
    return [];
  }
}

async function pruneDeparted(table, accountId, currentIds) {
  const lastSeenMap = await getLastSeenMap();
  const hasSeeded = Object.prototype.hasOwnProperty.call(lastSeenMap, table);

  // First time this table has ever been touched (fresh install, or the
  // service worker's storage was cleared) — seed from Supabase's existing
  // rows instead of an empty set, so pre-existing rows aren't misread as
  // "everyone departed" on the very next tick. No deletion on the seed tick.
  if (!hasSeeded) {
    lastSeenMap[table] = await fetchExistingIds(table, accountId);
    persistLastSeenMap(lastSeenMap);
    return;
  }

  const prevIds = new Set(lastSeenMap[table]);
  const departed = [...prevIds].filter(id => !currentIds.has(id));
  if (departed.length > 0) {
    const filterValue = `(${departed.map(id => `"${String(id).replace(/"/g, '\\"')}"`).join(',')})`;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?id=in.${encodeURIComponent(filterValue)}`,
        { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (res.ok) console.log(`[Hippo BG] ${table}: removed ${departed.length} departed row(s)`);
    } catch (e) { /* best-effort — non-fatal */ }
  }
  lastSeenMap[table] = [...currentIds];
  persistLastSeenMap(lastSeenMap);
}

function sanitizeKey(s) {
  return String(s || '').replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

// ── Known widgets — promoted from the generic hippo_datasets JSONB blob to
// their own typed tables. MUST stay in sync with KNOWN_WIDGETS in
// wfm-live-scraper's scrapers/hippo/index.js — both write the same tables. ──
const KNOWN_WIDGETS = {
  'licensed agents': {
    table: 'hippo_licensed_agents',
    idFrom: 'agent_name',
    columns: {
      'agent name':       'agent_name',
      'team name':        'team_name',
      'session time':     'session_time',
      'agent state':      'agent_state',
      'agent state time': 'agent_state_time',
    },
  },
  'level 1': {
    table: 'hippo_level_1',
    idFrom: 'agent_name',
    columns: {
      'agent name':       'agent_name',
      'team name':        'team_name',
      'session time':     'session_time',
      'agent state':      'agent_state',
      'agent state time': 'agent_state_time',
    },
  },
};

function colIndex(headers, headerName) {
  return headers.findIndex(h => String(h).trim().toLowerCase() === headerName);
}

function mapKnownWidgetRows(dataset, def, accountId, now) {
  const idxByCol = {};
  Object.entries(def.columns).forEach(([header, col]) => {
    idxByCol[col] = colIndex(dataset.headers, header);
  });
  return dataset.rows.map(row => {
    const out = { account_id: accountId, updated_at: now };
    Object.entries(idxByCol).forEach(([col, idx]) => { out[col] = idx >= 0 ? (row[idx] || '') : ''; });
    out.id = `${accountId}:${sanitizeKey(dataset.name)}:${sanitizeKey(out[def.idFrom])}`;
    return out;
  });
}

// ── Write everything scraped this tick to Supabase — mirrors
// wfm-live-scraper's scrapers/hippo/index.js writeHippoData() exactly. ──────
async function writeHippoData(datasets, accountId) {
  const now = new Date().toISOString();

  const kpiDataset = datasets.find(d => d.name === 'KPI_Tiles');
  if (kpiDataset && kpiDataset.rows.length > 0) {
    const kpiRows = kpiDataset.rows.map(([, widgetName, metric, value]) => {
      const key = `${sanitizeKey(widgetName)}:${sanitizeKey(metric)}`;
      return {
        id:         `${accountId}:${key}`,
        account_id: accountId,
        kpi_key:    key,
        label:      metric,
        skill:      widgetName,
        value:      value,
        raw_value:  value,
        updated_at: now,
      };
    });
    await supabaseUpsert('hippo_kpis', kpiRows);
    console.log(`[Hippo BG] KPIs written (${kpiRows.length})`);
  }

  const allTableDatasets = datasets.filter(d => d.name !== 'KPI_Tiles');
  const genericDatasets = [];

  for (const d of allTableDatasets) {
    const def = KNOWN_WIDGETS[d.name.trim().toLowerCase()];
    if (!def) { genericDatasets.push(d); continue; }

    const rows = mapKnownWidgetRows(d, def, accountId, now);
    // Postgres rejects the whole upsert batch if the same id appears twice —
    // dedup (last one wins) so one bad/duplicate row can't take down the
    // entire write.
    const dedupMap = new Map();
    rows.forEach(r => dedupMap.set(r.id, r));
    const dedupedRows = [...dedupMap.values()];

    await pruneDeparted(def.table, accountId, new Set(dedupedRows.map(r => r.id)));
    if (dedupedRows.length > 0) {
      await supabaseUpsert(def.table, dedupedRows);
      console.log(`[Hippo BG] ${d.name} → ${def.table} (${dedupedRows.length} row(s))`);
    }
  }

  // Everything else → generic JSONB bucket (unknown/future widgets)
  if (genericDatasets.length > 0) {
    const rows = genericDatasets.map(d => ({
      id:           `${accountId}:${d.name}`,
      account_id:   accountId,
      dataset_name: d.name,
      headers:      d.headers,
      rows:         d.rows,
      row_count:    d.rows.length,
      updated_at:   now,
    }));
    await supabaseUpsert('hippo_datasets', rows);
    console.log(`[Hippo BG] Datasets written (${rows.length}): ${genericDatasets.map(d => d.name).join(', ')}`);
  }
}

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NICE_WRITE_TO_SUPABASE') {
    writeHippoData(msg.datasets, ACCOUNT_ID)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
