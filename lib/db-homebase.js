// lib/db-homebase.js
// Writes Homebase (Talkdesk) scraped data to Supabase.
// Four tables: homebase_global_kpis, homebase_queue_stats,
// homebase_agent_states, homebase_active_contacts — see sql/homebase.sql.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY

async function supabaseUpsert(table, rows) {
  if (!rows || (Array.isArray(rows) && rows.length === 0)) return
  const payload = Array.isArray(rows) ? rows : [rows]
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates'
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase upsert [${table}] ${res.status}: ${text}`)
  }
}

// ── Departure detection (agents + queues) — same pattern as db-talkdesk.js:
// upsert alone never removes a row, so an agent/queue no longer present in
// the current scrape would otherwise be left frozen in Supabase forever. ────
const _lastSeenIds = new Map() // table -> Set<id>

async function fetchExistingIds(table, accountId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?account_id=eq.${encodeURIComponent(accountId)}&select=id`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    })
    if (!res.ok) return new Set()
    const rows = await res.json()
    return new Set(rows.map(r => r.id))
  } catch (e) {
    return new Set()
  }
}

async function pruneDeparted(table, accountId, currentIds) {
  if (!_lastSeenIds.has(table)) {
    const existing = await fetchExistingIds(table, accountId)
    _lastSeenIds.set(table, existing)
    return
  }
  const prevIds = _lastSeenIds.get(table)
  const departed = [...prevIds].filter(id => !currentIds.has(id))
  if (departed.length > 0) {
    const filterValue = `(${departed.map(id => `"${String(id).replace(/"/g, '\\"')}"`).join(',')})`
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=in.${encodeURIComponent(filterValue)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[prune] delete failed for ${table}: ${res.status} ${text.substring(0, 120)}`)
    } else {
      console.log(`[prune] ${table}: removed ${departed.length} departed row(s)`)
    }
  }
  _lastSeenIds.set(table, currentIds)
}

// ── Replace-all (Contacts List — inherently transient, like wfm_active_calls) ─
async function supabaseReplaceAll(table, accountId, rows) {
  const delRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?account_id=eq.${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  })
  if (!delRes.ok) {
    const text = await delRes.text()
    throw new Error(`Supabase delete [${table}] failed ${delRes.status}: ${text}`)
  }
  if (rows && rows.length > 0) await supabaseUpsert(table, rows)
}

async function writeHomebaseSnapshot(scraped, accountId) {
  const now = new Date().toISOString()

  // ── 1. Global KPIs (single row) ─────────────────────────────────────────────
  await supabaseUpsert('homebase_global_kpis', {
    id:                          accountId,
    account_id:                  accountId,
    contacts_in_queue:           scraped.contactsInQueue           || null,
    contacts_in_queue_threshold: scraped.contactsInQueueThreshold  || null,
    service_level:               scraped.serviceLevel              || null,
    abandon_rate:                scraped.abandonRate               || null,
    longest_wait_time:           scraped.longestWaitTime           || null,
    updated_at:                  now
  })

  // ── 2. Per-queue stats — merge Live Contacts In Queue + Longest Wait Time,
  // both keyed by the same queue name ──────────────────────────────────────────
  const queueMap = new Map()
  ;(scraped.liveContactsInQueue || []).forEach(({ queue, value }) => {
    queueMap.set(queue, { ...(queueMap.get(queue) || {}), contacts_in_queue: value })
  })
  ;(scraped.longestWaitByQueue || []).forEach(({ queue, value }) => {
    queueMap.set(queue, { ...(queueMap.get(queue) || {}), longest_wait_time: value })
  })
  if (queueMap.size > 0) {
    const queueRows = [...queueMap.entries()].map(([queue, vals]) => ({
      id:                `${accountId}:${queue}`,
      account_id:        accountId,
      queue_name:        queue,
      contacts_in_queue: vals.contacts_in_queue || null,
      longest_wait_time: vals.longest_wait_time || null,
      updated_at:        now
    }))
    await pruneDeparted('homebase_queue_stats', accountId, new Set(queueRows.map(r => r.id)))
    await supabaseUpsert('homebase_queue_stats', queueRows)
  }

  // ── 3. Agent states ──────────────────────────────────────────────────────────
  if (scraped.agents && scraped.agents.length > 0) {
    const agentRows = scraped.agents.map(a => ({
      id:             `${accountId}:${a.name}`,
      account_id:     accountId,
      agent_name:     a.name,
      queues:         Array.isArray(a.queues) ? a.queues.join(', ') : (a.queues || null),
      status:         a.status        || null,
      channels:       a.channels      || null,
      occupancy:      a.occupancy     || null,
      time_in_status: a.timeInStatus  || null,
      updated_at:     now
    }))
    await pruneDeparted('homebase_agent_states', accountId, new Set(agentRows.map(r => r.id)))
    await supabaseUpsert('homebase_agent_states', agentRows)
  }

  // ── 4. Live contacts list (replaced in full each cycle) ───────────────────────
  const contactRows = (scraped.contacts || []).map((c, idx) => ({
    id:           `${accountId}:${idx}`,
    account_id:   accountId,
    status:       c.status      || null,
    agent:        c.agent       || null,
    contact_info: c.contactInfo || null,
    queues:       c.queues      || null,
    live_queues:  c.liveQueues  || null,
    duration:     c.duration    || null,
    hold_time:    c.holdTime    || null,
    callback:     c.callback    || null,
    updated_at:   now
  }))
  await supabaseReplaceAll('homebase_active_contacts', accountId, contactRows)
}

module.exports = { writeHomebaseSnapshot }
