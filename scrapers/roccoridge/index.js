// File: scrapers/roccoridge/index.js
// Gorgias helpdesk scraper for the Rocco Fridge account (roccofridge.gorgias.com).
// NOTE: the account id used throughout this codebase/config is "roccoridge"
// (per explicit instruction), even though the actual Gorgias domain is
// "roccofridge.gorgias.com" — these are deliberately different strings.
//
// Same CRM as scrapers/guardianbikes/index.js (confirmed: identical page
// structure via live screenshots — KeyMetricCell stat cards + Support Volume
// chart on Live Overview, the same 6-column table on Live Agents, the same
// MetricCard KPIs + Live calls table + Agents sidebar on Live Voice) — this
// file is a direct clone of that one with only account-specific naming
// (log tags, Supabase table names, URL-check domain) changed. See
// scrapers/guardianbikes/index.js's file header for the full DOM-structure
// reasoning (CSS-modules hashed classnames, React-fiber chart reading, the
// Material Icons ligature-name channel identification, etc.) — all of it
// applies here unchanged since it's the same Gorgias app.
//
// THREE data sources for this account — all three implemented:
//   1. Live overview  (/app/stats/live-overview)
//   2. Live agents     (/app/stats/live-agents)
//   3. Live voice      (/app/stats/live-voice)
//
// LOGIN: NOT YET CONFIRMED — the login link shared for this account
// (https://roccofridge.gorgias.com/idp/login?...) is an IdP/OAuth redirect
// (client_id/redirect_uri/scope=openid+email+profile), not a plain Gorgias
// email/password form — so unlike scrapers/flex/index.js (where the exact
// manual click-path was described and could be automated), this defaults to
// manualLogin: true, same conservative posture as guardianbikes. Navigate,
// wait for a human to complete the IdP sign-in in the visible browser
// window, then run `resume roccoridge` in the scraper.js terminal. Revisit
// once that flow has actually been observed/described (see how
// scrapers/flex/index.js's attemptGoogleSignIn() was added once its real
// flow was confirmed).
//
// config.json entry needed:
//   {
//     "id": "roccoridge",
//     "type": "gorgias",
//     "email": "",
//     "password": "",
//     "dashboardUrl": "https://roccofridge.gorgias.com/app/stats/live-overview",
//     "agentsUrl": "https://roccofridge.gorgias.com/app/stats/live-agents",
//     "voiceUrl": "https://roccofridge.gorgias.com/app/stats/live-voice"
//   }
//
// Supabase tables needed — see sql/roccoridge.sql (run once):
//   roccoridge_overview_kpis  — one row (the 4 stat-card values)
//   roccoridge_ticket_volume  — one row per (hour, metric) chart data point
//   roccoridge_agents        — one row per agent (Live Agents table)
//   roccoridge_voice_kpis    — one row (the 11 Live Voice stat-card values)
//   roccoridge_live_calls    — one row per currently-active call
//   roccoridge_voice_agents  — one row per agent (Live Voice's Agents sidebar)
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
// scrapers/flex/index.js for the full reasoning.
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
// path, which could miss an IdP redirect step.
function isLoginUrl(url) {
  return !/roccofridge\.gorgias\.com\/app\//.test(url || '')
}

// ── Live Overview: 4 stat cards ─────────────────────────────────────────────
// Runs inside page.evaluate(). Class names are CSS-modules hashed suffixes
// (see guardianbikes/index.js's file header) — matched with [class*=] so a
// redeploy's new hash doesn't silently break this.
function scrapeOverviewStatCards() {
  const wrappers = Array.from(document.querySelectorAll('[class*="KeyMetricCellWrapper--metric-"]'))
  const stats = []
  wrappers.forEach(w => {
    const labelEl = w.querySelector('[class*="KeyMetricCell--label--"]')
    const valueEl = w.querySelector('[class*="KeyMetricCell--value--"]')
    if (!labelEl || !valueEl) return
    const label = labelEl.textContent.trim()
    const value = valueEl.textContent.trim()
    if (label) stats.push({ label, value })
  })
  return stats
}

// ── Live Overview: "Support Volume" chart ───────────────────────────────────
// Runs inside page.evaluate(). See guardianbikes/index.js's file header for
// why this reads React fiber internals instead of hovering the canvas.
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
// AFTER that login succeeds.
const AGENTS_PAGES = new Map() // accountId -> Page

async function ensureAgentsPage(context, account) {
  let p = AGENTS_PAGES.get(account.id)
  if (p && !p.isClosed()) return p

  p = await context.newPage()
  AGENTS_PAGES.set(account.id, p)
  p.on('pageerror', () => {})
  p.on('dialog', d => d.dismiss().catch(() => {}))
  await p.goto(account.agentsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn(`[roccoridge] agents goto failed: ${e.message}`)
  })
  return p
}

// ── Live Agents: the table itself ───────────────────────────────────────────
// Runs inside page.evaluate(). See guardianbikes/index.js's file header for
// the full DOM structure confirmed via live probing.
function scrapeAgentTable() {
  const table = document.querySelector('table')
  if (!table) return []
  const rows = Array.from(table.querySelectorAll('tbody tr'))

  return rows.map(tr => {
    const tds = Array.from(tr.querySelectorAll('td'))
    if (tds.length < 6) return null

    const agentName    = tds[0].querySelector('[class*="TableStat--userName--"]')?.textContent.trim() || ''
    const onlineStatus = tds[1].querySelector('[data-name="badge"]')?.textContent.trim() || ''
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
  await supabaseUpsert('roccoridge_overview_kpis', [row])
  console.log(`[roccoridge] ✅ Overview KPIs written (${stats.length} stat card(s))`)
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
        hour_label: new Date(hourTs * 1000).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
        metric,
        metric_label: ds.label,
        value:      String(value),
        updated_at: now,
      })
    })
  })
  if (rows.length === 0) return
  await supabaseUpsert('roccoridge_ticket_volume', rows)
  console.log(`[roccoridge] ✅ Ticket volume written (${rows.length} point(s))`)
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
  await pruneDeparted('roccoridge_agents', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('roccoridge_agents', deduped)
  console.log(`[roccoridge] ✅ Agents written (${deduped.length})`)
}

