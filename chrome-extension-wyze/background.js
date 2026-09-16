// background.js — Wyze Dashboard Scraper (WFM Live)
// Ports wfm-live-scraper/scrapers/wyze/index.js's Supabase write logic into a
// browser extension service worker. Zendesk added MFA/2FA to this account,
// which our Node/Playwright scraper can no longer get past unattended, so
// this extension runs in the ALREADY-LOGGED-IN human's own browser instead
// and writes to the exact same Supabase tables.
//
// Keep this file's write logic in sync with wfm-live-scraper/scrapers/
// wyze/index.js's writeWyzeData() — both write to the same tables, so a
// schema/column change on one side needs the same change on the other.

const SUPABASE_URL = 'https://frycbdxuyvdcybsiwhpt.supabase.co';
// Public anon key — the SAME one already shipped client-side in the WFM Live
// dashboard's own bundle (NEXT_PUBLIC_SUPABASE_ANON_KEY). Safe to embed here;
// never put a service-role key in a distributed extension.
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyeWNiZHh1eXZkY3lic2l3aHB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MjQ0ODAsImV4cCI6MjA5ODIwMDQ4MH0.WeEnWeMIZZ-Uem3aQkkDMNZNrCLP9gpEA2Vi4UkxUQ8';
const ACCOUNT_ID = 'wyze';

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

function sanitizeKey(s) {
  return String(s || '').replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

// Postgres rejects the whole upsert batch if the same id appears twice.
function dedupeById(rows) {
  const map = new Map();
  rows.forEach(r => map.set(r.id, r));
  return [...map.values()];
}

// ── Departed-row tracking, persisted to chrome.storage.local ────────────────
// An MV3 service worker can be killed and restarted between snapshots, so an
// in-memory-only "last seen ids" map (like the Node scraper's _lastSeenIds)
// would lose track on almost every tick and silently disable departure
// cleanup. Persisting it keeps this working the same way the Node scraper's
// in-memory map does across its own long-lived process. Only wyze_agents
// needs this — an agent who logs out with no visible "Offline" status would
// otherwise be left frozen in Supabase forever; wyze_kpis/wyze_chat_monitor
// rows just get overwritten in place every tick, nothing to prune.
const STORAGE_KEY_LAST_SEEN = 'wyze_last_seen_ids'; // { [table]: string[] }

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
      if (res.ok) console.log(`[Wyze BG] ${table}: removed ${departed.length} departed row(s)`);
    } catch (e) { /* best-effort — non-fatal */ }
  }
  lastSeenMap[table] = [...currentIds];
  persistLastSeenMap(lastSeenMap);
}

// ── Writers — mirror wfm-live-scraper's scrapers/wyze/index.js writeWyzeData()
async function writeAgents(agents, accountId) {
  if (!agents || agents.length === 0) return;
  const now = new Date().toISOString();
  const agentRows = agents.map(a => ({
    id: `${accountId}:${a.name}`,
    account_id: accountId,
    agent_name: a.name,
    activity: a.activity,
    ticket_number: a.ticketNumber,
    activity_duration: a.activityDuration,
    adherence_current: a.adherenceCurrent,
    adherence_duration: a.adherenceDuration,
    status: a.status,
    status_duration: a.statusDuration,
    updated_at: now,
  }));
  const dedupedAgentRows = dedupeById(agentRows);
  await pruneDeparted('wyze_agents', accountId, new Set(dedupedAgentRows.map(r => r.id)));
  await supabaseUpsert('wyze_agents', dedupedAgentRows);
  console.log(`[Wyze BG] Agents written (${dedupedAgentRows.length})`);
}

async function writeChatMonitor(chatMonitor, accountId) {
  if (!chatMonitor || chatMonitor.length === 0) return;
  const now = new Date().toISOString();
  const chatRows = chatMonitor.map(c => ({
    id: `${accountId}:${sanitizeKey(c.card)}:${sanitizeKey(c.metric)}`,
    account_id: accountId,
    card: c.card,
    metric: c.metric,
    value: c.value,
    updated_at: now,
  }));
  await supabaseUpsert('wyze_chat_monitor', dedupeById(chatRows));
  console.log(`[Wyze BG] Chat Monitor written (${chatRows.length})`);
}

async function writeKpis(kpis, accountId) {
  if (!kpis || kpis.length === 0) return;
  const now = new Date().toISOString();
  const kpiRows = kpis.map(k => ({
    id: `${accountId}:${sanitizeKey(k.label)}`,
    account_id: accountId,
    kpi_key: sanitizeKey(k.label),
    label: k.label,
    value: k.value,
    delta: k.delta || '',
    updated_at: now,
  }));
  await supabaseUpsert('wyze_kpis', dedupeById(kpiRows));
  console.log(`[Wyze BG] KPIs written (${kpiRows.length})`);
}

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'WYZE_WRITE_AGENTS') {
    writeAgents(msg.agents, ACCOUNT_ID)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'WYZE_WRITE_CHAT') {
    writeChatMonitor(msg.chatMonitor, ACCOUNT_ID)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'WYZE_WRITE_KPIS') {
    writeKpis(msg.kpis, ACCOUNT_ID)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
