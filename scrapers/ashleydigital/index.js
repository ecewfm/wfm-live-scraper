// File: scrapers/ashleydigital/index.js
// Assembled (assembledhq.com) WFM API integration — a plain authenticated
// REST API, NOT a browser scrape like every other account in this codebase.
// `page`/`context` (Playwright) are accepted for signature compatibility
// with account-runner.js's generic runner but are never touched — no
// browser interaction happens here at all, only fetch() calls.
//
// CONFIRMED live (see chat history — real probe calls against this exact
// account, response shapes below are not guessed):
//
// AUTH: HTTP Basic, api key as the username, empty password. Base URL
// https://api.assembledhq.com/v0. Rate limit 300 req/min (5/s, bursts to 20).
//
// GET /people?limit=&offset=  → { people, teams, sites, queues, skills,
//   total, limit, offset } — a bundled response; `people`/`teams`/`sites`/
//   `skills` are each an OBJECT keyed by id, not an array. One person:
//   { id, agent_id, first_name, last_name, email, timezone, imported_id,
//     role, roles[], agent_role, channels[], site, teams[], queues[],
//     skills[], platforms: {<platform>: <platform's own id for this
//     person>}, start_date, end_date, created_at, deleted, staffable,
//     productivity }. NOTE: `id` is the PERSON id — the per-agent state
//     endpoint below wants `agent_id` instead, a DIFFERENT id.
//
// GET /queues → { queues: {<id>: {id, name, parent_id, created_at,
//   updated_at}} } — a tree via parent_id (LOB groupings).
//
// GET /activity_types → { activity_types: {<id>: {id, import_id, name,
//   short_name, value, channels[], queue_external_ids, productive,
//   timeoff, background_color, font_color, timeoff_unit}} }.
//
// GET /agents/state/condensed_timeline?start_time=&end_time=&priority_order=
//   → { agent_states: [{ agent_id, agent_name, agent_email, platform,
//   agent_platform_id, state, start_time, end_time, modified_at,
//   external_id, ticket_id, ticket_status }] } — ONE merged row per agent
//   (whichever platform wins per priority_order, comma-separated, earlier =
//   higher priority) — REQUIRED param, 400s without it ("Missing required
//   field priority_order"). This account's real platforms (confirmed via
//   live data): five9, intercom, slack, api — see PRIORITY_ORDER below for
//   the default ordering (configurable via account.priorityOrder).
//
// GET /agents/states/:agent_id?start_time=&end_time= → { agent_id,
//   agent_states: [{ agent_platform_id, platform, start_time, end_time,
//   state, modified_at, external_id }] } — RAW, un-merged, one row per
//   platform for ONE agent (this is the screenshot's "GET /agents/state —
//   raw aux states, one row per platform"; the real endpoint needs a
//   per-agent id, there is no single bulk call for everyone). Fetching this
//   for all ~255 people every tick would be 255 calls/tick — instead this
//   rotates through the roster in small batches each tick (see
//   RAW_STATE_BATCH_SIZE) so combined with the other calls it stays
//   comfortably under the 300/min rate limit while still refreshing every
//   agent's raw multi-platform detail every few minutes.
//
// GET /activities?start_time=&end_time= → { activities: {<id_with_
//   timestamps>: { id, agent_id, type_id, start_time, end_time,
//   description, created_at, updated_at, id_with_timestamps }} } — schedule
//   occurrences; `id` can recur across occurrences, `id_with_timestamps` is
//   the real unique key. Default window: yesterday through 7 days ahead
//   (covers "what's happening now" plus near-term schedule visibility).
//
// config.json entry needed:
//   {
//     "id": "ashleydigital",
//     "type": "assembled",
//     "apiKey": "sk_live_...",
//     "priorityOrder": "five9,intercom,slack,api"   // optional, this is the default
//   }
//
// Supabase tables needed — see sql/ashleydigital.sql (run once):
//   ashleydigital_people          — roster
//   ashleydigital_queues          — queue tree
//   ashleydigital_teams           — team tree (from /people's bundled data)
//   ashleydigital_sites           — site tree (from /people's bundled data)
//   ashleydigital_skills          — skill tree (from /people's bundled data)
//   ashleydigital_activity_types  — activity type catalog
//   ashleydigital_agent_state     — one row per agent, CURRENT merged status
//   ashleydigital_agent_state_raw — one row per (agent, platform), raw status
//   ashleydigital_activities      — schedule occurrences
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY

const ASSEMBLED_BASE = 'https://api.assembledhq.com/v0'
const DEFAULT_PRIORITY_ORDER = 'five9,intercom,slack,api'
const RAW_STATE_BATCH_SIZE = 15 // agents per tick — see file header's rate-limit reasoning

// Roster/reference data (people, teams, sites, skills, queues, activity
// types) and schedule occurrences (/activities) barely change tick to tick
// — confirmed live: /activities alone returned 5,737 rows for an 8-day
// window across 255 people. Rewriting all of that every 30s would be pure
// waste (API calls, Supabase writes, bandwidth) for data that isn't
// actually "live" in the way agent status is. Both are cached and only
// really re-fetched on their own slower cadence; the condensed
// agent-state timeline (the actual "who's doing what right now" signal)
// and the raw per-agent rotation still run every tick, uncached.
const REFERENCE_REFRESH_MS = 5 * 60 * 1000
const ACTIVITIES_REFRESH_MS = 15 * 60 * 1000
const _referenceCache = new Map()  // accountId -> { data, fetchedAt }
const _activitiesCache = new Map() // accountId -> { data, fetchedAt }

async function supabaseUpsert(table, rows) {
  if (!rows || rows.length === 0) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Supabase ${table} error: ${res.status} ${txt.substring(0, 120)}`)
  }
}

function dedupeById(rows) {
  const map = new Map()
  rows.forEach(r => map.set(r.id, r))
  return [...map.values()]
}

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

// ── Assembled API client ─────────────────────────────────────────────────────
function authHeader(account) {
  return 'Basic ' + Buffer.from(account.apiKey + ':').toString('base64')
}

async function assembledGet(account, path) {
  const res = await fetch(`${ASSEMBLED_BASE}${path}`, { headers: { Authorization: authHeader(account) } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Assembled ${path} -> ${res.status}: ${text.substring(0, 200)}`)
  }
  return res.json()
}

// ── Batched rotation cursor for the per-agent raw-state endpoint ───────────
// Persists across ticks (module-level, keyed by account id) — see file
// header's rate-limit reasoning for why this doesn't just fetch everyone
// every tick.
const _rawStateCursor = new Map() // accountId -> index into the roster array