async function writeVoiceKpis(stats, accountId) {
  if (!stats || stats.length === 0) return
  const row = { id: accountId, account_id: accountId, updated_at: new Date().toISOString() }
  stats.forEach(s => { row[sanitizeMetricKey(s.label)] = s.value })
  await supabaseUpsert('roccoridge_voice_kpis', [row])
  console.log(`[roccoridge] ✅ Voice KPIs written (${stats.length} stat card(s))`)
}

async function writeLiveCalls(calls, accountId) {
  const now = new Date().toISOString()
  const rows = (calls || []).map(c => ({
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
  await pruneDeparted('roccoridge_live_calls', accountId, new Set(deduped.map(r => r.id)))
  if (deduped.length === 0) return
  await supabaseUpsert('roccoridge_live_calls', deduped)
  console.log(`[roccoridge] ✅ Live calls written (${deduped.length})`)
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
  await pruneDeparted('roccoridge_voice_agents', accountId, new Set(deduped.map(r => r.id)))
  await supabaseUpsert('roccoridge_voice_agents', deduped)
  console.log(`[roccoridge] ✅ Voice agents written (${deduped.length})`)
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
    console.warn(`[roccoridge] voice goto failed: ${e.message}`)
  })
  return p
}

// ── Live Voice: 11 KPI cards ─────────────────────────────────────────────────
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
function scrapeVoiceAgents() {
  const table = Array.from(document.querySelectorAll('table')).find(t => t.querySelector('[class*="AgentCard--container--"]'))
  if (!table) return []
  const rows = Array.from(table.querySelectorAll('tbody tr'))

  let currentCategory = ''
  const agents = []
  rows.forEach(tr => {
    const categoryEl = tr.querySelector('[class*="LiveVoiceAgentsList--categoryCell--"]')
    if (categoryEl) {
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
    manualLogin: true,   // IdP login flow unconfirmed — see file header. Waits for `resume roccoridge`
  },

  // ── Login: navigate and check. This account's sign-in goes through an IdP
  // redirect (see file header), not yet probed for a scriptable path — same
  // posture as guardianbikes. If the persisted session is still valid this
  // lands straight on Live Overview; otherwise it just waits for a human.
  async login(page, context, account, sessionPath) {
    page.on('pageerror', err => console.warn(`[roccoridge page error] ${err.message}`))
    page.on('dialog', d => d.dismiss().catch(() => {})) // defensive — see scrapers/flex/index.js's identical comment for why

    await page.goto(account.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[roccoridge] goto failed: ${e.message}`)
    })
    await page.waitForTimeout(1500)

    if (isLoginUrl(page.url())) {
      console.log('[roccoridge] Not authenticated — manual login required. Waiting for human (resume roccoridge once done)...')
      return
    }

    if (account.agentsUrl) {
      await ensureAgentsPage(context, account)
    } else {
      console.log('[roccoridge] No agentsUrl configured — skipping Live Agents until it is set in config.json')
    }

    if (account.voiceUrl) {
      await ensureVoicePage(context, account)
    } else {
      console.log('[roccoridge] No voiceUrl configured — skipping Live Voice until it is set in config.json')
    }
  },

  // ── Session-expiry check ─────────────────────────────────────────────────────
  isSessionExpired(page) {
    return isLoginUrl(page.url())
  },

  // ── Scrape: read whatever the (already live-updating, same page kept open
  // the whole time) Live Overview page has rendered. No re-navigation needed
  // — same reasoning as guardianbikes/index.js's file header.
  async scrape(page, account) {
    if (isLoginUrl(page.url())) return { hasData: false }

    let stats = []
    try {
      stats = await page.evaluate(scrapeOverviewStatCards)
    } catch (err) {
      console.warn(`[roccoridge] stat card scrape failed: ${err.message}`)
    }

    let chart = null
    try {
      chart = await page.evaluate(scrapeSupportVolumeChart)
    } catch (err) {
      console.warn(`[roccoridge] chart scrape failed: ${err.message}`)
    }

    let agents = []
    if (account.agentsUrl) {
      try {
        const agentsPage = await ensureAgentsPage(page.context(), account)
        agents = await agentsPage.evaluate(scrapeAgentTable)
      } catch (err) {
        console.warn(`[roccoridge] agents scrape failed: ${err.message}`)
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
        console.warn(`[roccoridge] voice scrape failed: ${err.message}`)
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
    await writeOverviewKpis(data.stats, accountId).catch(err => console.warn(`[roccoridge] overview_kpis write failed: ${err.message}`))
    await writeTicketVolume(data.chart, accountId).catch(err => console.warn(`[roccoridge] ticket_volume write failed: ${err.message}`))
    await writeAgents(data.agents, accountId).catch(err => console.warn(`[roccoridge] agents write failed: ${err.message}`))
    await writeVoiceKpis(data.voiceStats, accountId).catch(err => console.warn(`[roccoridge] voice_kpis write failed: ${err.message}`))
    await writeLiveCalls(data.liveCalls, accountId).catch(err => console.warn(`[roccoridge] live_calls write failed: ${err.message}`))
    await writeVoiceAgents(data.voiceAgents, accountId).catch(err => console.warn(`[roccoridge] voice_agents write failed: ${err.message}`))
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
