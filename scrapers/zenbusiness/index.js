// File: scrapers/zenbusiness/index.js
// scrapers/zenbusiness/index.js
// NICE inContact CXone dashboard scraper for the ZenBusiness account.
//
// Same underlying CRM as Hippo (NICE CXone), but ZenBusiness's tenant has real
// DOM differences confirmed by probing their Chrome extension build — ported
// faithfully here rather than reusing Hippo's selectors:
//   - Widget title lives in SPAN.overflowModuleName (Hippo used a broader
//     multi-selector list) — narrower and more reliable for this tenant.
//   - Each widget renders TWICE (GRIDSTER-ITEM outer wrapper + DIV.gridItem
//     inner) — scope to gridster-item only to avoid duplicate rows, instead
//     of Hippo's ancestor-containment dedup filter.
//   - No plain HTML <table> widgets on this dashboard — ag-Grid only.
//   - SLA legend regex requires a decimal point (Hippo's allowed either).
//   - Angular/Chart.js SLA reader matches labels case/space-insensitively
//     ("Out SLA" / "OutSLA" / "out") — more robust than Hippo's simple
//     substring check.
//   - Keep-alive is a continuous, page-independent 28s timer PLUS a
//     document.visibilityState/hidden spoof (their probing found NICE's idle
//     detector on this tenant also reacts to the tab being backgrounded) —
//     stronger than Hippo's tick-driven keep-alive.
//
// LOGIN: manualLogin (see meta below). ZenBusiness requires phone-based MFA
// that can't be scripted, so this scraper opens a VISIBLE browser, navigates
// to the dashboard URL, and WAITS. Log in + complete the phone auth by hand,
// then in the scraper.js terminal run:
//     resume zenbusiness
// The session is then persisted (sessions/zenbusiness.json) so future
// restarts skip the manual step as long as that session is still valid.
//
// config.json entry:
//   { "id": "zenbusiness", "dashboardUrl": "https://na1.nice-incontact.com/apps/#/dashboard/wrapper/dashboards" }
//   (adjust dashboardUrl if ZenBusiness's tenant is on a different cluster)
//
// Supabase tables needed — see sql/zenbusiness.sql (run once):
//   zenbusiness_kpis      — label/value rows for KPI tiles (dynamic, no schema change per widget)
//   zenbusiness_datasets  — JSONB headers/rows per discovered ag-Grid widget (dynamic)
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

// ── Supabase write helper (same pattern as hippo/perfectserve/uniters) ──────
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

// ── Departure detection — delete rows for agents no longer in the roster ─────
// Upsert alone never removes a row, so an agent who logs out with no visible
// "Offline"/"Logged Out" state to fall into would be left frozen in Supabase
// forever. Tracks the ID set written last tick per table in memory. The FIRST
// time a table is touched in this process's lifetime, the baseline is seeded
// from Supabase's EXISTING rows for that account instead of an empty set —
// otherwise a row already stale BEFORE this process started would never
// enter tracking and never be recognized as departed. No deletion happens on
// that seeding call itself, since an incomplete first live scrape could
// otherwise look like a mass departure — only ticks after the seed delete.
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

function sanitizeKey(s) {
  return String(s || '').replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '')
}

