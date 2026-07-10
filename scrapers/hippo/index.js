// File: scrapers/hippo/index.js
// scrapers/hippo/index.js
// NICE inContact CXone dashboard scraper for the Hippo account.
//
// Ports the DOM-discovery logic proven in the "NICE inContact Dashboard Scraper"
// Chrome extension (content_iframe.js + signalr_interceptor.js) into a Node/
// Playwright scraper. Unlike the Five9 scrapers (perfectserve/uniters), this
// does NOT hardcode specific widget names/columns — NICE CXone dashboards are
// tenant-configurable, so widgets are discovered generically at scrape time:
//   - Any ag-Grid table  → one dataset per widget, named after its title
//   - Any HTML <table>   → same
//   - KPI tiles          → queue counters, SLA donut/legend widgets, generic
//                          text tiles — collected into one "KPI_Tiles" dataset
//
// LOGIN: manualLogin (see meta below). NICE CXone tenants commonly use SSO/MFA
// that can't be reliably scripted, so this scraper opens a VISIBLE browser,
// navigates to the dashboard URL, and WAITS. Log in by hand in that window,
// then in the scraper.js terminal run:
//     resume hippo
// The session is then persisted (sessions/hippo.json) so future restarts skip
// the manual step as long as that session is still valid.
//
// config.json entry:
//   { "id": "hippo", "dashboardUrl": "https://na1.nice-incontact.com/apps/#/dashboard/wrapper/dashboards" }
//   (adjust dashboardUrl if Hippo's tenant is on a different NICE CXone cluster)
//
// Supabase tables needed — see sql/hippo.sql (run once):
//   hippo_kpis      — label/value rows for KPI tiles (dynamic, no schema change needed per widget)
//   hippo_datasets  — JSONB headers/rows per discovered table widget (dynamic, no schema change needed)
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

// ── Supabase write helper (same pattern as perfectserve/uniters) ────────────
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
// forever. Tracks the ID set written last tick per table in memory; anything
// missing this tick gets deleted. First tick after a process restart has no
// baseline, so it never deletes anyone — only real future departures do.
const _lastSeenIds = new Map() // table -> Set<id>

