// File: scrapers/guardianbikes/index.js
// Gorgias helpdesk scraper for the Guardian Bikes account (guardian.gorgias.com).
//
// THREE data sources for this account — all three implemented:
//   1. Live overview  (/app/stats/live-overview) — DONE, see below.
//   2. Live agents     (/app/stats/live-agents)   — DONE, see below.
//   3. Live voice      (/app/stats/live-voice)     — DONE, see below.
//
// GORGIAS ITSELF: confirmed via public research — a React + Redux + TypeScript
// SPA (see scrapers/guardianbikes/PROGRESS.md for sources). Its "live" pages
// push updates over Ably (a hosted realtime pub/sub service) rather than
// polling a REST endpoint — confirmed live: the only same-origin request seen
// on page load is a one-time `GET /third-party/auth/realtime` that returns a
// short-lived Ably JWT, after which updates arrive over a WebSocket straight
// to Ably's own servers, never touching guardian.gorgias.com again. We do NOT
// reimplement any of that — Playwright already holds a real logged-in browser
// session, so the actual Gorgias React app does all of that work for us in
// the background exactly like it would for a human, and this scraper simply
// reads whatever it has already rendered, on our own schedule. Unlike Flex,
// this is entirely same-origin (no cross-origin iframes/embedded BI tool), so
// there is only ever one Playwright Page for the whole account, kept open and
// re-read every tick — no re-navigation needed, since the page keeps itself
// live-updated on its own.
//
// LIVE OVERVIEW PAGE — confirmed via live DOM probing:
//
// (a) Four "key metric" stat cards ("Agents online", "Agents offline",
// "Assigned open tickets", "Unassigned open tickets") — plain CSS-modules
// components, NOT a table. Each card is a wrapper element whose class name
// contains "KeyMetricCellWrapper--metric-" (the trailing hash is a build-time
// CSS-modules suffix that can change on any Gorgias redeploy — matched with
// [class*=] rather than an exact class, same reasoning as every other
// hashed-classname scrape in this codebase). Inside each wrapper: one element
// whose class contains "KeyMetricCell--label--" (e.g. "Agents online") and
// one whose class contains "KeyMetricCell--value--" (e.g. "19").
//
// (b) "Support Volume" chart — confirmed via live testing to be Chart.js
// rendered on a plain <canvas role="img">, NOT an SVG (unlike Flex's donut
// tiles) — a canvas has zero real per-point DOM elements, so there is nothing
// to click/hover the way Flex's arc segments were read. Instead, since this
// is confirmed to be react-chartjs-2 (the standard React wrapper for
// Chart.js), the exact underlying {labels, datasets} data is reachable
// directly from the DOM node's React fiber — CONFIRMED via live testing:
// walking the canvas's __reactFiber$* internal reference up its `.return`
// chain finds an ancestor component (a handful of hops up) whose
// `memoizedProps` holds `data: { labels: [<hourly unix-second timestamps>],
// datasets: [{ label: "Ticket created"|"Ticket replied"|"Ticket closed",
// data: [<count per hour>] }] }` — i.e. the EXACT chart data, no pixel-reading
// or hover-tooltip simulation needed at all (a much more reliable technique
// than Flex's donut-hover approach, on the rare page shape where it's
// available — window.Chart itself is NOT exposed globally, this only works
// via the React fiber, so getChartDataFromCanvas() below is written
// generically to find whichever ancestor prop looks chart-shaped, rather than
// assuming a fixed hop count, in case that shifts on a future Gorgias
// redeploy).
//
// LIVE AGENTS PAGE — confirmed via live DOM probing (via a console script this
// time, not the Elements-panel inspector — this page turned out to be a REAL
// semantic <table>, unlike Overview's div-based CSS-modules layout, so a
// straightforward document.querySelector('table') + walking <thead>/<tbody>
// worked reliably where the blind text-search approach had failed on
// Overview). One row per agent, 6 columns in this order: Agent, Online
// status, Availability, Tickets closed, Messages sent, Open tickets.
//
// - Agent name: [class*="TableStat--userName--"].
// - Online status: a generic, reusable "badge" component — [data-name="badge"]
//   — text is "Online"/"Offline".
// - Availability: NOT a plain badge — a react-aria-components <Select>
//   (Available/Unavailable/Lunch break/15 minute break/In a meeting/Special
//   project/Call wrap-up, confirmed live across multiple agents). The
//   CURRENTLY SELECTED value is the only thing scraped — it lives specifically
//   in [class*="AgentAvailabilityStatusSelect--badgeText--"], nested inside a
//   <button data-name="select-trigger">. Deliberately NOT reading the sibling
//   hidden native <select>'s full <option> list (confirmed present alongside
//   it) — that's just the dropdown's static choices, not live data, and
//   reading the whole cell's plain textContent (an early, wrong attempt)
//   concatenates it into noise like "Available▾ AvailableUnavailableLunch
//   break...".
// - Tickets closed / Messages sent: plain numbers, no special markup.
// - Open tickets: EITHER a [class*="TicketDetailsStat--empty--"] div reading
//   "No open tickets assigned to this agent" (confirmed the zero-tickets
//   case), OR a total count ([class*="TicketDetailsStat--openTickets--"] a)
//   plus a per-channel breakdown, one [class*="TicketDetailsStat--channel--"]
//   per channel that has ≥1 open ticket. Each channel's <i class="material-
//   icons ...">'s OWN TEXT is the Material Icons ligature name for that
//   channel (confirmed live: "forum", "live_help", "phone", "email", "sms")
//   — a genuinely convenient way to identify the channel, no icon-shape/color
//   guessing needed — paired with its own count in a sibling <a>.
//
// LIVE VOICE PAGE — confirmed via live DOM probing (a console script, same as
// Live Agents):
//
// (a) 11 KPI cards (Calls in queue, Average wait time, Average talk time, SLA
// Achievement rate, Inbound/Outbound/Unanswered calls, Missed/Cancelled/
// Abandoned calls, Callback requests) — a DIFFERENT component than Overview's
// KeyMetricCell (this one is "MetricCard"/"BigNumberMetric" — confirmed via
// live testing that Overview's [class*="KeyMetricCellWrapper--metric-"]
// selector matches ZERO elements on this page). Selector:
// [data-name="card"][class*="MetricCard--card--"] (this also excludes a
// trailing non-card cell that's just the page's own auto-refresh sync icon).
// Label text is the title div's OWN leading text node (NOT its full
// textContent — the title div also contains a sibling icon-tooltip element
// whose own text, if any, would otherwise get concatenated on). Value is
// read via plain .textContent on the BigNumberMetric wrapper (sometimes a
// bare string like "0", sometimes wrapped in one more span — .textContent
// handles both uniformly). NOTE: 4 of these (Missed/Cancelled/Abandoned
// calls, Callback requests) have a "#" vs "%" display toggle next to them —
// this scraper just reads whatever is CURRENTLY shown (confirmed live:
// percentages), same "read what's rendered" philosophy as everywhere else in
// this file; if someone toggles that account-wide setting to "#" the scraped
// value would switch to a raw count instead, with no code change needed (nor
// possible to prevent, since we don't control that toggle).
//
// (b) "Live calls" table — a REAL <table class="...VoiceCallTable--table--...">
// (distinguished from the Agents-sidebar table below, which shares a more
// generic base table class), one row per CURRENTLY ACTIVE call (not history).
// 7 columns: Activity (direction icon + customer number + "on call with" +
// agent name), Status ("In progress", confirmed live), Time (a badge
// containing a timer icon + duration text, e.g. "05:11" — read via the
// specific inner div, not the badge's whole textContent, to avoid
// concatenating the icon's own "timer" ligature-name text onto the front),
// Integration, Queue, Monitor (a "Listen" action button — not data, skipped),
// and Ticket (a "View ticket" link whose href contains the real ticket ID).
//
// (c) Agents sidebar — THE PLACE FOR "all the statuses": a table (found by
// locating whichever <table> contains a [class*="AgentCard--container--"]
// element, since it shares the same generic base table class as the Live
// Calls table with no more specific class of its own) whose <tbody> rows
// ALTERNATE between two shapes: a "category header" row
// ([class*="LiveVoiceAgentsList--categoryCell--"], text like "Busy (1)",
// "Available (4)", "Unavailable (4)" — CONFIRMED exactly 3 category groups)
// and individual agent rows (an "AgentCard" — confirmed to sit as a direct
// child of the <tr>, NOT wrapped in its own <td>, unusual but real markup
// Gorgias renders and Playwright reads it fine regardless). Deliberately
// NOT hardcoding an exhaustive status list — the per-agent SPECIFIC status
// (more granular than the 3 category groups, e.g. "On a call" within Busy,
// "Available" within Available, "Offline" within Unavailable — confirmed
// live) is read straight from the status dot's OWN aria-label
// ([class*="ui-avatarstatusindicator-dotswrapper-"][aria-label]) every tick,
// the same dynamic-discovery philosophy already used for status vocab
// elsewhere in this codebase (Wyze/Eden) — whatever new status text Gorgias
// ever shows just flows through automatically, no code change needed. The
// dot's data-color attribute (red/green/grey confirmed live) is captured too
// as a cheap extra signal. A description div under the agent's name holds a
// duration/timer string when present (e.g. "04:57" for the one Busy agent
// seen live) and is empty otherwise.
//
// LOGIN: NOT YET CONFIRMED — this account's actual sign-in flow (plain
// email/password vs SSO/2FA) has never been probed, so — same posture as
// every other not-yet-confirmed login in this codebase (see scrapers/flex or
// scrapers/homebase's file headers) — this defaults to manualLogin: true.
// Navigate, wait for a human to log in in the visible browser window, then
// run `resume guardianbikes` in the scraper.js terminal. Revisit once the
// login page itself has been probed.
//
// config.json entry needed:
//   {
//     "id": "guardianbikes",
//     "type": "gorgias",
//     "email": "",
//     "password": "",
//     "dashboardUrl": "https://guardian.gorgias.com/app/stats/live-overview",
//     "agentsUrl": "https://guardian.gorgias.com/app/stats/live-agents",
//     "voiceUrl": "https://guardian.gorgias.com/app/stats/live-voice"
//   }
//
// Supabase tables needed — see sql/guardianbikes.sql (run once):
//   guardianbikes_overview_kpis  — one row (the 4 stat-card values)
//   guardianbikes_ticket_volume  — one row per (hour, metric) chart data point
//   guardianbikes_agents        — one row per agent (Live Agents table)
//   guardianbikes_voice_kpis    — one row (the 11 Live Voice stat-card values)
//   guardianbikes_live_calls    — one row per currently-active call
//   guardianbikes_voice_agents  — one row per agent (Live Voice's Agents sidebar)
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