// ── Known agent-roster widgets — each gets its OWN typed table (not one
// shared table) since their real columns differ per widget: most are
// Agent Name/Agent State/Agent State Time, but Agent Contact View adds
// Contact No/Skill/Channel, and ECE Contact List uses different header
// names entirely (State Name/State Time). Matched by header NAME, not
// position, so column order (e.g. MoneyBanking Team's swapped Agent State/
// Agent State Time) doesn't matter. Any widget NOT listed here (e.g. Metrics
// Summary, an aggregated report, not a live roster) falls through to the
// generic zenbusiness_datasets bucket.
const KNOWN_AGENT_WIDGETS = {
  'collection team': {
    table: 'zenbusiness_collection_team', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'cs success - email': {
    table: 'zenbusiness_cs_success_email', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'cs success - chat': {
    table: 'zenbusiness_cs_success_chat', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'retention team': {
    table: 'zenbusiness_retention_team', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'web services': {
    table: 'zenbusiness_web_services', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'cs care - phones': {
    table: 'zenbusiness_cs_care_phones', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'moneybanking team': {
    table: 'zenbusiness_moneybanking_team', idFrom: 'agent_name',
    columns: { 'agent name': 'agent_name', 'agent state': 'state', 'agent state time': 'state_time' },
  },
  'agent contact view': {
    table: 'zenbusiness_agent_contact_view', idFrom: 'agent_name',
    columns: {
      'agent name': 'agent_name', 'contact no': 'contact_no', 'skill': 'skill',
      'channel': 'channel', 'agent contact state': 'state', 'agent contact state time': 'state_time',
    },
  },
  'ece contact list': {
    table: 'zenbusiness_ece_contact_list', idFrom: 'agent_name',
    columns: { 'state name': 'state', 'state time': 'state_time', 'agent name': 'agent_name', 'channel': 'channel' },
  },
}

function colIndex(headers, headerName) {
  return headers.findIndex(h => String(h).trim().toLowerCase() === headerName)
}

// Map a dataset's rows into typed column objects using a KNOWN_AGENT_WIDGETS
// entry's header→column map (same pattern as Hippo's KNOWN_WIDGETS).
function mapKnownWidgetRows(dataset, def, accountId, now) {
  const idxByCol = {}
  Object.entries(def.columns).forEach(([header, col]) => {
    idxByCol[col] = colIndex(dataset.headers, header)
  })
  return dataset.rows.map(row => {
    const out = { account_id: accountId, updated_at: now }
    Object.entries(idxByCol).forEach(([col, idx]) => { out[col] = idx >= 0 ? (row[idx] || '') : '' })
    out.id = `${accountId}:${sanitizeKey(out[def.idFrom])}`
    return out
  })
}

// ── DOM scraping — ported from ZenBusiness's content_iframe.js/signalr_interceptor.js
// Runs inside page.evaluate()/frame.evaluate(). Self-contained, no outer scope.
async function scrapeZenBusinessDashboard(snapshotTime) {
  // ── Widget name resolver — span.overflowModuleName is the confirmed source ─
  function getWidgetName(element, fallbackIdx) {
    var ctx = element.closest('gridster-item, .gridItem') || element
    var nameEl = ctx.querySelector('span.overflowModuleName')
    var rawText = nameEl ? (nameEl.innerText || '').trim() : ''

    if (!rawText) {
      var fallbackEl = ctx.querySelector('.gridItemHeaderTitle, .txtOverflowModuleName')
      rawText = fallbackEl ? (fallbackEl.innerText || '').trim() : ''
    }

    if (rawText && rawText.length > 0 && rawText.length < 120) {
      return rawText
        .replace(/\s*\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?/gi, '')
        .replace(/\s*\(\d+\)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    return 'Widget_' + (fallbackIdx + 1)
  }

  // ── Ag-Grid tables only — this dashboard has no plain HTML <table> widgets ─
  async function scrapeAllTables() {
    var results = []
    // querySelectorAll never returns duplicates within one call, and the
    // fallback only runs when the primary query finds nothing, so there's no
    // overlap between the two to dedup against.
    var candidates = Array.from(document.querySelectorAll('gridster-item .ag-root-wrapper'))
    if (candidates.length === 0) {
      candidates = Array.from(document.querySelectorAll('.ag-root-wrapper'))
    }

    for (var i = 0; i < candidates.length; i++) {
      var widgetName = getWidgetName(candidates[i], i)
      var result = await scrapeAgGrid(candidates[i], widgetName)
      if (result && result.rows.length > 0) results.push(result)
    }

    return results
  }

  // ── Collect currently-visible ag-Grid rows (one static DOM pass) ───────────
  // Keyed by ag-Grid's own row-index attribute where available (stable across
  // our own scroll passes below, since we don't re-sort/filter mid-collection)
  // so the same logical row scrolled into view twice doesn't get duplicated.
  function collectVisibleAgGridRows(grid) {
    var out = []
    grid.querySelectorAll('.ag-row:not(.ag-hidden)').forEach(function (row) {
      var cells = row.querySelectorAll('.ag-cell')
      if (cells.length === 0) return
      var rowData = [snapshotTime]
      cells.forEach(function (cell) {
        var groupVal = cell.querySelector('.ag-group-value')
        var text = groupVal
          ? (groupVal.innerText || '').trim()
          : (cell.innerText || '').trim().replace(/\s+/g, ' ')
        if (!text) {
          text = cell.getAttribute('aria-label') ||
            (cell.querySelector('[aria-label]') && cell.querySelector('[aria-label]').getAttribute('aria-label')) ||
            (cell.querySelector('span[title]') && cell.querySelector('span[title]').getAttribute('title')) || ''
          text = text.trim()
        }
        rowData.push(text || '')
      })
      if (!rowData.slice(1).some(function (v) { return v !== '' })) return
      var rowIndex = row.getAttribute('row-index')
      var key = rowIndex !== null ? 'idx:' + rowIndex : 'val:' + rowData.slice(1).join('|')
      out.push({ key: key, data: rowData })
    })
    return out
  }

  // ── Scroll ag-Grid's own viewport through its full range, merging rows as
  // they come into view. ag-Grid virtualizes rows — only what's currently
  // scrolled into view exists in the DOM — so a single static pass (the old
  // behavior) silently misses/keeps-stale any agent scrolled out of view at
  // the moment of that scrape tick. This is what caused a real agent's status
  // to go stale in Supabase while their actual live status kept changing.
  async function scrollAndCollectAgGridRows(grid) {
    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
    var viewport = grid.querySelector('.ag-body-viewport') || grid.querySelector('.ag-center-cols-viewport')
    var rowMap = new Map()

    function addCurrent() {
      collectVisibleAgGridRows(grid).forEach(function (r) { rowMap.set(r.key, r.data) })
    }

    if (!viewport) { addCurrent(); return Array.from(rowMap.values()) }

    var savedTop = viewport.scrollTop
    viewport.scrollTop = 0
    await sleep(80)
    addCurrent()

    var stepSize = Math.max(viewport.clientHeight - 30, 30)
    var lastTop = -1
    var guard = 0
    while (guard < 200) {
      guard++
      var atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 2
      if (atBottom) break
      viewport.scrollTop += stepSize
      await sleep(90)
      addCurrent()
      if (viewport.scrollTop === lastTop) break
      lastTop = viewport.scrollTop
    }
    viewport.scrollTop = savedTop
    return Array.from(rowMap.values())
  }

  async function scrapeAgGrid(grid, name) {
    var headers = []

    grid.querySelectorAll('.ag-header-cell-text').forEach(function (cell) {
      var t = (cell.innerText || '').trim()
      if (t) headers.push(t)
    })
    if (headers.length === 0) {
      grid.querySelectorAll('.ag-header-cell').forEach(function (cell) {
        var colId = cell.getAttribute('col-id') || ''
        var text = (cell.innerText && cell.innerText.trim()) || colId
        if (text) headers.push(text)
      })
    }

    var rows = await scrollAndCollectAgGridRows(grid)

    if (rows.length === 0) return null
    return { name: name, headers: ['Snapshot Time'].concat(headers), rows: rows }
  }

  // ── KPI tiles (queue counters + SLA canvas widgets) — scoped to gridster-item
  function scrapeTiles() {
    var rows = []
    var headers = ['Snapshot Time', 'Widget Name', 'Metric', 'Value']
    var seen = {}

    function addRow(wName, metric, val) {
      var key = wName + '|' + metric
      if (!seen[key]) { seen[key] = true; rows.push([snapshotTime, wName, metric, val]) }
    }

    var containers = Array.from(document.querySelectorAll('gridster-item'))
    var targets = containers.length > 0 ? containers : Array.from(document.querySelectorAll('.gridItem'))

    targets.forEach(function (ctx, idx) {
      if (ctx.querySelector('.ag-root-wrapper')) return
      var widgetName = getWidgetName(ctx, idx)

      var queueCountEl = ctx.querySelector('h2#bothInQueue, h2.queue-counter-info')
      var waitTimeEl = ctx.querySelector('h3#longestQueueTimeBoth, h3.queue-counter-info')
      if (queueCountEl) {
        var count = (queueCountEl.innerText || '').trim()
        var wait = waitTimeEl ? (waitTimeEl.innerText || '').trim() : null
        if (count) addRow(widgetName, 'Contacts in Queue', count)
        if (wait) addRow(widgetName, 'Longest Wait Time', wait)
        return
      }

      if (ctx.querySelector('canvas')) {
        var allText = ctx.innerText || ''
        var inSlaMatch = allText.match(/In SLA\s*\((\d+)\)/i)
        var outSlaMatch = allText.match(/Out SLA\s*\((\d+)\)/i)
        var pctMatch = allText.match(/(\d{1,3}\.\d{1,2})%/)
        if (inSlaMatch) addRow(widgetName, 'In SLA', inSlaMatch[1])
        if (outSlaMatch) addRow(widgetName, 'Out SLA', outSlaMatch[1])
        if (pctMatch) addRow(widgetName, 'SLA %', pctMatch[1] + '%')
        return
      }

      var text = (ctx.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text || text.length > 600) return

      var lines = (ctx.textContent || '').split(/[\n\r]+/).map(function (l) { return l.trim() }).filter(function (l) { return l.length > 0 && l.length < 100 })
      lines.forEach(function (line, i) {
        var metric = i === 0 ? widgetName : widgetName + ' (' + i + ')'
        addRow(widgetName, metric, line)
      })
    })

    return { name: 'KPI_Tiles', headers: headers, rows: rows }
  }

  // ── Angular/Chart.js SLA reader — label-order/case/space-independent ────────
  function scrapeAngularSlaWidgets() {
    var results = []
    if (!window.ng || typeof window.ng.getOwningComponent !== 'function') return results
    var seenComps = new WeakSet()
    var canvasIdx = 0

    function resolveWidgetName(canvas, fallbackIdx) {
      try {
        var ctx = canvas.closest('gridster-item, .gridItem')
        if (ctx) {
          var nameEl = ctx.querySelector('span.overflowModuleName')
          var raw = nameEl ? (nameEl.innerText || '').trim() : ''
          if (raw && raw.length > 0 && raw.length < 120) {
            return raw.replace(/\s*\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?/gi, '').replace(/\s*\(\d+\)\s*$/g, '').replace(/\s+/g, ' ').trim()
          }
        }
      } catch (_) {}
      return 'SLA_Widget_' + (fallbackIdx + 1)
    }

    function findVal(valueMap) {
      var keys = Array.prototype.slice.call(arguments, 1)
      var mapKeys = Object.keys(valueMap)
      for (var ki = 0; ki < keys.length; ki++) {
        var k = String(keys[ki]).toLowerCase().replace(/\s+/g, '')
        for (var mi = 0; mi < mapKeys.length; mi++) {
          if (mapKeys[mi].toLowerCase().replace(/\s+/g, '') === k) return valueMap[mapKeys[mi]]
        }
      }
      return null
    }

    function processCanvas(canvas) {
      try {
        var comp = window.ng.getOwningComponent(canvas)
        if (!comp || seenComps.has(comp)) return
        seenComps.add(comp)
        var thisIdx = canvasIdx++
        var widgetName = resolveWidgetName(canvas, thisIdx)

        var chartData = comp.chartConfig && comp.chartConfig.data
        if (chartData && Array.isArray(chartData.datasets) && chartData.datasets.length > 0) {
          var labels = chartData.labels || []
          var dataset = chartData.datasets[0]
          var data = dataset.data || []
          var valueMap = {}
          labels.forEach(function (lbl, i) { if (lbl && data[i] !== undefined) valueMap[String(lbl)] = data[i] })

          var outCount = findVal(valueMap, 'OutSLA', 'Out SLA', 'out')
          var inCount = findVal(valueMap, 'InSLA', 'In SLA', 'in')

          if (outCount !== null || inCount !== null) {
            var total = (Number(outCount) || 0) + (Number(inCount) || 0)
            var slaPct = total > 0 ? ((Number(inCount) / total) * 100).toFixed(2) + '%' : 'N/A'
            results.push({ widgetName: widgetName, metric: 'SLA %', value: slaPct })
            results.push({ widgetName: widgetName, metric: 'In SLA', value: String(inCount != null ? inCount : 'N/A') })
            results.push({ widgetName: widgetName, metric: 'Out SLA', value: String(outCount != null ? outCount : 'N/A') })
            return
          }
        }

        var centerText = comp.chartConfig && comp.chartConfig.options && comp.chartConfig.options.elements && comp.chartConfig.options.elements.center && comp.chartConfig.options.elements.center.text
        if (centerText && String(centerText).trim().length > 0) {
          results.push({ widgetName: widgetName, metric: 'SLA %', value: String(centerText).trim() })
        }
      } catch (err) { /* non-fatal */ }
    }

    function searchShadows(root, depth) {
      if (depth > 12) return
      try {
        root.querySelectorAll('canvas[basechart]').forEach(function (canvas) { processCanvas(canvas) })
        root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) searchShadows(el.shadowRoot, depth + 1) })
      } catch (_) {}
    }
    try { searchShadows(document, 0) } catch (_) {}
    return results
  }

  // ── Assemble: ag-Grid tables + tiles, merging Angular SLA data in ──────────
  var results = await scrapeAllTables()
  var tiles = scrapeTiles()
  var slaResults = scrapeAngularSlaWidgets()

  slaResults.forEach(function (r) {
    var dupe = tiles.rows.some(function (row) { return row[1] === r.widgetName && row[2] === r.metric })
    if (!dupe) tiles.rows.push([snapshotTime, r.widgetName, r.metric, r.value])
  })

  if (tiles.rows.length > 0) results.push(tiles)
  return results
}

// ── Keep-alive — ZenBusiness's own probe found the idle detector on this
// tenant ALSO reacts to the tab being backgrounded, not just mouse inactivity.
// Ported faithfully: continuous, page-independent 28s timer (installed once,
// keeps running regardless of Node-side scrape timing) + a visibilityState/
// hidden spoof, PLUS the same "Dashboard Paused" auto-dismiss guard used for
// Hippo as a defensive backstop in case the proactive measures ever miss.
function keepDashboardAlive() {
  if (window.__zenKeepAliveActive) return
  window.__zenKeepAliveActive = true

  try {
    Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible' }, configurable: true })
    Object.defineProperty(document, 'hidden', { get: function () { return false }, configurable: true })
    document.addEventListener('visibilitychange', function (e) { e.stopImmediatePropagation() }, true)
  } catch (e) {}

  function fireKeepAliveEvents() {
    try {
      var x = Math.floor(Math.random() * (window.innerWidth - 100)) + 50
      var y = Math.floor(Math.random() * (window.innerHeight - 100)) + 50
      var moveEvt = new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window })
      document.dispatchEvent(moveEvt)
      var target = document.elementFromPoint(x, y)
      if (target && target !== document.body) target.dispatchEvent(moveEvt)
      document.body.dispatchEvent(new Event('scroll', { bubbles: true }))
      window.dispatchEvent(new Event('scroll', { bubbles: true }))
    } catch (e) {}
  }

  fireKeepAliveEvents()
  setInterval(fireKeepAliveEvents, 28000)

  // ── Defensive backstop: auto-dismiss a "Dashboard Paused"/idle overlay if
  // the proactive measures above ever miss (same pattern proven for Hippo).
  var PAUSE_RE = /dashboard.{0,10}paused|move your cursor.{0,30}resume|paused due to.{0,30}inactiv|still there|are you still|session.*expir|timed.?out/i

  function dismissPausedNode(node) {
    fireKeepAliveEvents()
    setTimeout(fireKeepAliveEvents, 150)
    setTimeout(fireKeepAliveEvents, 400)
    setTimeout(function () {
      try {
        var closeSelectors = ['button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]', '[class*="close"]', '[class*="dismiss"]', 'button.close', '.modal-close', '[data-dismiss]']
        var clicked = false
        for (var s = 0; s < closeSelectors.length; s++) {
          var btn = node.querySelector(closeSelectors[s])
          if (btn) { btn.click(); clicked = true; break }
        }
        if (!clicked) {
          var btns = node.querySelectorAll('button, [role="button"], .btn')
          for (var b = 0; b < btns.length; b++) {
            if (/stay|yes|continue|ok|still here|keep|dismiss|resume|i.m here/i.test(btns[b].innerText || '')) { btns[b].click(); clicked = true; break }
          }
        }
        if (!clicked && node.querySelector('button')) node.querySelector('button').click()
      } catch (e) {}
    }, 500)
  }

  try {
    if (document.body && PAUSE_RE.test(document.body.innerText || '')) dismissPausedNode(document.body)
    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes
        for (var n = 0; n < added.length; n++) {
          var node = added[n]
          if (node.nodeType !== 1) continue
          if (!PAUSE_RE.test(node.innerText || node.textContent || '')) continue
          dismissPausedNode(node)
        }
      }
    })
    if (document.body) observer.observe(document.body, { childList: true, subtree: true })
  } catch (e) {}
}

