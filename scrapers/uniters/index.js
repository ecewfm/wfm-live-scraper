// File: scrapers/uniters/index.js
// scrapers/uniters/index.js
// Five9 Supervisor Desktop scraper for UNITERS.
//
// Same Five9 CRM as PerfectServe, but a DIFFERENT account with a DIFFERENT grid
// layout. The DOM scraping here is ported from the Uniters Chrome extension
// (content.js) — NOT from scrapers/perfectserve. Key differences vs PerfectServe:
//   • Grid rows read cells positionally: cells[0]=Name, cells[1]=Email, and the
//     column headers map by index (PerfectServe reads a separate "docked" name cell).
//   • Uniters exposes an "Agent State" widget (full roster, ~20 columns) plus a
//     "Campaign Statistics" widget that PerfectServe does not.
//
// config.json entry:
//   { "id": "uniters", "username": "youruser", "password": "yourpass" }
//
// Supabase tables: see sql/uniters.sql (run once). Uniters has its OWN dedicated
// tables (uniters_kpis, uniters_global_kpis, uniters_agent_states,
// uniters_acd_status, uniters_campaign_stats) — kept fully separate from
// PerfectServe's five9_* tables. Rows still carry account_id = 'uniters' so the
// dashboard's account filter works.

'use strict'

// ── Five9 data center ─────────────────────────────────────────────────────────
// The Uniters Chrome extension matched both app-scl and app-atl. Defaulting to
// app-atl (same as PerfectServe). If login lands on the wrong host / an error
// page for Uniters, switch this to 'https://app-scl.five9.com/'.
const SUPERVISOR_URL = 'https://app-atl.five9.com/'
const LOGIN_TIMEOUT  = 90000   // 90s for full login flow
const DASH_TIMEOUT   = 60000   // 60s to wait for dashboard widgets

// ── Supabase write helper ─────────────────────────────────────────────────────
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
    throw new Error(`Supabase ${table} error: ${res.status} ${txt.substring(0, 160)}`)
  }
}

// ── Departure detection — delete rows for agents no longer in the roster ─────
// Upsert alone never removes a row, so an agent who logs out with no visible
// "Offline" bucket to fall into would be left frozen in Supabase forever.
// Tracks the ID set written last tick in memory. The FIRST time a table is
// touched in this process's lifetime, the baseline is seeded from Supabase's
// EXISTING rows for that account instead of an empty set — otherwise a row
// already stale BEFORE this process started would never enter tracking and
// never be recognized as departed. No deletion happens on that seeding call
// itself, since an incomplete first live scrape could otherwise look like a
// mass departure — only ticks after the seed actually delete.
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
      console.log(`[prune] ${table}: removed ${departed.length} departed agent(s)`)
    }
  }
  _lastSeenIds.set(table, currentIds)
}

// ── React-aware input fill (Five9 SPA uses React controlled inputs) ──────────
async function reactFill(page, selector, value) {
  await page.$eval(selector, (el, val) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set
    setter.call(el, val)
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true }))
  }, value)
}