// ── Write to Supabase ──────────────────────────────────────────────────────
// NOTE on `?? null` everywhere below: PostgREST's bulk insert requires every
// object in the array to have the EXACT same set of keys ("All object keys
// must match", PGRST102) — a plain JS `undefined` field (as opposed to
// `null`) gets silently DROPPED by JSON.stringify, so any row missing an
// optional field entirely breaks the whole batch. Confirmed live: this
// tripped on real /people data where not every person has every field.
async function writePeople(people, accountId) {
  if (!people || people.length === 0) return
  const now = new Date().toISOString()
  const rows = people.map(p => ({
    id:            `${accountId}:${p.id}`,
    account_id:    accountId,
    person_id:     p.id ?? null,
    agent_id:      p.agent_id ?? null,
    first_name:    p.first_name ?? null,
    last_name:     p.last_name ?? null,
    email:         p.email ?? null,
    timezone:      p.timezone ?? null,
    role:          p.role ?? null,
    agent_role:    p.agent_role ?? null,
    channels:      p.channels || [],
    site_id:       p.site ?? null,
    teams:         p.teams || [],
    queues:        p.queues || [],
    skills:        p.skills || [],
    platforms:     p.platforms || {},
    start_date:    p.start_date ?? null,
    end_date:      p.end_date ?? null,
    staffable:     p.staffable ?? null,
    deleted:       p.deleted ?? null,
    updated_at:    now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('ashleydigital_people', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('ashleydigital_people', deduped)
  console.log(`[ashleydigital] ✅ People written (${deduped.length})`)
}

async function writeTree(table, treeObj, accountId) {
  const entries = Object.values(treeObj || {})
  if (entries.length === 0) return
  const now = new Date().toISOString()
  const rows = entries.map(t => ({
    id:         `${accountId}:${t.id}`,
    account_id: accountId,
    item_id:    t.id ?? null,
    name:       t.name ?? null,
    parent_id:  t.parent_id ?? null,
    updated_at: now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted(table, accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert(table, deduped)
  console.log(`[ashleydigital] ✅ ${table} written (${deduped.length})`)
}

async function writeActivityTypes(activityTypes, accountId) {
  const entries = Object.values(activityTypes || {})
  if (entries.length === 0) return
  const now = new Date().toISOString()
  const rows = entries.map(t => ({
    id:                `${accountId}:${t.id}`,
    account_id:        accountId,
    type_id:           t.id ?? null,
    name:              t.name ?? null,
    short_name:        t.short_name ?? null,
    value:             t.value ?? null,
    channels:          t.channels || [],
    productive:        t.productive ?? null,
    timeoff:           t.timeoff ?? null,
    background_color:  t.background_color ?? null,
    font_color:        t.font_color ?? null,
    timeoff_unit:      t.timeoff_unit ?? null,
    updated_at:        now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('ashleydigital_activity_types', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('ashleydigital_activity_types', deduped)
  console.log(`[ashleydigital] ✅ Activity types written (${deduped.length})`)
}

async function writeAgentState(agentStates, accountId) {
  if (!agentStates || agentStates.length === 0) return
  const now = new Date().toISOString()
  // condensed_timeline can return MULTIPLE time-segments per agent within
  // the query window (not just their current status) — confirmed live: 20
  // raw records collapsed to only 4 unique agent_ids. dedupeById's
  // Map.set() keeps whichever row is LAST for a given id, so sort ascending
  // by end_time (earliest first) here to guarantee the truly most-recent
  // segment is the one that ends up processed last and wins, rather than
  // relying on the API's own array ordering.
  const sorted = [...agentStates].sort((a, b) => (a.end_time ?? 0) - (b.end_time ?? 0) || (a.modified_at ?? 0) - (b.modified_at ?? 0))
  const rows = sorted.map(s => ({
    id:               `${accountId}:${s.agent_id}`,
    account_id:       accountId,
    agent_id:         s.agent_id ?? null,
    agent_name:       s.agent_name ?? null,
    agent_email:      s.agent_email ?? null,
    platform:         s.platform ?? null,
    agent_platform_id: s.agent_platform_id ?? null,
    state:            s.state ?? null,
    start_time:       s.start_time ?? null,
    end_time:         s.end_time ?? null,
    modified_at:      s.modified_at ?? null,
    external_id:      s.external_id ?? null,
    ticket_id:        s.ticket_id ?? null,
    ticket_status:    s.ticket_status ?? null,
    updated_at:       now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('ashleydigital_agent_state', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('ashleydigital_agent_state', deduped)
  console.log(`[ashleydigital] ✅ Agent state (condensed) written (${deduped.length})`)
}

async function writeAgentStateRaw(rawByAgent, accountId) {
  const rows = []
  const now = new Date().toISOString()
  Object.entries(rawByAgent).forEach(([agentId, states]) => {
    states.forEach(s => {
      rows.push({
        id:                `${accountId}:${agentId}:${s.platform}`,
        account_id:        accountId,
        agent_id:          agentId,
        platform:          s.platform ?? null,
        agent_platform_id: s.agent_platform_id ?? null,
        state:             s.state ?? null,
        start_time:        s.start_time ?? null,
        end_time:          s.end_time ?? null,
        modified_at:       s.modified_at ?? null,
        external_id:       s.external_id ?? null,
        updated_at:        now,
      })
    })
  })
  if (rows.length === 0) return
  // No pruneDeparted here — this is a ROTATING batch (only a subset of
  // agents refreshed per tick, see RAW_STATE_BATCH_SIZE), so "not present
  // this tick" just means "not this batch's turn", not "departed". Rows
  // are simply overwritten in place whenever an agent's batch comes up.
  await supabaseUpsert('ashleydigital_agent_state_raw', dedupeById(rows))
  console.log(`[ashleydigital] ✅ Raw agent state written (${rows.length} record(s) across ${Object.keys(rawByAgent).length} agent(s))`)
}

async function writeActivities(activities, accountId) {
  if (!activities || activities.length === 0) return
  const now = new Date().toISOString()
  const rows = activities.map(a => ({
    id:                 `${accountId}:${a.id_with_timestamps}`,
    account_id:         accountId,
    activity_id:        a.id ?? null,
    agent_id:           a.agent_id ?? null,
    type_id:            a.type_id ?? null,
    start_time:         a.start_time ?? null,
    end_time:           a.end_time ?? null,
    description:        a.description ?? null,
    updated_at:         now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('ashleydigital_activities', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('ashleydigital_activities', deduped)
  console.log(`[ashleydigital] ✅ Activities written (${deduped.length})`)
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:     'assembled',
    interval: 30000,
  },

  // ── Login: no-op — this is a plain REST API integration, no browser
  // session at all. `page`/`context` are accepted (account-runner.js's
  // generic runner always launches a browser and calls this signature) but
  // never touched.
  async login(page, context, account, sessionPath) {
    if (!account.apiKey) {
      console.warn('[ashleydigital] No apiKey set in config.json — every scrape will fail until it is added')
    }
  },

  // ── Session-expiry check — an API key doesn't "expire" the way a browser
  // session does, so this always reports "not expired". A truly invalid/
  // revoked key just surfaces as a 401 inside scrape(), logged and treated
  // as an empty scrape (same recovery path as everything else).
  isSessionExpired(page) {
    return false
  },

  // ── Scrape ───────────────────────────────────────────────────────────────
  async scrape(page, account) {
    if (!account.apiKey) return { hasData: false }

    const now = Math.floor(Date.now() / 1000)
    const oneDayAgo = now - 86400
    const sevenDaysAhead = now + 7 * 86400
    const priorityOrder = account.priorityOrder || DEFAULT_PRIORITY_ORDER

    let condensed

    // ── Reference data — cached, refreshed every REFERENCE_REFRESH_MS ────────
    let peopleResp, activityTypesResp
    const refCached = _referenceCache.get(account.id)
    if (refCached && Date.now() - refCached.fetchedAt < REFERENCE_REFRESH_MS) {
      ({ peopleResp, activityTypesResp } = refCached.data)
    } else {
      try {
        // /people is paginated (confirmed live: 255 people total) — page
        // through it fully rather than assuming a single call covers
        // everyone.
        let allPeople = []
        let teams = {}, sites = {}, queues = {}, skills = {}
        let offset = 0
        const pageSize = 100
        while (true) {
          const p = await assembledGet(account, `/people?limit=${pageSize}&offset=${offset}`)
          teams = { ...teams, ...p.teams }
          sites = { ...sites, ...p.sites }
          queues = { ...queues, ...p.queues }
          skills = { ...skills, ...p.skills }
          const pagePeople = Object.values(p.people || {})
          allPeople.push(...pagePeople)
          if (pagePeople.length < pageSize || allPeople.length >= (p.total || allPeople.length)) break
          offset += pageSize
        }
        peopleResp = { people: allPeople, teams, sites, queues, skills }
      } catch (err) {
        console.warn(`[ashleydigital] /people fetch failed: ${err.message}`)
        peopleResp = refCached?.data?.peopleResp
      }

      try {
        activityTypesResp = await assembledGet(account, '/activity_types')
      } catch (err) {
        console.warn(`[ashleydigital] /activity_types fetch failed: ${err.message}`)
        activityTypesResp = refCached?.data?.activityTypesResp
      }

      _referenceCache.set(account.id, { data: { peopleResp, activityTypesResp }, fetchedAt: Date.now() })
    }

    try {
      condensed = await assembledGet(account, `/agents/state/condensed_timeline?start_time=${oneDayAgo}&end_time=${now}&priority_order=${encodeURIComponent(priorityOrder)}`)
    } catch (err) {
      console.warn(`[ashleydigital] condensed_timeline fetch failed: ${err.message}`)
    }

    // ── Schedule occurrences — cached, refreshed every ACTIVITIES_REFRESH_MS
    let activitiesResp
    const actCached = _activitiesCache.get(account.id)
    if (actCached && Date.now() - actCached.fetchedAt < ACTIVITIES_REFRESH_MS) {
      activitiesResp = actCached.data
    } else {
      try {
        activitiesResp = await assembledGet(account, `/activities?start_time=${oneDayAgo}&end_time=${sevenDaysAhead}`)
        _activitiesCache.set(account.id, { data: activitiesResp, fetchedAt: Date.now() })
      } catch (err) {
        console.warn(`[ashleydigital] /activities fetch failed: ${err.message}`)
        activitiesResp = actCached?.data
      }
    }

    // Rotating batch of raw per-agent multi-platform states — see file
    // header/RAW_STATE_BATCH_SIZE for the rate-limit reasoning.
    let rawByAgent = {}
    if (peopleResp && peopleResp.people.length > 0) {
      const roster = peopleResp.people.filter(p => p.agent_id)
      let cursor = _rawStateCursor.get(account.id) || 0
      const batch = []
      for (let i = 0; i < RAW_STATE_BATCH_SIZE && roster.length > 0; i++) {
        batch.push(roster[cursor % roster.length])
        cursor++
      }
      _rawStateCursor.set(account.id, cursor % roster.length)

      for (const person of batch) {
        try {
          const r = await assembledGet(account, `/agents/states/${person.agent_id}?start_time=${oneDayAgo}&end_time=${now}`)
          rawByAgent[person.agent_id] = r.agent_states || []
        } catch (err) {
          console.warn(`[ashleydigital] raw state fetch failed for ${person.agent_id}: ${err.message}`)
        }
      }
    }

    const hasData = !!(
      (peopleResp && peopleResp.people.length > 0) ||
      (condensed && condensed.agent_states && condensed.agent_states.length > 0)
    )
    if (!hasData) return { hasData: false }

    return {
      hasData: true,
      people: peopleResp?.people || [],
      teams: peopleResp?.teams || {},
      sites: peopleResp?.sites || {},
      skills: peopleResp?.skills || {},
      queuesFromPeople: peopleResp?.queues || {},
      activityTypes: activityTypesResp?.activity_types || {},
      agentStates: condensed?.agent_states || [],
      rawByAgent,
      activities: Object.values(activitiesResp?.activities || {}),
      snapshotTime: new Date().toISOString(),
    }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writePeople(data.people, accountId).catch(err => console.warn(`[ashleydigital] people write failed: ${err.message}`))
    await writeTree('ashleydigital_teams', data.teams, accountId).catch(err => console.warn(`[ashleydigital] teams write failed: ${err.message}`))
    await writeTree('ashleydigital_sites', data.sites, accountId).catch(err => console.warn(`[ashleydigital] sites write failed: ${err.message}`))
    await writeTree('ashleydigital_skills', data.skills, accountId).catch(err => console.warn(`[ashleydigital] skills write failed: ${err.message}`))
    await writeTree('ashleydigital_queues', data.queuesFromPeople, accountId).catch(err => console.warn(`[ashleydigital] queues write failed: ${err.message}`))
    await writeActivityTypes(data.activityTypes, accountId).catch(err => console.warn(`[ashleydigital] activity_types write failed: ${err.message}`))
    await writeAgentState(data.agentStates, accountId).catch(err => console.warn(`[ashleydigital] agent_state write failed: ${err.message}`))
    await writeAgentStateRaw(data.rawByAgent, accountId).catch(err => console.warn(`[ashleydigital] agent_state_raw write failed: ${err.message}`))
    await writeActivities(data.activities, accountId).catch(err => console.warn(`[ashleydigital] activities write failed: ${err.message}`))
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const states = data.agentStates || []
    const online = states.filter(s => !/logged out|offline/i.test(s.state || '')).length
    return {
      sla:     '--',
      waiting: '0',
      agents:  String(states.length),
      info:    `${online}/${states.length} agent(s) active, ${(data.people || []).length} in roster, ${(data.activities || []).length} activities`,
    }
  },
}