// ── Supabase write helper (same pattern as edenhealth/hippo/wyze/flex) ─────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY

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

// Postgres rejects the whole upsert batch if the same id appears twice.
function dedupeById(rows) {
  const map = new Map()
  rows.forEach(r => map.set(r.id, r))
  return [...map.values()]
}

// ── Departure detection — remove rows no longer present in the live page
// (an agent removed from the team, a call that ended, a ticket that closed).
// Same seed-then-diff pattern as every other scraper's pruneDeparted — see
// scrapers/flex/index.js for the full reasoning. Generalized across tables
// (guardianbikes_agents, guardianbikes_live_calls) via a Map keyed by table
// name, same approach as flex/index.js's _lastSeenIds.
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

// ── URL helpers ──────────────────────────────────────────────────────────────
// Login flow is unconfirmed (see file header) — deliberately broad, same
// reasoning as scrapers/flex/index.js's isLoginUrl: anywhere other than the
// real app counts as "not logged in" rather than matching one specific login
// path, which could miss an SSO redirect step.
function isLoginUrl(url) {
  return !/guardian\.gorgias\.com\/app\//.test(url || '')
}

// ── Live Overview: 4 stat cards ─────────────────────────────────────────────
// Runs inside page.evaluate(). Class names are CSS-modules hashed suffixes
// (see file header) — matched with [class*=] so a redeploy's new hash doesn't
// silently break this.
function scrapeOverviewStatCards() {
  const wrappers = Array.from(document.querySelectorAll('[class*="KeyMetricCellWrapper--metric-"]'))
  const stats = []
  wrappers.forEach(w => {
    const labelEl = w.querySelector('[class*="KeyMetricCell--label--"]')
    const valueEl = w.querySelector('[class*="KeyMetricCell--value--"]')
    if (!labelEl || !valueEl) return
    // The label cell also contains the little (i) info-icon SVG — that
    // contributes no textContent of its own, but trim defensively anyway.
    const label = labelEl.textContent.trim()
    const value = valueEl.textContent.trim()
    if (label) stats.push({ label, value })
  })
  return stats
}