// ── Full Five9 login flow (identical to PerfectServe — account-agnostic) ─────
//   1. Role selection cards → click Supervisor
//   2. Station setup         → click None → click Next
//   3. Login form (React)    → fill username + password → click Log In
//   4. Existing session modal → click Continue
//   5. Back to role cards    → click Supervisor again
//   6. Dashboard loads
async function handleFive9Login(page, account) {
  const username = account.username || account.email || ''
  const password = account.password || ''
  const sleep    = ms => new Promise(r => setTimeout(r, ms))

  const deadline = Date.now() + LOGIN_TIMEOUT
  let   pass     = 0

  while (Date.now() < deadline) {
    pass++
    const url = page.url()
    console.log(`[F9 login] pass=${pass} url=${url.substring(0, 80)}`)

    // ── Dashboard loaded? ────────────────────────────────────────────────────
    if (url.includes('DomainSupervisor') || url.includes('/supervisor/index')) {
      console.log('[F9 login] ✅ Supervisor URL reached — login complete')
      return
    }
    const widgets = await page.$$('.stat-view, .stat-threshold-container, .f9-widget-grid-row')
    if (widgets.length > 0) {
      console.log('[F9 login] ✅ Dashboard widgets found')
      return
    }

    // ── Error page (session expired / force-logout) ──────────────────────────
    const returnLink = await page.$('#ErrorPage-return-link')
    if (returnLink) {
      console.log('[F9 login] Error page — clicking Return to login...')
      await returnLink.click()
      await sleep(2000)
      continue
    }

    // ── Role selection cards — click Supervisor ──────────────────────────────
    const supCard = await page.$(
      'a.home-link.supervisor, ' +
      '[class*="role-card"] a[href*="supervisor"], ' +
      'a[href*="DomainSupervisor"], ' +
      '.at-t-applications__card'
    )
    if (supCard) {
      console.log('[F9 login] Role cards — clicking Supervisor...')
      await supCard.click()
      await sleep(3000)
      continue
    }

    // ── Branded card with "Supervisor" text ──────────────────────────────────
    const atCards = await page.$$('.at-t-applications__card, [class*="five9-role"], [class*="roleCard"]')
    let clickedCard = false
    for (const card of atCards) {
      const txt = (await card.textContent() || '').toLowerCase()
      if (txt.includes('supervisor') && !txt.includes('agent')) {
        console.log('[F9 login] Clicking Supervisor card...')
        await card.click()
        await sleep(3500)
        clickedCard = true
        break
      }
    }
    if (clickedCard) continue

    // ── Station setup — click None → Next ────────────────────────────────────
    const noneStation = await page.$('#station-setup-4')
    if (noneStation) {
      console.log('[F9 login] Station setup — clicking None...')
      const isActive = await noneStation.evaluate(el => el.classList.contains('active'))
      if (!isActive) {
        await noneStation.click()
        await sleep(500)
      }
      const nextBtn = await page.$('.btn.pull-right.f9-positive-cta-btn, .f9-positive-cta-btn')
      if (nextBtn) {
        await nextBtn.click()
        await sleep(2000)
      }
      continue
    }

    // ── Existing session modal ────────────────────────────────────────────────
    const continueBtn = await page.$(
      '#existing-session-continue, ' +
      '[class*="existing-session"] button, ' +
      'button[data-id="continue"]'
    )
    if (continueBtn) {
      console.log('[F9 login] Existing session modal — clicking Continue...')
      await continueBtn.click()
      await sleep(2000)
      continue
    }

    // ── React login form (#Login-username-input) ─────────────────────────────
    const reactUsername = await page.$('#Login-username-input')
    if (reactUsername) {
      console.log('[F9 login] React login form — filling credentials...')
      if (!username || !password) throw new Error('Five9 username/password not set in config.json for "uniters"')
      await reactUsername.focus()
      await reactFill(page, '#Login-username-input', username)
      await sleep(300)
      await reactFill(page, '#Login-password-input', password)
      await sleep(400)
      const filled = await page.$eval('#Login-username-input', el => el.value)
      if (!filled) {
        await reactFill(page, '#Login-username-input', username)
        await sleep(300)
        await reactFill(page, '#Login-password-input', password)
        await sleep(400)
      }
      console.log('[F9 login] Clicking Log In...')
      await page.click('#Login-login-button')
      await sleep(3500)
      continue
    }

    // ── Plain HTML login form (login.five9.com) ───────────────────────────────
    const plainUsername = await page.$('#username')
    if (plainUsername) {
      console.log('[F9 login] Plain login form — filling credentials...')
      if (!username || !password) throw new Error('Five9 username/password not set in config.json for "uniters"')
      await page.fill('#username', username)
      await sleep(300)
      await page.fill('#password', password)
      await sleep(400)
      await page.click('#loginBtn')
      await sleep(3500)
      continue
    }

    await sleep(2000)
  }

  throw new Error(`Five9 login timed out after ${LOGIN_TIMEOUT / 1000}s`)
}