async function pruneDeparted(table, currentIds) {
  const prevIds = _lastSeenIds.get(table) || new Set()
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

// ── Known widgets — promoted from the generic hippo_datasets JSONB blob to
// their own typed tables now that their real column shape is confirmed.
// Any widget NOT listed here still falls through to hippo_datasets/hippo_kpis
// generically, so a newly-appearing widget never breaks anything.
//
// `columns` maps the source header text (case-insensitive) → destination
// column name. Matched by header text, not position, so it stays correct
// even if NICE reorders the widget's columns.
const KNOWN_WIDGETS = {
  'licensed agents': {
    table: 'hippo_licensed_agents',
    idFrom: 'agent_name',
    columns: {
      'agent name':        'agent_name',
      'team name':         'team_name',
      'session time':      'session_time',
      'agent state':       'agent_state',
      'agent state time':  'agent_state_time',
    },
  },
  'level 1': {
    // Assumed identical to Licensed Agents (same "AGENT NAME" lead column) —
    // confirm and adjust if Level 1's actual headers differ.
    table: 'hippo_level_1',
    idFrom: 'agent_name',
    columns: {
      'agent name':        'agent_name',
      'team name':         'team_name',
      'session time':      'session_time',
      'agent state':       'agent_state',
      'agent state time':  'agent_state_time',
    },
  },
  // 'contact list': { table: 'hippo_contact_list', idFrom: '...', columns: { ... } },
  // ^ TODO: fill in once we have Contact List's actual headers/rows sample.
}

function colIndex(headers, headerName) {
  return headers.findIndex(h => String(h).trim().toLowerCase() === headerName)
}

// Map a dataset's rows into typed column objects using KNOWN_WIDGETS' header→column map.
function mapKnownWidgetRows(dataset, def, accountId, now) {
  const idxByCol = {}
  Object.entries(def.columns).forEach(([header, col]) => {
    idxByCol[col] = colIndex(dataset.headers, header)
  })
  return dataset.rows.map(row => {
    const out = { account_id: accountId, updated_at: now }
    Object.entries(idxByCol).forEach(([col, idx]) => { out[col] = idx >= 0 ? (row[idx] || '') : '' })
    out.id = `${accountId}:${sanitizeKey(dataset.name)}:${sanitizeKey(out[def.idFrom])}`
    return out
  })
}

// ── DOM scraping — ported from content_iframe.js + signalr_interceptor.js ───
// Runs inside page.evaluate() / frame.evaluate(). Has no access to Node.js
// scope — all helpers must be defined inline.
async function scrapeNiceDashboard(snapshotTime) {
  // ── Widget name extractor — strips live timestamps and counters ───────────
  function getWidgetName(element, fallbackIdx) {
    var ctx = element.closest(
      '.gridItem, gridster-item, li[class*="gridster"], [class*="widget-container"], cxone-dashboard-widget, [class*="dashboard-widget"], [class*="widgetContainer"]'
    ) || element

    var rawText = ''
    if (ctx) {
      var selectors = [
        '.gridItemHeader', '[class*="widget-title"]', '[class*="panel-title"]', '[class*="tile-title"]',
        '[class*="header-title"]', '[class*="widgetTitle"]', '[class*="widget-name"]',
        'h1', 'h2', 'h3', 'h4', 'h5', '.title', '[class*="title"]', '[class*="header"]'
      ]
      for (var s = 0; s < selectors.length; s++) {
        var el = ctx.querySelector(selectors[s])
        if (el) {
          rawText = el.innerText && el.innerText.trim()
          if (rawText) break
        }
      }
      if (!rawText) rawText = ctx.getAttribute && ctx.getAttribute('aria-label')
    }

    if (rawText && rawText.length > 0 && rawText.length < 100) {
      var cleaned = rawText
        .replace(/\s*\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?/gi, '')
        .replace(/\s*\(\d+\)\s*/g, '')
        .replace(/\s*\[\d+\]\s*/g, '')
        .replace(/[-_]\d{1,4}$/, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (cleaned) return cleaned
    }
    return 'Widget_Table_' + (fallbackIdx + 1)
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
        var text = ''
        var groupVal = cell.querySelector('.ag-group-value')
        if (groupVal) {
          text = groupVal.innerText && groupVal.innerText.trim()
        } else {
          text = cell.innerText && cell.innerText.trim().replace(/\s+/g, ' ')
        }
        if (!text) {
          text = cell.getAttribute('aria-label') ||
            (cell.querySelector('[aria-label]') && cell.querySelector('[aria-label]').getAttribute('aria-label')) ||
            (cell.querySelector('span[title]') && cell.querySelector('span[title]').getAttribute('title')) || ''
          text = text.trim()
        }
        rowData.push(text)
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
  // scrolled into view exists in the DOM — so a single static pass silently
  // misses/keeps-stale any agent scrolled out of view at the moment of that
  // scrape tick. Confirmed on ZenBusiness's identical setup; ported the fix
  // here too since the risk is the same.
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

  // ── Ag-Grid scraper ────────────────────────────────────────────────────────
  async function scrapeAgGrid(grid, name) {
    var headers = []

    grid.querySelectorAll('.ag-header-cell-text').forEach(function (cell) {
      headers.push((cell.innerText && cell.innerText.trim()) || '')
    })
    if (headers.length === 0 || headers.every(function (h) { return h === '' })) {
      headers = []
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

  // ── HTML table scraper ─────────────────────────────────────────────────────
  function scrapeHtmlTable(tbl, name) {
    var headers = []
    var rows = []
    var thRow = tbl.querySelector('thead tr, tr:first-child')
    if (thRow) {
      thRow.querySelectorAll('th, td').forEach(function (cell) {
        headers.push((cell.innerText && cell.innerText.trim()) || '')
      })
    }
    var tbody = tbl.querySelector('tbody') || tbl
    tbody.querySelectorAll('tr').forEach(function (row) {
      if (row.closest('thead')) return
      var cells = row.querySelectorAll('td, th')
      if (cells.length === 0) return
      var rowData = [snapshotTime]
      cells.forEach(function (cell) {
        rowData.push((cell.innerText && cell.innerText.trim().replace(/\s+/g, ' ')) || '')
      })
      if (rowData.slice(1).some(function (v) { return v !== '' })) rows.push(rowData)
    })
    if (rows.length === 0) return null
    return { name: name, headers: ['Snapshot Time'].concat(headers), rows: rows }
  }

  // ── All tables (ag-Grid + plain HTML) ──────────────────────────────────────
  async function scrapeAllTables() {
    var results = []
    var seenGrids = []
    var seenTables = []

    var gridCandidates = Array.from(document.querySelectorAll('.ag-root-wrapper'))
      .filter(function (grid) { return !(grid.parentElement && grid.parentElement.closest('.ag-root-wrapper')) })
    for (var g = 0; g < gridCandidates.length; g++) {
      var grid = gridCandidates[g]
      seenGrids.push(grid)
      var widgetName = getWidgetName(grid, seenGrids.length - 1)
      var result = await scrapeAgGrid(grid, widgetName)
      if (result && result.rows.length > 0) results.push(result)
    }

    document.querySelectorAll('table').forEach(function (tbl) {
      if (tbl.closest('.ag-root-wrapper')) return
      if (seenTables.indexOf(tbl) !== -1) return
      seenTables.push(tbl)
      var widgetName = getWidgetName(tbl, seenGrids.length + seenTables.length - 1)
      var result = scrapeHtmlTable(tbl, widgetName)
      if (result && result.rows.length > 0) results.push(result)
    })

    return results
  }

  // ── Tile scraper (KPI counters, queue, service level) ──────────────────────
  function scrapeTiles() {
    var rows = []
    var headers = ['Snapshot Time', 'Widget Name', 'Metric', 'Value']
    var seen = {}

    function addRow(wName, metric, val) {
      var key = wName + '|' + metric
      if (!seen[key]) { seen[key] = true; rows.push([snapshotTime, wName, metric, val]) }
    }

    var widgetSels = '.gridItem, gridster-item, li[class*="gridster"], [class*="widget-container"], cxone-dashboard-widget, [class*="dashboard-widget"]'
    var allWidgets = Array.from(document.querySelectorAll(widgetSels))
    var widgets = allWidgets.filter(function (w) {
      return !allWidgets.some(function (other) { return other !== w && w.contains(other) })
    })

    widgets.forEach(function (ctx, idx) {
      if (ctx.querySelector('.ag-root-wrapper, ag-grid-angular, table')) return
      var widgetName = getWidgetName(ctx, idx)

      var queueCountEl = ctx.querySelector('h2#bothInQueue, h2.queue-counter-info')
      var waitTimeEl = ctx.querySelector('h3#longestQueueTimeBoth, h3.queue-counter-info')
      if (queueCountEl) {
        var count = queueCountEl.innerText && queueCountEl.innerText.trim()
        var wait = waitTimeEl ? (waitTimeEl.innerText && waitTimeEl.innerText.trim()) : null
        if (count) addRow(widgetName, 'Contacts in Queue', count)
        if (wait) addRow(widgetName, 'Longest Wait Time', wait)
        return
      }

      var text = (ctx.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text) return

      if (text.indexOf('CONTACTS IN QUEUE') !== -1 || text.indexOf('Longest waiting time') !== -1) {
        var lines = (ctx.textContent || '').split(/[\n\r]+/).map(function (l) { return l.trim() }).filter(Boolean)
        var countLine = null, timeLine = null
        for (var l = 0; l < lines.length; l++) {
          if (!countLine && /^\d+$/.test(lines[l])) countLine = lines[l]
          if (!timeLine && /\d{1,2}:\d{2}:\d{2}/.test(lines[l])) timeLine = lines[l]
        }
        addRow(widgetName, 'Contacts in Queue', countLine || '0')
        if (timeLine) addRow(widgetName, 'Longest Wait Time', timeLine)
        return
      }

      if (ctx.querySelector('canvas[basechart], canvas[ng-reflect-labels], canvas')) {
        var allText = ctx.innerText || ''
        var inSlaMatch = allText.match(/In SLA\s*\((\d+)\)/i)
        var outSlaMatch = allText.match(/Out SLA\s*\((\d+)\)/i)
        var pctMatch = allText.match(/(\d{1,3}(?:\.\d{1,2})?)%/)
        if (inSlaMatch || outSlaMatch || pctMatch) {
          if (inSlaMatch) addRow(widgetName, 'In SLA', inSlaMatch[1])
          if (outSlaMatch) addRow(widgetName, 'Out SLA', outSlaMatch[1])
          if (pctMatch) addRow(widgetName, 'SLA %', pctMatch[1] + '%')
          return
        }
        return
      }

      if (text.length > 500) return
      var tileLines = (ctx.textContent || '').split(/[\n\r]+/).map(function (l) { return l.trim() }).filter(function (l) { return l.length > 0 && l.length < 100 })
      tileLines.forEach(function (line, i) {
        var metric = i === 0 ? widgetName : widgetName + ' (' + i + ')'
        addRow(widgetName, metric, line)
      })
    })

    return { name: 'KPI_Tiles', headers: headers, rows: rows }
  }

  // ── Angular/Chart.js SLA widget reader (ported from signalr_interceptor.js) ─
  // window.ng is only available when Angular is running in dev/debug mode on
  // this frame — works on some CXone tenants, silently yields [] on others
  // (the DOM-text fallback in scrapeTiles() above already covers those cases).
  function scrapeAngularSlaWidgets() {
    var results = []
    if (!window.ng || typeof window.ng.getOwningComponent !== 'function') return results
    var seenComps = new WeakSet()

    function resolveWidgetName(canvas, fallbackIdx) {
      try {
        var ctx = canvas.closest('gridster-item, .gridItem, [class*="widget-container"], cxone-dashboard-widget')
        if (ctx) {
          var nameEl = ctx.querySelector('span.overflowModuleName, [class*="widget-title"], [class*="tile-title"], h3, h4')
          var raw = nameEl ? (nameEl.innerText || '').trim() : ''
          if (raw && raw.length > 0 && raw.length < 120) {
            return raw.replace(/\s*\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?/gi, '').replace(/\s*\(\d+\)\s*/g, '').replace(/\s+/g, ' ').trim()
          }
        }
      } catch (_) {}
      return 'Service Level ' + (fallbackIdx + 1)
    }

    function processCanvas(canvas, fallbackIdx) {
      try {
        var comp = window.ng.getOwningComponent(canvas)
        if (!comp || seenComps.has(comp)) return
        seenComps.add(comp)
        var widgetName = resolveWidgetName(canvas, fallbackIdx)
        var cfg = comp.chartConfig

        if (cfg && cfg.data && Array.isArray(cfg.data.labels) && Array.isArray(cfg.data.datasets)) {
          var labels = cfg.data.labels
          var dataset = cfg.data.datasets[0]
          var dataArr = dataset && Array.isArray(dataset.data) ? dataset.data : []
          var outCount = null, inCount = null
          labels.forEach(function (label, i) {
            var lc = String(label).toLowerCase()
            if (lc.indexOf('out') !== -1) outCount = dataArr[i] != null ? Number(dataArr[i]) : null
            if (lc.indexOf('in') !== -1) inCount = dataArr[i] != null ? Number(dataArr[i]) : null
          })
          if (inCount !== null || outCount !== null) {
            var total = (inCount || 0) + (outCount || 0)
            if (total > 0) {
              var slaPct = ((inCount || 0) / total * 100).toFixed(2) + '%'
              results.push({ widgetName: widgetName, metric: 'SLA %', value: slaPct })
              results.push({ widgetName: widgetName, metric: 'In SLA', value: String(inCount != null ? inCount : 0) })
              results.push({ widgetName: widgetName, metric: 'Out SLA', value: String(outCount != null ? outCount : 0) })
              return
            }
          }
        }

        var centerText = cfg && cfg.options && cfg.options.elements && cfg.options.elements.center && cfg.options.elements.center.text
        if (centerText && String(centerText).trim().length > 0) {
          results.push({ widgetName: widgetName, metric: 'SLA %', value: String(centerText).trim() })
          return
        }

        if (comp.data) {
          var d = comp.data
          var outSla = d.OutService != null ? d.OutService : null
          var inSla = d.InService != null ? d.InService : null
          var svcLvl = d.ServiceLevel != null ? d.ServiceLevel : null
          if (outSla !== null || inSla !== null) {
            var pct = svcLvl !== null ? (svcLvl * 100).toFixed(2) + '%'
              : (inSla !== null && outSla !== null && (inSla + outSla) > 0) ? (inSla / (inSla + outSla) * 100).toFixed(2) + '%' : 'N/A'
            results.push({ widgetName: widgetName, metric: 'SLA %', value: pct })
            results.push({ widgetName: widgetName, metric: 'In SLA', value: String(inSla != null ? inSla : 'N/A') })
            results.push({ widgetName: widgetName, metric: 'Out SLA', value: String(outSla != null ? outSla : 'N/A') })
          }
        }
      } catch (err) { /* non-fatal */ }
    }

    function searchShadows(root, depth) {
      if (depth > 5) return
      try {
        root.querySelectorAll('canvas[basechart]').forEach(function (canvas, i) { processCanvas(canvas, i) })
        root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) searchShadows(el.shadowRoot, depth + 1) })
      } catch (_) {}
    }
    try { searchShadows(document, 0) } catch (_) {}
    return results
  }

  // ── Assemble: tables + tiles, merging Angular SLA data into KPI_Tiles ───────
  var results = await scrapeAllTables()
  var tiles = scrapeTiles()
  var slaResults = scrapeAngularSlaWidgets()

  slaResults.forEach(function (r) {
    if (r.value === 'N/A' || r.value === '') {
      var alreadyValid = tiles.rows.some(function (existingRow) {
        return existingRow[1] === r.widgetName && existingRow[2] === r.metric && existingRow[3] !== 'N/A' && existingRow[3] !== ''
      })
      if (alreadyValid) return
    }
    var dupe = tiles.rows.some(function (row) { return row[1] === r.widgetName && row[2] === r.metric })
    if (!dupe) tiles.rows.push([snapshotTime, r.widgetName, r.metric, r.value])
  })

  if (tiles.rows.length > 0) results.push(tiles)
  return results
}

// ── Keep-alive — ported from content_main.js (simulateUserActivity/idle guard)
// and content_iframe.js (ClearView-specific mousemove/pointermove + "Dashboard
// Paused" overlay auto-dismiss). Runs inside page.evaluate()/frame.evaluate();
// self-contained, no outer scope. Installs the MutationObserver guard once
// (idempotent via a window flag) and fires synthetic activity every call.
function keepDashboardAlive() {
  try {
    var cx = Math.round((window.innerWidth || 800) / 2)
    var cy = Math.round((window.innerHeight || 600) / 2)

    // ClearView's OWN 20-min timer watches mousemove/pointermove specifically
    // (confirmed by the "Move your cursor to resume updates" message).
    var moveOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, screenX: cx, screenY: cy, movementX: 2, movementY: 0 }
    document.dispatchEvent(new MouseEvent('mousemove', moveOpts))
    document.dispatchEvent(new PointerEvent('pointermove', moveOpts))
    if (document.body) {
      document.body.dispatchEvent(new MouseEvent('mousemove', moveOpts))
      document.body.dispatchEvent(new PointerEvent('pointermove', moveOpts))
    }

    // The main Angular idle service (session-level, separate timer) listens
    // for pointerdown/pointerup/mousedown/keydown on document and
    // keypress/keyup/click/scroll on window — NOT mousemove.
    var clickOpts = { bubbles: false, cancelable: true, clientX: 1, clientY: 1 }
    document.dispatchEvent(new PointerEvent('pointerdown', clickOpts))
    document.dispatchEvent(new PointerEvent('pointerup', clickOpts))
    document.dispatchEvent(new MouseEvent('mousedown', clickOpts))
    var keyOpts = { bubbles: false, cancelable: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true }
    document.dispatchEvent(new KeyboardEvent('keydown', keyOpts))
    window.dispatchEvent(new KeyboardEvent('keypress', keyOpts))
    window.dispatchEvent(new KeyboardEvent('keyup', keyOpts))
  } catch (e) { /* non-fatal */ }

  function fireActivity() {
    try {
      var cx = Math.round((window.innerWidth || 800) / 2)
      var cy = Math.round((window.innerHeight || 600) / 2)
      var opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, screenX: cx, screenY: cy, movementX: 2, movementY: 0 }
      document.dispatchEvent(new MouseEvent('mousemove', opts))
      document.dispatchEvent(new PointerEvent('pointermove', opts))
      if (document.body) {
        document.body.dispatchEvent(new MouseEvent('mousemove', opts))
        document.body.dispatchEvent(new PointerEvent('pointermove', opts))
      }
    } catch (e) {}
  }

  var PAUSE_RE = /dashboard.{0,10}paused|move your cursor.{0,30}resume|paused due to.{0,30}inactiv|still there|are you still|session.*expir|timed.?out/i

  function dismissPausedNode(node) {
    fireActivity()
    setTimeout(fireActivity, 150)
    setTimeout(fireActivity, 400)
    setTimeout(function () {
      try {
        var closeSelectors = [
          'button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]',
          '[class*="close"]', '[class*="dismiss"]', 'button.close',
          '.modal-close', '[data-dismiss]',
        ]
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

  // Immediate pass — catches a modal that's ALREADY on screen (a
  // MutationObserver only sees future DOM changes, not the current state).
  try {
    if (document.body && PAUSE_RE.test(document.body.innerText || '')) {
      var candidates = document.querySelectorAll('[class*="modal"], [class*="dialog"], [role="dialog"], [role="alertdialog"]')
      var matched = false
      for (var c = 0; c < candidates.length; c++) {
        if (PAUSE_RE.test(candidates[c].innerText || candidates[c].textContent || '')) {
          dismissPausedNode(candidates[c])
          matched = true
        }
      }
      if (!matched) dismissPausedNode(document.body)
    }
  } catch (e) {}

  if (window.__hippoPauseGuardActive) return
  window.__hippoPauseGuardActive = true

  try {
    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes
        for (var n = 0; n < added.length; n++) {
          var node = added[n]
          if (node.nodeType !== 1) continue
          var text = node.innerText || node.textContent || ''
          if (!PAUSE_RE.test(text)) continue
          dismissPausedNode(node)
        }
      }
    })
    if (document.body) observer.observe(document.body, { childList: true, subtree: true })
  } catch (e) {}
}

// ── Write to Supabase ─────────────────────────────────────────────────────────
async function writeHippoData(datasets, accountId) {
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
    await supabaseUpsert('hippo_kpis', kpiRows)
    console.log(`[hippo] ✅ KPIs written (${kpiRows.length})`)
  }

  const allTableDatasets = datasets.filter(d => d.name !== 'KPI_Tiles')

  // ── Known widgets → dedicated typed tables ─────────────────────────────────
  const genericDatasets = []
  for (const d of allTableDatasets) {
    const def = KNOWN_WIDGETS[d.name.trim().toLowerCase()]
    if (!def) { genericDatasets.push(d); continue }
    const rows = mapKnownWidgetRows(d, def, accountId, now)
    // Postgres rejects the whole upsert batch if the same id appears twice
    // in it — dedup (last one wins) so one bad/duplicate row can't take
    // down the entire write.
    const dedupMap = new Map()
    rows.forEach(r => dedupMap.set(r.id, r))
    const dedupedRows = [...dedupMap.values()]
    if (dedupedRows.length < rows.length) {
      console.warn(`[hippo] ⚠ Dropped ${rows.length - dedupedRows.length} duplicate-id row(s) before writing ${def.table}`)
    }
    await pruneDeparted(def.table, new Set(dedupedRows.map(r => r.id)))
    if (dedupedRows.length > 0) {
      await supabaseUpsert(def.table, dedupedRows)
      console.log(`[hippo] ✅ ${d.name} → ${def.table} (${dedupedRows.length} row(s))`)
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
    await supabaseUpsert('hippo_datasets', rows)
    console.log(`[hippo] ✅ Datasets written (${rows.length} table(s): ${genericDatasets.map(d => d.name).join(', ')})`)
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  meta: {
    type:        'NICE CXone',
    interval:    30000,
    manualLogin: true,   // see lib/account-runner.js — waits for `resume hippo`
  },

  // ── Login: manual — just navigate and wait for the human ─────────────────────
  async login(page, context, account, sessionPath) {
    const url = account.dashboardUrl || 'https://na1.nice-incontact.com/apps/#/dashboard/wrapper/dashboards'
    console.log(`[hippo] Navigating to ${url} (manual login required)...`)
    page.on('pageerror', err => console.warn(`[hippo page error] ${err.message}`))
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.warn(`[hippo] goto failed (will still wait for manual login): ${e.message}`)
    })
  },

  // ── Session-expiry check — drives the manual-login gate ──────────────────────
  // TODO: once you've seen Hippo's actual login/SSO page, tighten this pattern
  // (e.g. add the exact hostname it redirects to).
  isSessionExpired(page) {
    const url = page.url()
    if (/login|signin|sso|auth0|okta|identity/i.test(url)) return true
    // No obvious login redirect — but also confirm the dashboard actually has
    // widgets, in case it silently landed on a blank/error page.
    return false
  },

  // ── Scrape: discover whatever widgets currently exist ─────────────────────────
  async scrape(page, account) {
    try {
      const snapshotTime = new Date().toISOString()
      const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())]

      // Simulate activity + install the "Dashboard Paused" auto-dismiss guard
      // on every tick (every 30s — well under the 20-min ClearView timeout).
      for (const frame of frames) {
        try { await frame.evaluate(keepDashboardAlive) } catch (_) {}
      }

      let datasets = []
      for (const frame of frames) {
        try {
          const result = await frame.evaluate(scrapeNiceDashboard, snapshotTime)
          if (result && result.length) datasets.push(...result)
        } catch (_) { /* cross-origin or detached frame — skip */ }
      }

      // Merge KPI_Tiles datasets from multiple frames into one; keep table
      // datasets separate (dedup by name, first-seen wins)
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
      console.error(`[hippo] scrape error:`, err.message)
      return null
    }
  },

  // ── Write to Supabase ──────────────────────────────────────────────────────
  async write(data, accountId) {
    if (!data || !data.hasData) return
    await writeHippoData(data.datasets, accountId)
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