// ── Live Overview: "Support Volume" chart ───────────────────────────────────
// Runs inside page.evaluate(). See file header for why this reads React
// fiber internals instead of hovering the canvas — CONFIRMED via live
// testing to return the exact underlying {labels, datasets} the chart was
// given, no pixel-reading needed.
function scrapeSupportVolumeChart() {
  function findReactFiberKey(el) {
    return Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  }
  const canvas = document.querySelector('canvas[role="img"]')
  if (!canvas) return null
  const fiberKey = findReactFiberKey(canvas)
  if (!fiberKey) return null

  let fiber = canvas[fiberKey]
  let hops = 0
  while (fiber && hops < 40) {
    const props = fiber.memoizedProps
    if (props && typeof props === 'object') {
      const data = (props.data && (props.data.datasets || Array.isArray(props.data))) ? props.data
        : (props.config && props.config.data) ? props.config.data
        : null
      if (data && Array.isArray(data.datasets) && Array.isArray(data.labels)) {
        return {
          labels: data.labels,
          datasets: data.datasets.map(d => ({ label: d.label, data: d.data })),
        }
      }
    }
    fiber = fiber.return
    hops++
  }
  return null
}

// ── Sanitize a dataset label into a stable metric key for storage, e.g.
// "Ticket created" -> "ticket_created". ─────────────────────────────────────
function sanitizeMetricKey(label) {
  return String(label || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// ── Live Agents: secondary Page, opened once and reused across ticks (same
// pattern as scrapers/flex/index.js's ensureGeckoboardPage/ensureExplorePage)
// — needs the same Gorgias session as the main login page, so only opened
// AFTER that login succeeds. Same reasoning as the main Overview page (see
// file header): kept open and re-read every tick rather than re-navigated,
// since Gorgias keeps this page's own data live-updated on its own.
const AGENTS_PAGES = new Map() // accountId -> Page

async function ensureAgentsPage(context, account) {
  let p = AGENTS_PAGES.get(account.id)
  if (p && !p.isClosed()) return p

  p = await context.newPage()
  AGENTS_PAGES.set(account.id, p)
  p.on('pageerror', () => {})
  p.on('dialog', d => d.dismiss().catch(() => {}))
  await p.goto(account.agentsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[guardianbikes] agents goto failed: ${e.message}`)
  })
  return p
}

// ── Live Agents: the table itself ───────────────────────────────────────────
// Runs inside page.evaluate(). See file header for the full DOM structure
// confirmed via live probing.
function scrapeAgentTable() {
  const table = document.querySelector('table')
  if (!table) return []
  const rows = Array.from(table.querySelectorAll('tbody tr'))

  return rows.map(tr => {
    const tds = Array.from(tr.querySelectorAll('td'))
    if (tds.length < 6) return null

    const agentName    = tds[0].querySelector('[class*="TableStat--userName--"]')?.textContent.trim() || ''
    const onlineStatus = tds[1].querySelector('[data-name="badge"]')?.textContent.trim() || ''
    // The currently-selected availability value only — NOT the hidden native
    // <select>'s full <option> list sitting right next to it (see file header).
    const availability  = tds[2].querySelector('[class*="AgentAvailabilityStatusSelect--badgeText--"]')?.textContent.trim() || ''
    const ticketsClosed = tds[3].textContent.trim()
    const messagesSent  = tds[4].textContent.trim()

    const ticketsCell = tds[5]
    let openTicketsTotal = '0'
    const byChannel = {}
    if (!ticketsCell.querySelector('[class*="TicketDetailsStat--empty--"]')) {
      openTicketsTotal = ticketsCell.querySelector('[class*="TicketDetailsStat--openTickets--"] a')?.textContent.trim() || '0'
      Array.from(ticketsCell.querySelectorAll('[class*="TicketDetailsStat--channel--"]')).forEach(ch => {
        const icon  = ch.querySelector('i')?.textContent.trim()
        const count = ch.querySelector('a')?.textContent.trim()
        if (icon) byChannel[icon] = count
      })
    }

    if (!agentName) return null
    return { agentName, onlineStatus, availability, ticketsClosed, messagesSent, openTicketsTotal, byChannel }
  }).filter(Boolean)
}

function sanitizeAgentKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// ── Write to Supabase ──────────────────────────────────────────────────────
async function writeOverviewKpis(stats, accountId) {
  if (!stats || stats.length === 0) return
  const row = { id: accountId, account_id: accountId, updated_at: new Date().toISOString() }
  stats.forEach(s => { row[sanitizeMetricKey(s.label)] = s.value })
  await supabaseUpsert('guardianbikes_overview_kpis', [row])
  console.log(`[guardianbikes] ✅ Overview KPIs written (${stats.length} stat card(s))`)
}

async function writeTicketVolume(chart, accountId) {
  if (!chart) return
  const now = new Date().toISOString()
  const rows = []
  chart.datasets.forEach(ds => {
    const metric = sanitizeMetricKey(ds.label)
    chart.labels.forEach((hourTs, i) => {
      const value = ds.data[i]
      if (value === undefined || value === null) return
      rows.push({
        id:         `${accountId}:${hourTs}:${metric}`,
        account_id: accountId,
        hour_ts:    hourTs,
        // Human-readable hour label (e.g. "2 AM") computed here rather than
        // in SQL/the dashboard, since hour_ts is a UNIX-seconds timestamp in
        // whatever timezone Gorgias's own chart was built in (the account's
        // configured business-hours timezone, per the "America/New_York"
        // caption on this same page) — new Date() below renders it in
        // THIS MACHINE's local timezone, which may not match; fine for now
        // since the scraper host and this account are both US-based, but
        // worth revisiting if that's ever not true.
        hour_label: new Date(hourTs * 1000).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
        metric,
        metric_label: ds.label,
        value:      String(value),
        updated_at: now,
      })
    })
  })
  if (rows.length === 0) return
  await supabaseUpsert('guardianbikes_ticket_volume', rows)
  console.log(`[guardianbikes] ✅ Ticket volume written (${rows.length} point(s))`)
}

async function writeAgents(agents, accountId) {
  if (!agents || agents.length === 0) return
  const now = new Date().toISOString()
  const rows = agents.map(a => ({
    id:                      `${accountId}:${sanitizeAgentKey(a.agentName)}`,
    account_id:              accountId,
    agent_name:              a.agentName,
    online_status:           a.onlineStatus,
    availability_status:     a.availability,
    tickets_closed:          a.ticketsClosed,
    messages_sent:           a.messagesSent,
    open_tickets_total:      a.openTicketsTotal,
    open_tickets_by_channel: a.byChannel,
    updated_at:              now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('guardianbikes_agents', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('guardianbikes_agents', deduped)
  console.log(`[guardianbikes] ✅ Agents written (${deduped.length})`)
}

async function writeVoiceKpis(stats, accountId) {
  if (!stats || stats.length === 0) return
  const row = { id: accountId, account_id: accountId, updated_at: new Date().toISOString() }
  stats.forEach(s => { row[sanitizeMetricKey(s.label)] = s.value })
  await supabaseUpsert('guardianbikes_voice_kpis', [row])
  console.log(`[guardianbikes] ✅ Voice KPIs written (${stats.length} stat card(s))`)
}

async function writeLiveCalls(calls, accountId) {
  const now = new Date().toISOString()
  const rows = (calls || []).map(c => ({
    // Falls back to a customer+agent+queue composite when there's no ticket
    // ID (shouldn't normally happen per the confirmed shape, but avoids a
    // missing id ever silently dropping a row).
    id:          `${accountId}:call:${c.ticketId || `${c.customer}:${c.agentName}:${c.queue}`.replace(/\s+/g, '_')}`,
    account_id:  accountId,
    ticket_id:   c.ticketId,
    direction:   c.direction,
    customer:    c.customer,
    agent_name:  c.agentName,
    status:      c.status,
    duration:    c.duration,
    integration: c.integration,
    queue:       c.queue,
    updated_at:  now,
  }))
  const deduped = dedupeById(rows)
  // Always prune, even with zero current calls — an empty `calls` array
  // (nobody currently on the phone) is a legitimate, common state, not a
  // failed scrape, and any previously-active call rows need to clear then too.
  await pruneDeparted('guardianbikes_live_calls', accountId, new Set(deduped.map(r => r.id)))
  if (deduped.length === 0) return
  await supabaseUpsert('guardianbikes_live_calls', deduped)
  console.log(`[guardianbikes] ✅ Live calls written (${deduped.length})`)
}

async function writeVoiceAgents(agents, accountId) {
  if (!agents || agents.length === 0) return
  const now = new Date().toISOString()
  const rows = agents.map(a => ({
    id:              `${accountId}:${sanitizeAgentKey(a.name)}`,
    account_id:      accountId,
    agent_name:      a.name,
    category:        a.category,
    status_detail:   a.statusDetail,
    status_color:    a.statusColor,
    description:     a.description,
    updated_at:      now,
  }))
  const deduped = dedupeById(rows)
  await pruneDeparted('guardianbikes_voice_agents', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('guardianbikes_voice_agents', deduped)
  console.log(`[guardianbikes] ✅ Voice agents written (${deduped.length})`)
}

// ── Live Voice: secondary Page — same pattern as ensureAgentsPage above. ────
const VOICE_PAGES = new Map() // accountId -> Page

async function ensureVoicePage(context, account) {
  let p = VOICE_PAGES.get(account.id)
  if (p && !p.isClosed()) return p

  p = await context.newPage()
  VOICE_PAGES.set(account.id, p)
  p.on('pageerror', () => {})
  p.on('dialog', d => d.dismiss().catch(() => {}))
  await p.goto(account.voiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[guardianbikes] voice goto failed: ${e.message}`)
  })
  return p
}

