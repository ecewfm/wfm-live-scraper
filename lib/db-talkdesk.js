// lib/db-talkdesk.js
// Writes Ashley Phones (Talkdesk) scraped data to Supabase.
// Three tables: talkdesk_lob_kpis, talkdesk_agent_states, talkdesk_status_counts

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

// ── Parse Talkdesk duration "MM:SS" or "HH:MM:SS" → seconds ──────────────────
function parseTDDuration(str) {
  if (!str || str === 'N/A' || str === '-') return 0
  const parts = String(str).trim().split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parseInt(str) || 0
}

async function writeTalkdeskSnapshot(scraped, accountId) {
  const now = new Date().toISOString()

  // ── 1. LOB KPIs ─────────────────────────────────────────────────────────────
  if (scraped.groupKpis && scraped.groupKpis.length > 0) {
    const lobRows = scraped.groupKpis.map(g => ({
      id:               `${accountId}:${g.group}`,
      account_id:       accountId,
      lob_name:         g.group,
      sla:              g.sla             || null,
      aht:              g.aht             || null,
      contacts_in_queue: g.contactsInQueue || null,
      agents_logged_in: parseInt(g.loggedIn?.total)     || 0,
      agents_available: parseInt(g.loggedIn?.available) || 0,
      agents_acw:       parseInt(g.loggedIn?.acw)       || 0,
      agents_busy:      parseInt(g.loggedIn?.busy)      || 0,
      agents_away:      parseInt(g.loggedIn?.away)      || 0,
      updated_at:       now
    }))
    await supabaseUpsert('talkdesk_lob_kpis', lobRows)
    console.log(`[${accountId}] ✅ LOB KPIs written (${lobRows.length} LOBs)`)
  }

  // ── 2. Agent states ──────────────────────────────────────────────────────────
  if (scraped.agents && scraped.agents.length > 0) {
    // Deduplicate by agent name — same agent can appear in multiple scroll passes
    const agentMap = new Map()
    scraped.agents.forEach(a => {
      const id = `${accountId}:${a.name}`
      if (!agentMap.has(id)) {
        agentMap.set(id, {
          id,
          account_id:     accountId,
          agent_name:     a.name,
          status:         a.status         || null,
          duration:       a.timeInStatus   || null,
          duration_secs:  parseTDDuration(a.timeInStatus),
          table_category: a.table          || null,
          queues:         Array.isArray(a.queues) ? a.queues.join(', ') : (a.queues || null),
          updated_at:     now
        })
      }
    })
    const agentRows = [...agentMap.values()]
    await supabaseUpsert('talkdesk_agent_states', agentRows)
    console.log(`[${accountId}] ✅ Agent states written (${agentRows.length} agents)`)
  }

  // ── 3. Status counts ─────────────────────────────────────────────────────────
  const onCall   = (scraped.agents || []).filter(a => /agents on a call/i.test(a.table || ''))
  const nonProd  = (scraped.agents || []).filter(a => /non.prod/i.test(a.table || ''))
  const avail    = (scraped.agents || []).filter(a => /available/i.test(a.table || ''))

  const statusRow = {
    id:              accountId,
    account_id:      accountId,
    total_logged_in: parseInt(scraped.kpis?.['Total Logged-In Agents']) || 0,
    available:       parseInt(scraped.kpis?.['Total Available']) || avail.length,
    acw:             parseInt(scraped.kpis?.['Total ACW'])       || 0,
    busy:            parseInt(scraped.kpis?.['Total Busy'])      || 0,
    on_call:         onCall.length,
    non_prod_aux:    nonProd.length,
    updated_at:      now
  }
  await supabaseUpsert('talkdesk_status_counts', statusRow)
  console.log(`[${accountId}] ✅ Status counts written`)
}

module.exports = { writeTalkdeskSnapshot }