// lib/db.js
// Writes scraped data to Supabase via REST API (no SDK — just fetch).
// Uses upsert (merge-duplicates) on all tables except active_calls,
// which gets a DELETE + INSERT each cycle to avoid stale call rows.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── Generic upsert (POST with Prefer: resolution=merge-duplicates) ────────────
async function supabaseUpsert(table, rows) {
  if (!rows || (Array.isArray(rows) && rows.length === 0)) return;

  const payload = Array.isArray(rows) ? rows : [rows];

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert [${table}] failed ${res.status}: ${text}`);
  }
}

// ── Delete all rows for an account, then insert fresh batch ──────────────────
// Used for active_calls — stale rows from last cycle must be cleared.
async function supabaseReplaceAll(table, accountId, rows) {
  // DELETE
  const delRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?account_id=eq.${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!delRes.ok) {
    const text = await delRes.text();
    throw new Error(`Supabase delete [${table}] failed ${delRes.status}: ${text}`);
  }

  // INSERT (only if we have rows)
  if (rows && rows.length > 0) {
    await supabaseUpsert(table, rows);
  }
}

// ── Main write function ───────────────────────────────────────────────────────
async function writeSnapshot(scraped, accountId) {
  const now = new Date().toISOString();

  // 1. KPI snapshot (one row per account, upserted)
  if (scraped.hasData) {
    const kpiRow = {
      id:         accountId,
      account_id: accountId,
      ...scraped.kpis,
      updated_at: now
    };
    await supabaseUpsert('wfm_kpi_snapshots', kpiRow);
  }

  // 2. Agent states (one row per agent, upserted by composite key)
  if (scraped.agents && scraped.agents.length > 0) {
    const agentRows = scraped.agents.map(a => ({
      id:         `${accountId}:${a.name}`,
      account_id: accountId,
      agent_name: a.name,
      status:     a.status,
      duration:   a.duration,
      updated_at: now
    }));
    await supabaseUpsert('wfm_agent_states', agentRows);
  }

  // 3. User status counts (one row per account, upserted)
  const us = scraped.userStatus || {};
  const statusRow = {
    id:               accountId,
    account_id:       accountId,
    available:        parseInt(us['Available'] || 0),
    ringing:          parseInt(us['Ringing'] || 0),
    in_call:          parseInt(us['In call'] || 0),
    after_call_work:  parseInt(us['After call work'] || 0),
    not_available:    parseInt(us['Not available'] || 0),
    do_not_disturb:   parseInt(us['Do not disturb'] || 0),
    on_a_break:       parseInt(us['On a break'] || 0),
    out_for_lunch:    parseInt(us['Out for lunch'] || 0),
    back_office:      parseInt(us['Back office'] || 0),
    in_training:      parseInt(us['In training'] || 0),
    offline:          parseInt(us['Offline'] || 0),
    updated_at:       now
  };
  await supabaseUpsert('wfm_user_status_counts', statusRow);

  // 4. Active calls (replaced every cycle to avoid stale rows)
  const callRows = (scraped.calls || []).map((c, idx) => ({
    id:         `${accountId}:${idx}`,
    account_id: accountId,
    direction:  c.direction,
    agent:      c.user,
    phone_line: c.number,
    customer:   c.customer,
    status:     c.status,
    started_at: c.started_at,
    updated_at: now
  }));
  await supabaseReplaceAll('wfm_active_calls', accountId, callRows);
}

module.exports = { writeSnapshot };