// ── Live Voice: 11 KPI cards ─────────────────────────────────────────────────
// Runs inside page.evaluate(). See file header for why label extraction reads
// only the title div's leading text node instead of its full textContent.
function scrapeVoiceKpis() {
  const cards = Array.from(document.querySelectorAll('[data-name="card"][class*="MetricCard--card--"]'))
  const stats = []
  cards.forEach(card => {
    const titleDiv = card.querySelector('[class*="MetricCard--title--"]')
    const valueEl = card.querySelector('[class*="BigNumberMetric--wrapper--"]')
    if (!titleDiv || !valueEl) return
    const textNode = Array.from(titleDiv.childNodes).find(n => n.nodeType === 3 && n.textContent.trim())
    const label = (textNode ? textNode.textContent : titleDiv.textContent).trim()
    const value = valueEl.textContent.trim()
    if (label) stats.push({ label, value })
  })
  return stats
}

// ── Live Voice: "Live calls" table (currently-active calls only) ───────────
// Runs inside page.evaluate(). See file header for the full DOM structure.
function scrapeLiveCalls() {
  const table = document.querySelector('table[class*="VoiceCallTable--table--"]')
  if (!table) return []
  const rows = Array.from(table.querySelectorAll('tbody tr'))

  return rows.map(tr => {
    const tds = Array.from(tr.querySelectorAll('td'))
    if (tds.length < 7) return null

    const activityCell = tds[0]
    const direction  = activityCell.querySelector('[class*="phoneIcon"]')?.textContent.trim() || ''
    const customer    = activityCell.querySelector('[class*="customerLabel"]')?.textContent.trim() || ''
    const agentName   = activityCell.querySelector('[class*="labels--name--"]')?.textContent.trim() || ''
    const status       = tds[1].querySelector('[class*="LiveVoiceCallStatusLabel--status--"]')?.textContent.trim() || tds[1].textContent.trim()
    // The timer BADGE's own text also includes its icon's ligature name
    // ("timer") — read the inner duration div specifically to avoid
    // concatenating that onto the front, e.g. "timer05:11".
    const duration     = tds[2].querySelector('[class*="VoiceCallTimerBadge--badge--"] div')?.textContent.trim() || tds[2].textContent.trim()
    const integration   = tds[3].textContent.trim()
    const queue         = tds[4].textContent.trim()
    const ticketHref   = tds[6].querySelector('a')?.getAttribute('href') || ''
    const ticketId     = (ticketHref.match(/\/app\/ticket\/(\d+)/) || [])[1] || ''

    if (!ticketId && !customer) return null
    return { direction, customer, agentName, status, duration, integration, queue, ticketId }
  }).filter(Boolean)
}