// ── Wait for the supervisor dashboard to be ready ────────────────────────────
async function waitForDashboard(page) {
  const deadline = Date.now() + DASH_TIMEOUT
  while (Date.now() < deadline) {
    const url = page.url()
    if (url.includes('DomainSupervisor') || url.includes('/supervisor/index')) {
      console.log('[F9] Supervisor URL detected — waiting for widgets...')
      try {
        await page.waitForSelector(
          '.stat-view, .stat-threshold-container, .f9-widget-grid-row, .f9-panel-header-label',
          { timeout: 20000 }
        )
        console.log('[F9] Widgets found ✅')
      } catch {
        console.log('[F9] Widgets not found yet — accepting dashboard by URL')
      }
      return
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  const url = page.url()
  if (url.includes('five9.com') && !url.includes('login') && !url.includes('error')) {
    console.log(`[F9] Accepting dashboard by URL: ${url}`)
    return
  }
  throw new Error(`Dashboard not ready after ${DASH_TIMEOUT/1000}s — URL: ${url}`)
}

// ── DOM scraping — ported directly from the Uniters extension content.js ──────
// Runs inside page.evaluate(): no Node.js scope, all helpers defined inline.
const scrapeDOM = async function () {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  const kpis           = {}
  const agentsReady    = []
  const agentsNotReady = []
  const agentsOnCall   = []
  const agentsAllState = []
  const acdStatusRows  = []
  const campaignRows   = []

  // ── Scroll a virtualized grid and collect every row ─────────────────────────
  async function scrollAndCollectRows(widget) {
    const scrollContainer = widget.querySelector('.f9-widget-grid-content')
    if (!scrollContainer) return collectVisibleRows(widget)

    const rowMap    = new Map()
    const rowHeight = 50
    const stepSize  = Math.max(scrollContainer.clientHeight - rowHeight, rowHeight)
    const savedPos  = scrollContainer.scrollTop

    scrollContainer.scrollTop = 0
    await sleep(120)

    const addRows = rows => rows.forEach(row => {
      const key = (row.email || '') + '||' + row.name
      if (key && !rowMap.has(key)) rowMap.set(key, row)
    })

    let lastScrollTop = -1
    while (true) {
      addRows(collectVisibleRows(widget))
      const currentTop = scrollContainer.scrollTop
      if (currentTop === lastScrollTop) break
      lastScrollTop = currentTop
      const atBottom = scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight
      if (atBottom) break
      scrollContainer.scrollTop += stepSize
      await sleep(120)
    }
    addRows(collectVisibleRows(widget))
    scrollContainer.scrollTop = savedPos
    return Array.from(rowMap.values())
  }

  // ── Collect currently visible agent rows (Uniters grid layout) ──────────────
  function collectVisibleRows(widget) {
    const colHeaders = Array.from(widget.querySelectorAll('.f9-widget-grid-header-label'))
      .map(el => el.innerText.trim()).filter(h => h && h !== 'Actions')
    const rows = []

    // New grid row method (Uniters account): cells positional, headers by index
    const gridRows = widget.querySelectorAll('.f9-widget-grid-row')
    if (gridRows.length > 0) {
      gridRows.forEach(rowEl => {
        const cells = Array.from(rowEl.querySelectorAll('.f9-widget-grid-cell-inner'))
          .map(c => c.innerText.trim())
        if (cells.length === 0) return
        const name  = cells[0] || ''
        const email = cells[1] || ''
        if (!name) return
        const colMap = {}
        colHeaders.forEach((col, idx) => { colMap[col] = cells[idx] !== undefined ? cells[idx] : '' })
        rows.push({ name, username: email, email, colMap })
      })
      return rows
    }

    // Fallback: original agent-name-label method
    const nameEls = widget.querySelectorAll('.agent-name-label')
    nameEls.forEach(nameEl => {
      const name       = nameEl.querySelector('.agent-name-grid-cell-name')?.innerText.trim()
                      || nameEl.innerText.split('\n')[0].trim()
      const usernameEl = nameEl.closest('[class]')?.querySelector('.agent-name-grid-cell-username')
                      || nameEl.parentElement?.querySelector('.agent-name-grid-cell-username')
      const username   = usernameEl?.innerText.trim() || ''
      const emailEl    = nameEl.closest('[class]')?.querySelector('.tt.tt-allow-content')
      const email      = emailEl?.innerText.trim() || username

      let rowEl = nameEl.parentElement
      for (let i = 0; i < 8; i++) {
        if (!rowEl) break
        if (rowEl.querySelectorAll('*').length >= Math.max(colHeaders.length - 1, 3)) break
        rowEl = rowEl.parentElement
      }
      if (!rowEl) return

      const leafEls = Array.from(rowEl.querySelectorAll('*')).filter(el =>
        el.children.length === 0 &&
        el.innerText?.trim() &&
        !el.classList.contains('f9-widget-grid-header-label') &&
        !el.classList.contains('f9-panel-header-label') &&
        !el.classList.contains('f9-counter') &&
        !el.classList.contains('agent-name-grid-cell-name') &&
        !el.classList.contains('agent-name-grid-cell-username') &&
        !el.innerText.trim().startsWith('Alert ') &&
        !el.innerText.trim().startsWith('Active alerts')
      )
      const vals = leafEls.map(el => el.innerText.trim()).filter(v => v.length > 0)
      const colMap = {}
      colHeaders.slice(1).forEach((col, idx) => { colMap[col] = vals[idx] !== undefined ? vals[idx] : '' })
      if (name) rows.push({ name, username, email, colMap })
    })
    return rows
  }

  // ── Collect ACD / Campaign rows (short, not virtualized) ────────────────────
  function collectACDRows(widget) {
    const colHeaders = Array.from(widget.querySelectorAll('.f9-widget-grid-header-label'))
      .map(el => el.innerText.trim())
    const skillEls = widget.querySelectorAll('[class*="acd-status-name-label"]')
    const rows = []
    skillEls.forEach(skillEl => {
      const skillName = skillEl.innerText.trim()
      if (!skillName) return
      let rowEl = skillEl.parentElement
      for (let i = 0; i < 6; i++) {
        if (!rowEl) break
        if (rowEl.querySelectorAll('*').length >= Math.max(colHeaders.length - 1, 3)) break
        rowEl = rowEl.parentElement
      }
      if (!rowEl) return
      const leafEls = Array.from(rowEl.querySelectorAll('*')).filter(el =>
        el.children.length === 0 && el.innerText?.trim() &&
        !el.classList.contains('f9-widget-grid-header-label') &&
        !el.classList.contains('f9-panel-header-label') &&
        !el.innerText.trim().startsWith('Alert ')
      )
      const vals = leafEls.map(el => el.innerText.trim()).filter(v => v.length > 0)
      const colMap = {}
      colHeaders.slice(1).forEach((col, idx) => { colMap[col] = vals[idx] !== undefined ? vals[idx] : '' })
      rows.push({ skillName, colMap })
    })
    return rows
  }

  function collectCampaignRows(widget) {
    const colHeaders = Array.from(widget.querySelectorAll('.f9-widget-grid-header-label'))
      .map(el => el.innerText.trim())
    const campEls = widget.querySelectorAll('[class*="campaign-name-state-grid-cell-name"], [class*="campaign-name"]')
    const rows = []
    campEls.forEach(campEl => {
      const campName = campEl.innerText.trim()
      if (!campName) return
      let rowEl = campEl.parentElement
      for (let i = 0; i < 6; i++) {
        if (!rowEl) break
        if (rowEl.querySelectorAll('*').length >= Math.max(colHeaders.length - 1, 3)) break
        rowEl = rowEl.parentElement
      }
      if (!rowEl) return
      const leafEls = Array.from(rowEl.querySelectorAll('*')).filter(el =>
        el.children.length === 0 && el.innerText?.trim() &&
        !el.classList.contains('f9-widget-grid-header-label') &&
        !el.classList.contains('f9-panel-header-label') &&
        !el.classList.contains('campaign-name-state-grid-cell-name') &&
        !el.innerText.trim().startsWith('Alert ')
      )
      const vals = leafEls.map(el => el.innerText.trim()).filter(v => v.length > 0)
      const colMap = {}
      colHeaders.slice(1).forEach((col, idx) => { colMap[col] = vals[idx] !== undefined ? vals[idx] : '' })
      rows.push({ campName, colMap })
    })
    return rows
  }

  // ── KPI stat cards ──────────────────────────────────────────────────────────
  document.querySelectorAll('.stat-threshold-container').forEach(container => {
    const value  = container.querySelector('.f9-fit-label')?.innerText.trim()
    const skill  = container.querySelector('.stat-threshold-title')?.innerText.trim() || ''
    const metric = container.querySelector('.stat-view-header-label')?.innerText.trim() || ''
    if (!value || !metric) return
    const key = (metric + '_' + skill).replace(/\s+/g, '_').toLowerCase()
    kpis[key] = { label: metric, skill, value, raw: value }
  })

  // ── Process all stat-view widgets ───────────────────────────────────────────
  const widgets = Array.from(document.querySelectorAll('.stat-view'))
  for (const widget of widgets) {
    const header = widget.querySelector('.f9-panel-header-label, .stat-view-header-label')?.innerText.trim() || ''

    // Agent State (all agents) — full roster
    if (/^agent state/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      rows.forEach(({ name, username, email, colMap }) => {
        agentsAllState.push({
          name, username,
          email:            email || colMap['Email'] || username,
          currentState:     colMap['Current State']       || '',
          state:            colMap['State']               || '',
          stateSince:       colMap['State Since']         || '',
          callType:         colMap['Call Type']           || '',
          campaign:         colMap['Campaign']            || '',
          customer:         colMap['Customer']            || '',
          mediaAvail:       colMap['Media Availability']  || '',
          onHoldDuration:   colMap['On Hold Duration']    || '',
          reasonDuration:   colMap['Reason Duration']     || '',
          notReadyDuration: colMap['Not Ready Duration']  || '',
          onCallDuration:   colMap['On Call Duration']    || '',
          stateTimer:       colMap['State Duration']      || colMap['State Timer'] || '',
          totalCAP:         colMap['Total CAP']           || '',
          voiceWL:          colMap['Voice WL']            || '',
          chatWL:           colMap['Chat WL']             || '',
          agentGroups:      colMap['Agent Groups']        || '',
          userProfile:      colMap['User Profile']        || '',
          workingOn:        colMap['Working On']          || ''
        })
      })
    }

    // Not Ready
    else if (/not ready/i.test(header) || /^agents on not ready/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      rows.forEach(({ name, username, email, colMap }) => {
        agentsNotReady.push({
          name, username,
          email:            email || colMap['Email'] || username,
          state:            'Not Ready',
          currentState:     colMap['Current State']    || '',
          duration:         colMap['State Duration']   || colMap['State Timer'] || '',
          reason:           colMap['Reason Code']      || '',
          reasonDuration:   colMap['Reason Duration']  || '',
          acwDuration:      colMap['ACW Duration']     || '',
          callDuration:     colMap['On Call Duration'] || '',
          stateSince:       colMap['State Since']      || '',
          voiceWL:          colMap['Voice WL']         || '',
          agentGroups:      colMap['Agent Groups']     || '',
          userProfile:      colMap['User Profile']     || ''
        })
      })
    }

    // On Call
    else if (/^on call/i.test(header) || /^agents on a call/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      rows.forEach(({ name, username, email, colMap }) => {
        agentsOnCall.push({
          name, username,
          email:            email || colMap['Email'] || username,
          state:            'On Call',
          currentState:     colMap['Current State']    || '',
          duration:         colMap['State Duration']   || colMap['State Timer'] || '',
          onHoldDuration:   colMap['On Hold Duration'] || '',
          onHoldSince:      colMap['On Hold Since']    || '',
          callDuration:     colMap['On Call Duration'] || '',
          stateSince:       colMap['State Since']      || '',
          customer:         colMap['Customer']         || '',
          voiceWL:          colMap['Voice WL']         || '',
          agentGroups:      colMap['Agent Groups']     || '',
          userProfile:      colMap['User Profile']     || ''
        })
      })
    }

    // Ready for Calls
    else if (/ready for calls/i.test(header) || /^agents on ready/i.test(header)) {
      const rows = await scrollAndCollectRows(widget)
      rows.forEach(({ name, username, email, colMap }) => {
        agentsReady.push({
          name, username,
          email:            email || colMap['Email'] || username,
          state:            'Ready',
          currentState:     colMap['Current State']    || '',
          duration:         colMap['State Duration']   || colMap['State Timer'] || '',
          onHoldDuration:   colMap['On Hold Duration'] || '',
          onHoldSince:      colMap['On Hold Since']    || '',
          stateSince:       colMap['State Since']      || '',
          voiceWL:          colMap['Voice WL']         || '',
          agentGroups:      colMap['Agent Groups']     || '',
          userProfile:      colMap['User Profile']     || ''
        })
      })
    }

    // ACD Status
    else if (/^acd status/i.test(header)) {
      const rows = collectACDRows(widget)
      rows.forEach(({ skillName, colMap }) => {
        acdStatusRows.push({
          skillName,
          callsInQueue:        colMap['Calls in Queue']            || colMap['Calls In Queue']     || '',
          activeAgents:        colMap['Active Agents']             || '',
          onCalls:             colMap['On Calls']                  || '',
          readyForCalls:       colMap['Ready For Calls']           || '',
          notReadyForCalls:    colMap['Not Ready For Calls']       || '',
          currentLongestQueue: colMap['Current Longest Queue (Voice)'] || colMap['Current Longest Queue'] || '',
          longestQueueTime:    colMap['Longest Queue Time (Voice)'] || colMap['Longest Queue Time'] || '',
          serviceLevel:        colMap['Service Level (%)']         || '',
          avgSpeedOfAnswer:    colMap['Avg Speed of Answer']       || '',
          callsHandled:        colMap['Calls Handled']             || ''
        })
      })
    }

    // Campaign Statistics
    else if (/campaign statistics/i.test(header)) {
      const rows = collectCampaignRows(widget)
      rows.forEach(({ campName, colMap }) => {
        campaignRows.push({
          campaignName:   campName,
          totalCalls:     colMap['Total Calls']         || '',
          callsAbandoned: colMap['Calls Abandoned']     || '',
          avgHandleTime:  colMap['Avg Handle Time']     || '',
          avgSpeedAnswer: colMap['Avg Speed of Answer'] || '',
          dropCallPct:    colMap['Drop Call %']         || '',
          avgTalkTime:    colMap['Avg Talk Time']       || '',
          avgWrapTime:    colMap['Avg Wrap Time']       || '',
          callsConnected: colMap['Calls Connected']     || '',
          handledCalls:   colMap['Handled Calls']       || ''
        })
      })
    }
  }

  // ── Derive KPIs from ACD rows if no stat cards ──────────────────────────────
  if (Object.keys(kpis).length === 0 && acdStatusRows.length > 0) {
    acdStatusRows.forEach(row => {
      const sk = row.skillName.replace(/\s+/g, '_').toLowerCase()
      if (row.callsInQueue)     kpis['calls_in_queue_'  + sk] = { label: 'Calls In Queue',     skill: row.skillName, value: row.callsInQueue,    raw: row.callsInQueue }
      if (row.onCalls)          kpis['on_calls_'        + sk] = { label: 'On Calls',            skill: row.skillName, value: row.onCalls,          raw: row.onCalls }
      if (row.readyForCalls)    kpis['ready_for_calls_' + sk] = { label: 'Ready For Calls',     skill: row.skillName, value: row.readyForCalls,    raw: row.readyForCalls }
      if (row.notReadyForCalls) kpis['not_ready_'       + sk] = { label: 'Not Ready For Calls', skill: row.skillName, value: row.notReadyForCalls, raw: row.notReadyForCalls }
      if (row.serviceLevel)     kpis['sla_'             + sk] = { label: 'SLA',                 skill: row.skillName, value: row.serviceLevel,     raw: row.serviceLevel }
      if (row.avgSpeedOfAnswer) kpis['asa_'             + sk] = { label: 'Avg Speed of Answer', skill: row.skillName, value: row.avgSpeedOfAnswer, raw: row.avgSpeedOfAnswer }
    })
  }

  // ── Derive KPIs from Campaign rows if still empty ───────────────────────────
  if (Object.keys(kpis).length === 0 && campaignRows.length > 0) {
    campaignRows.forEach(row => {
      const ck = row.campaignName.replace(/\s+/g, '_').toLowerCase()
      if (row.totalCalls)     kpis['total_calls_' + ck] = { label: 'Total Calls',      skill: row.campaignName, value: row.totalCalls,     raw: row.totalCalls }
      if (row.avgHandleTime)  kpis['aht_'         + ck] = { label: 'Avg Handle Time',  skill: row.campaignName, value: row.avgHandleTime,  raw: row.avgHandleTime }
      if (row.callsAbandoned) kpis['abandoned_'   + ck] = { label: 'Calls Abandoned',  skill: row.campaignName, value: row.callsAbandoned, raw: row.callsAbandoned }
      if (row.avgSpeedAnswer) kpis['asa_'         + ck] = { label: 'Avg Speed Answer', skill: row.campaignName, value: row.avgSpeedAnswer, raw: row.avgSpeedAnswer }
      if (row.dropCallPct)    kpis['drop_pct_'    + ck] = { label: 'Drop Call %',      skill: row.campaignName, value: row.dropCallPct,    raw: row.dropCallPct }
    })
  }

  const hasData = Object.keys(kpis).length > 0 ||
    agentsReady.length > 0 || agentsNotReady.length > 0 ||
    agentsOnCall.length > 0 || agentsAllState.length > 0 ||
    acdStatusRows.length > 0 || campaignRows.length > 0

  if (!hasData) return null

  return {
    hasData: true,
    kpis, agentsReady, agentsNotReady, agentsOnCall,
    agentsAllState, acdStatusRows, campaignRows,
    snapshotTime: new Date().toISOString()
  }
}

// ── Write to Supabase ─────────────────────────────────────────────────────────
async function writeFive9Data(data, accountId) {
  const now = new Date().toISOString()

  // 1. KPIs — full label-value table
  const kpiRows = Object.entries(data.kpis || {}).map(([key, kpi]) => ({
    id:          `${accountId}:${key}`,
    account_id:  accountId,
    kpi_key:     key,
    label:       kpi.label   || '',
    skill:       kpi.skill   || '',
    value:       kpi.value   || '',
    raw_value:   String(kpi.raw ?? kpi.value ?? ''),
    updated_at:  now,
  }))
  if (kpiRows.length > 0) {
    await supabaseUpsert('uniters_kpis', kpiRows)
    console.log(`[${accountId}] ✅ KPIs written (${kpiRows.length})`)
  }

  // 2. Flat global summary row — one row per account (dashboard SLA/queue tiles)
  const kpiVals = Object.values(data.kpis || {})
  const findKpiVal = (labelHint) => {
    const lower = labelHint.toLowerCase()
    const globalEntry = kpiVals.find(k =>
      (k.label || '').toLowerCase().includes(lower) && k.skill === 'Global' && k.value && k.value !== '-'
    )
    if (globalEntry) return globalEntry.value
    const anyEntry = kpiVals.find(k =>
      (k.label || '').toLowerCase().includes(lower) && k.value && k.value !== '-'
    )
    return anyEntry ? anyEntry.value : ''
  }
  const globalRow = {
    id:               accountId,
    account_id:       accountId,
    sla:              findKpiVal('sla') || findKpiVal('service level'),
    avg_handle_time:  findKpiVal('handle time') || findKpiVal('aht'),
    calls_in_queue:   findKpiVal('calls in queue') || findKpiVal('queue'),
    calls_abandoned:  findKpiVal('abandon'),
    total_calls:      findKpiVal('total call'),
    agents_ready:     data.agentsReady?.length    || 0,
    agents_not_ready: data.agentsNotReady?.length || 0,
    agents_on_call:   data.agentsOnCall?.length   || 0,
    updated_at:       now,
  }
  await supabaseUpsert('uniters_global_kpis', [globalRow])
  console.log(`[${accountId}] ✅ Global KPIs written (SLA: ${globalRow.sla || '--'})`)

  // 3. Agent states — prefer the full "Agent State" roster; else merge subsets.
  //    Extended columns capture everything the Uniters grid exposes.
  const hasRoster = (data.agentsAllState || []).length > 0
  const source = hasRoster
    ? data.agentsAllState
    : [
        ...data.agentsReady    || [],
        ...data.agentsNotReady || [],
        ...data.agentsOnCall   || [],
      ]
  const agentMap = new Map()
  source.forEach(a => {
    const key = `${accountId}:${a.username || a.name}`
    if (!agentMap.has(key)) agentMap.set(key, a)
  })
  const agentRows = [...agentMap.values()].map(a => ({
    id:                 `${accountId}:${a.username || a.name}`,
    account_id:         accountId,
    name:               a.name           || '',
    username:           a.username       || '',
    email:              a.email          || '',
    // dashboard reads `state` + `duration`; surface the live current state there
    state:              a.currentState   || a.state || '',
    current_state:      a.currentState   || a.state || '',
    duration:           a.stateTimer     || a.duration || '',
    state_since:        a.stateSince     || '',
    call_type:          a.callType       || '',
    campaign:           a.campaign       || '',
    customer:           a.customer       || '',
    media_availability: a.mediaAvail     || '',
    on_hold_duration:   a.onHoldDuration || '',
    on_hold_since:      a.onHoldSince    || '',
    reason:             a.reason         || '',
    reason_duration:    a.reasonDuration || '',
    not_ready_duration: a.notReadyDuration || '',
    on_call_duration:   a.onCallDuration || a.callDuration || '',
    total_cap:          a.totalCAP       || '',
    voice_wl:           a.voiceWL        || '',
    chat_wl:            a.chatWL         || '',
    agent_groups:       a.agentGroups    || '',
    user_profile:       a.userProfile    || '',
    working_on:         a.workingOn      || '',
    updated_at:         now,
  }))
  if (agentRows.length > 0) {
    await pruneDeparted('uniters_agent_states', accountId, new Set(agentRows.map(r => r.id)))
    await supabaseUpsert('uniters_agent_states', agentRows)
    console.log(`[${accountId}] ✅ Agent states written (${agentRows.length})`)
  }

  // 4. ACD Status — dedupe by skill name
  const acdMap = new Map()
  ;(data.acdStatusRows || []).forEach(row => {
    const id = `${accountId}:${row.skillName}`
    if (!acdMap.has(id)) acdMap.set(id, {
      id,
      account_id:            accountId,
      skill_name:            row.skillName            || '',
      calls_in_queue:        row.callsInQueue         || '',
      active_agents:         row.activeAgents         || '',
      on_calls:              row.onCalls              || '',
      ready_for_calls:       row.readyForCalls        || '',
      not_ready_for_calls:   row.notReadyForCalls     || '',
      current_longest_queue: row.currentLongestQueue  || '',
      longest_queue_time:    row.longestQueueTime     || '',
      service_level:         row.serviceLevel         || '',
      avg_speed_of_answer:   row.avgSpeedOfAnswer     || '',
      calls_handled:         row.callsHandled         || '',
      updated_at:            now,
    })
  })
  const acdRows = [...acdMap.values()]
  if (acdRows.length > 0) {
    await supabaseUpsert('uniters_acd_status', acdRows)
    console.log(`[${accountId}] ✅ ACD status written (${acdRows.length} skills)`)
  }

  // 5. Campaign Statistics — dedupe by campaign name
  const campMap = new Map()
  ;(data.campaignRows || []).forEach(row => {
    const id = `${accountId}:${row.campaignName}`
    if (!campMap.has(id)) campMap.set(id, {
      id,
      account_id:          accountId,
      campaign_name:       row.campaignName    || '',
      total_calls:         row.totalCalls      || '',
      calls_abandoned:     row.callsAbandoned  || '',
      avg_handle_time:     row.avgHandleTime   || '',
      avg_speed_of_answer: row.avgSpeedAnswer  || '',
      drop_call_pct:       row.dropCallPct     || '',
      avg_talk_time:       row.avgTalkTime     || '',
      avg_wrap_time:       row.avgWrapTime     || '',
      calls_connected:     row.callsConnected  || '',
      handled_calls:       row.handledCalls    || '',
      updated_at:          now,
    })
  })
  const campRows = [...campMap.values()]
  if (campRows.length > 0) {
    await supabaseUpsert('uniters_campaign_stats', campRows)
    console.log(`[${accountId}] ✅ Campaign stats written (${campRows.length})`)
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:     'Five9',
    interval: 30000,
  },

  async login(page, context, account, sessionPath) {
    page.on('console', msg => {
      const txt = msg.text()
      if (txt.startsWith('[F9]')) console.log(`[uniters browser] ${txt}`)
    })
    page.on('pageerror', err => console.warn(`[uniters page error] ${err.message}`))

    console.log(`[uniters] Navigating to Five9 supervisor...`)
    await page.goto(SUPERVISOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    await handleFive9Login(page, account)
    await waitForDashboard(page)

    console.log('[uniters] Waiting 6s for widgets to fully render...')
    await new Promise(r => setTimeout(r, 6000))
    await context.storageState({ path: sessionPath })
    console.log('[uniters] ✅ Login complete, dashboard ready')
  },

  isSessionExpired(page) {
    const url = page.url()
    return url.includes('loginError=true') ||
           url.includes('login.five9.com') ||
           url === 'about:blank' ||
           url.includes('/error.html')
  },

  async scrape(page, account) {
    try {
      return await page.evaluate(scrapeDOM)
    } catch (err) {
      console.error(`[uniters] scrape error:`, err.message)
      return null
    }
  },

  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeFive9Data(data, accountId)
  },

  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const kpiVals = Object.values(data.kpis || {})
    const slaKpi  = kpiVals.find(k => k.label === 'SLA' || k.label?.toLowerCase().includes('service level'))
    const totalQ  = (data.acdStatusRows || []).reduce((s, r) => s + (parseInt(r.callsInQueue) || 0), 0)
    const rd = data.agentsReady?.length    || 0
    const nr = data.agentsNotReady?.length || 0
    const oc = data.agentsOnCall?.length   || 0
    const totalAgt = (data.agentsAllState?.length || 0) || (rd + nr + oc)
    return {
      sla:     slaKpi?.value || '--',
      waiting: String(totalQ),
      agents:  String(totalAgt),
      info:    `Rd:${rd} NR:${nr} OC:${oc}`,
    }
  }
}