// ── Write to Supabase ─────────────────────────────────────────────────────────
async function writeZenBusinessData(datasets, accountId) {
  const now = new Date().toISOString()

  const kpiDataset = datasets.find(d => d.name === 'KPI_Tiles')
  if (kpiDataset && kpiDataset.rows.length > 0) {
    const kpiRows = kpiDataset.rows.map(([, widgetName, metric, value]) => {
      const key = `${sanitizeKey(widgetName)}:${sanitizeKey(metric)}`
      return {
        id:         `${accountId}:${key}`,
        account_id: accountId,
        kpi_key:    key,
        label:      metric,
        skill:      widgetName,
        value:      value,
        raw_value:  value,
        updated_at: now,
      }
    })
    await supabaseUpsert('zenbusiness_kpis', kpiRows)
    console.log(`[zenbusiness] ✅ KPIs written (${kpiRows.length})`)
  }

  const allTableDatasets = datasets.filter(d => d.name !== 'KPI_Tiles')

  // ── Known agent-roster widgets → each widget's OWN typed table ─────────────
  const genericDatasets = []
  for (const d of allTableDatasets) {
    const def = KNOWN_AGENT_WIDGETS[d.name.trim().toLowerCase()]
    if (!def) { genericDatasets.push(d); continue }
    const rows = mapKnownWidgetRows(d, def, accountId, now)

    // Postgres rejects a whole upsert batch if the same id appears twice in
    // it ("ON CONFLICT DO UPDATE command cannot affect row a second time") —
    // e.g. two blank/duplicate agent names in the same widget sanitize to the
    // same id. Dedup here (last one wins) so one bad row can't take down the
    // entire write.
    const dedupMap = new Map()
    rows.forEach(r => dedupMap.set(r.id, r))
    const dedupedRows = [...dedupMap.values()]
    if (dedupedRows.length < rows.length) {
      console.warn(`[zenbusiness] ⚠ Dropped ${rows.length - dedupedRows.length} duplicate-id row(s) before writing ${def.table}`)
    }
    await pruneDeparted(def.table, accountId, new Set(dedupedRows.map(r => r.id)))
    if (dedupedRows.length > 0) {
      await supabaseUpsert(def.table, dedupedRows)
      console.log(`[zenbusiness] ✅ ${d.name} → ${def.table} (${dedupedRows.length} row(s))`)
    }
  }

  // ── Everything else → generic JSONB bucket (unknown/future widgets) ────────
  if (genericDatasets.length > 0) {
    const rows = genericDatasets.map(d => ({
      id:           `${accountId}:${d.name}`,
      account_id:   accountId,
      dataset_name: d.name,
      // Native jsonb arrays, not pre-stringified — supabaseUpsert's own
      // JSON.stringify(payload) is the only serialization step needed here.
      headers:      d.headers,
      rows:         d.rows,
      row_count:    d.rows.length,
      updated_at:   now,
    }))
    await supabaseUpsert('zenbusiness_datasets', rows)
    console.log(`[zenbusiness] ✅ Datasets written (${rows.length} table(s): ${genericDatasets.map(d => d.name).join(', ')})`)
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:        'NICE CXone',
    interval:    30000,
    manualLogin: true,   // see lib/account-runner.js — waits for `resume zenbusiness`
  },

  // ── Login: manual — just navigate and wait for the human ─────────────────────
  async login(page, context, account, sessionPath) {
    const url = account.dashboardUrl || 'https://na1.nice-incontact.com/apps/#/dashboard/wrapper/dashboards'
    console.log(`[zenbusiness] Navigating to ${url} (manual login + phone MFA required)...`)
    page.on('pageerror', err => console.warn(`[zenbusiness page error] ${err.message}`))
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[zenbusiness] goto failed (will still wait for manual login): ${e.message}`)
    })
  },

  // ── Session-expiry check — drives the manual-login gate ──────────────────────
  // TODO: once you've seen ZenBusiness's actual login/SSO page, tighten this
  // pattern (e.g. add the exact hostname it redirects to).
  isSessionExpired(page) {
    const url = page.url()
    return /login|signin|sso|auth0|okta|identity/i.test(url)
  },

  // ── Scrape: discover whatever widgets currently exist ─────────────────────────
  async scrape(page, account) {
    try {
      const snapshotTime = new Date().toISOString()
      const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())]

      // Keep-alive + pause-guard, installed once per frame (idempotent).
      for (const frame of frames) {
        try { await frame.evaluate(keepDashboardAlive) } catch (_) {}
      }

      let datasets = []
      for (const frame of frames) {
        try {
          const result = await frame.evaluate(scrapeZenBusinessDashboard, snapshotTime)
          if (result && result.length) datasets.push(...result)
        } catch (_) { /* cross-origin or detached frame — skip */ }
      }

      const kpiRows = []
      const tableByName = new Map()
      datasets.forEach(d => {
        if (d.name === 'KPI_Tiles') kpiRows.push(...d.rows)
        else if (!tableByName.has(d.name)) tableByName.set(d.name, d)
      })

      const merged = [...tableByName.values()]
      if (kpiRows.length > 0) {
        merged.push({ name: 'KPI_Tiles', headers: ['Snapshot Time', 'Widget Name', 'Metric', 'Value'], rows: kpiRows })
      }

      if (merged.length === 0) return null
      return { hasData: true, datasets: merged, snapshotTime }
    } catch (err) {
      console.error(`[zenbusiness] scrape error:`, err.message)
      return null
    }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeZenBusinessData(data.datasets, accountId)
  },

  // ── Terminal dashboard display ─────────────────────────────────────────────
  getDisplayInfo(data) {
    if (!data) return { sla: '--', waiting: '0', agents: '--', info: '' }
    const kpiDataset = data.datasets.find(d => d.name === 'KPI_Tiles')
    const kpiRows = kpiDataset ? kpiDataset.rows : []

    const findVal = (metricHint) => {
      const lower = metricHint.toLowerCase()
      const row = kpiRows.find(r => r[2].toLowerCase().includes(lower))
      return row ? row[3] : '--'
    }
    const tableCount = data.datasets.filter(d => d.name !== 'KPI_Tiles').length

    return {
      sla:     findVal('sla'),
      waiting: findVal('queue') !== '--' ? findVal('queue') : '0',
      agents:  '--',
      info:    `${data.datasets.length} widget(s), ${tableCount} table(s)`,
    }
  },
}