// ── Live Voice: Agents sidebar (Busy/Available/Unavailable) ────────────────
// Runs inside page.evaluate(). See file header for the full DOM structure and
// why per-agent status is read dynamically (aria-label) rather than from a
// hardcoded list.
function scrapeVoiceAgents() {
  const table = Array.from(document.querySelectorAll('table')).find(t => t.querySelector('[class*="AgentCard--container--"]'))
  if (!table) return []
  const rows = Array.from(table.querySelectorAll('tbody tr'))

  let currentCategory = ''
  const agents = []
  rows.forEach(tr => {
    const categoryEl = tr.querySelector('[class*="LiveVoiceAgentsList--categoryCell--"]')
    if (categoryEl) {
      // Strip the trailing "(N)" count — that's a page-computed total, not a
      // per-agent field, and would go stale the instant it's stored anyway.
      currentCategory = categoryEl.textContent.replace(/\s*\(\d+\)\s*$/, '').trim()
      return
    }
    const card = tr.querySelector('[class*="AgentCard--container--"]')
    if (!card) return
    const name = card.querySelector('[class*="AgentCard--name--"]')?.textContent.trim() || ''
    if (!name) return
    const description = card.querySelector('[class*="AgentCard--description--"]')?.textContent.trim() || ''
    const indicator = card.querySelector('[class*="ui-avatarstatusindicator-dotswrapper-"]')
    const statusDetail = indicator?.getAttribute('aria-label') || ''
    const statusColor  = indicator?.querySelector('[data-name="dot"]')?.getAttribute('data-color') || ''
    agents.push({ category: currentCategory, name, statusDetail, statusColor, description })
  })
  return agents
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:        'gorgias',
    interval:    30000,
    manualLogin: true,   // Login flow unconfirmed — see file header. Waits for `resume guardianbikes`
  },

  // ── Login: navigate and check. Real sign-in flow (plain form vs SSO/2FA)
  // has never been probed for this account, so — same posture as every other
  // not-yet-confirmed login in this codebase — no credential attempt is made
  // here at all. If the persisted session is still valid this lands straight
  // on Live Overview; otherwise it just waits for a human.
  async login(page, context, account, sessionPath) {
    page.on('pageerror', err => console.warn(`[guardianbikes page error] ${err.message}`))
    page.on('dialog', d => d.dismiss().catch(() => {})) // defensive — see scrapers/flex/index.js's identical comment for why

    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[guardianbikes] goto failed: ${e.message}`)
    })
    await page.waitForTimeout(1500)

    if (isLoginUrl(page.url())) {
      console.log('[guardianbikes] Not authenticated — manual login required. Waiting for human (resume guardianbikes once done)...')
      return
    }

    if (account.agentsUrl) {
      await ensureAgentsPage(context, account)
    } else {
      console.log('[guardianbikes] No agentsUrl configured — skipping Live Agents until it is set in config.json')
    }

    if (account.voiceUrl) {
      await ensureVoicePage(context, account)
    } else {
      console.log('[guardianbikes] No voiceUrl configured — skipping Live Voice until it is set in config.json')
    }
  },

  // ── Session-expiry check ─────────────────────────────────────────────────────
  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  // ── Scrape: read whatever the (already live-updating, same page kept open
  // the whole time) Live Overview page has rendered. No re-navigation needed
  // — see file header for why this page keeps itself fresh on its own. ───────
  async scrape(page, account) {
    if (isLoginUrl(page.url())) return { hasData: false }

    let stats = []
    try {
      stats = await page.evaluate(scrapeOverviewStatCards)
    } catch (err) {
      console.warn(`[guardianbikes] stat card scrape failed: ${err.message}`)
    }

    let chart = null
    try {
      chart = await page.evaluate(scrapeSupportVolumeChart)
    } catch (err) {
      console.warn(`[guardianbikes] chart scrape failed: ${err.message}`)
    }

    let agents = []
    if (account.agentsUrl) {
      try {
        const agentsPage = await ensureAgentsPage(page.context(), account)
        agents = await agentsPage.evaluate(scrapeAgentTable)
      } catch (err) {
        console.warn(`[guardianbikes] agents scrape failed: ${err.message}`)
      }
    }

    let voiceStats = []
    let liveCalls = []
    let voiceAgents = []
    if (account.voiceUrl) {
      try {
        const voicePage = await ensureVoicePage(page.context(), account)
        voiceStats = await voicePage.evaluate(scrapeVoiceKpis)
        liveCalls = await voicePage.evaluate(scrapeLiveCalls)
        voiceAgents = await voicePage.evaluate(scrapeVoiceAgents)
      } catch (err) {
        console.warn(`[guardianbikes] voice scrape failed: ${err.message}`)
      }
    }

    if (stats.length === 0 && !chart && agents.length === 0 && voiceStats.length === 0 && voiceAgents.length === 0) return { hasData: false }
    return {
      hasData: true, stats, chart, agents, voiceStats, liveCalls, voiceAgents,
      snapshotTime: new Date().toISOString(),
    }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    // Independent .catch()s — see scrapers/flex/index.js's identical
    // reasoning: one table failing (e.g. sql/guardianbikes.sql not yet run)
    // must not block the others from writing this tick.
    await writeOverviewKpis(data.stats, accountId).catch(err => console.warn(`[guardianbikes] overview_kpis write failed: ${err.message}`))
    await writeTicketVolume(data.chart, accountId).catch(err => console.warn(`[guardianbikes] ticket_volume write failed: ${err.message}`))
    await writeAgents(data.agents, accountId).catch(err => console.warn(`[guardianbikes] agents write failed: ${err.message}`))
    await writeVoiceKpis(data.voiceStats, accountId).catch(err => console.warn(`[guardianbikes] voice_kpis write failed: ${err.message}`))
    await writeLiveCalls(data.liveCalls, accountId).catch(err => console.warn(`[guardianbikes] live_calls write failed: ${err.message}`))
    await writeVoiceAgents(data.voiceAgents, accountId).catch(err => console.warn(`[guardianbikes] voice_agents write failed: ${err.message}`))
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const stat = key => data.stats?.find(s => sanitizeMetricKey(s.label) === key)?.value ?? '--'
    const online  = stat('agents_online')
    const offline = stat('agents_offline')
    const assigned = stat('assigned_open_tickets')
    const unassigned = stat('unassigned_open_tickets')
    const agentRows = data.agents?.length ?? 0
    const activeCalls = data.liveCalls?.length ?? 0
    return {
      sla:     '--',
      waiting: assigned,
      agents:  online,
      info:    `${online} online / ${offline} offline, ${assigned} assigned, ${unassigned} unassigned ticket(s), ${agentRows} agent row(s), ${activeCalls} active call(s)`,
    }
  },
}
