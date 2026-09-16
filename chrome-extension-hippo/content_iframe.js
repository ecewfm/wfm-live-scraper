// content_iframe.js — Hippo Dashboard Scraper (WFM Live)
// Carried over unchanged from the original NICE inContact Dashboard Scraper
// extension — this file only does DOM discovery/scraping, it has no
// knowledge of where the data ends up (Drive vs Supabase), so nothing here
// needed to change for the Hippo/Supabase conversion.
// ─────────────────────────────────────────────────────────────────────────────
// Injected into BOTH the top window (SPA dashboard) AND any cross-origin iframes.
// Works on top window with no iframes (pure SPA layout).
// Deduplicates widget containers (filters out ancestor containers).
// Removes timestamps/counters from widget names for stable filenames.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  if (window.__niceIframeContentActive) return;
  window.__niceIframeContentActive = true;

  // ── Inject the page-context interceptor script ─────────────────────────────
  function injectPageScript() {
    try {
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL('signalr_interceptor.js');
      s.onload = function() { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPageScript);
  } else {
    injectPageScript();
  }

  // ── Listen for KPI messages from injected page script ──────────────────────
  var lastEmitTime = 0;
  var EMIT_THROTTLE_MS = 500;

  window.addEventListener('message', function (e) {
    if (!e.data || !e.data.__niceKpi) return;

    var now = Date.now();
    if (now - lastEmitTime < EMIT_THROTTLE_MS) return;
    lastEmitTime = now;

    var payload = e.data.payload;
    if (!payload || !payload.kpis) return;

    safeSendMessage({
      type: 'NICE_KPI_UPDATE',
      kpis: payload.kpis,
      raw:  payload.rawMessages ? payload.rawMessages.slice(-5) : [],
      time: payload.lastUpdate || new Date().toISOString(),
    });
  });

  // ── Listen for DOM-scrape requests ──────────────────────────────────────────
  // Works whether this script is in the top window or a same-origin iframe.
  // content_main.js sends to window (top) AND all iframes — we handle it here.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'NICE_REQUEST_DOM_SCRAPE') return;

    var snapshotTime = e.data.snapshotTime || new Date().toISOString();
    var datasets = scrapeEverything(snapshotTime);

    // Request SLA data from the page-context interceptor (has access to window.ng)
    var slaReceived = false;

    var slaHandler = function (ev) {
      if (!ev.data || ev.data.type !== 'NICE_SLA_SCRAPE_RESULT') return;
      slaReceived = true;
      window.removeEventListener('message', slaHandler);

      var slaResults = ev.data.slaResults || [];
      if (slaResults.length > 0) {
        var tileDataset = null;
        for (var i = 0; i < datasets.length; i++) {
          if (datasets[i].name === 'KPI_Tiles') { tileDataset = datasets[i]; break; }
        }
        if (!tileDataset) {
          tileDataset = {
            name: 'KPI_Tiles',
            headers: ['Snapshot Time', 'Widget Name', 'Metric', 'Value'],
            rows: [],
          };
          datasets.push(tileDataset);
        }
        slaResults.forEach(function(r) {
          // Guard: if the Angular component returned 'N/A' or empty (chart still
          // initialising after a refresh), check whether scrapeTiles() already
          // captured a valid reading from the DOM legend text. If so, keep that
          // value instead of appending a stale N/A that would corrupt the data.
          if (r.value === 'N/A' || r.value === '') {
            var alreadyValid = tileDataset.rows.some(function(existingRow) {
              return existingRow[1] === r.widgetName &&
                     existingRow[2] === r.metric &&
                     existingRow[3] !== 'N/A' &&
                     existingRow[3] !== '';
            });
            if (alreadyValid) return; // keep the DOM-scraped value, skip this N/A
          }
          tileDataset.rows.push([snapshotTime, r.widgetName, r.metric, r.value]);
        });
      }

      // Reply to whoever sent the request.
      // If we are the top window, post to self (content_main.js listener picks it up).
      // If we are an iframe, post to parent (top).
      var target = (window === window.top) ? window : window.top;
      try { target.postMessage({ type: 'NICE_DOM_SCRAPE_RESULT', datasets: datasets }, '*'); } catch (_) {}
    };

    window.addEventListener('message', slaHandler);
    window.postMessage({ type: 'NICE_REQUEST_SLA_SCRAPE', snapshotTime: snapshotTime }, '*');

    // Fallback: send results after 800ms even if no SLA reply
    setTimeout(function () {
      if (slaReceived) return;
      window.removeEventListener('message', slaHandler);
      var target = (window === window.top) ? window : window.top;
      try { target.postMessage({ type: 'NICE_DOM_SCRAPE_RESULT', datasets: datasets }, '*'); } catch (_) {}
    }, 800);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DOM SCRAPER
  // ─────────────────────────────────────────────────────────────────────────

  function scrapeEverything(snapshotTime) {
    var results = [];
    var tables = scrapeAllTables(snapshotTime);
    results.push.apply(results, tables);
    var tiles = scrapeTiles(snapshotTime);
    if (tiles && tiles.rows.length > 0) results.push(tiles);
    return results;
  }

  // ── Tables ──────────────────────────────────────────────────────────────────
  function scrapeAllTables(snapshotTime) {
    var results = [];
    var seenGrids = [];
    var seenTables = [];

    // 1. Ag-Grids
    var allGrids = document.querySelectorAll('.ag-root-wrapper');
    allGrids.forEach(function(grid) {
      // Skip grids that are nested inside another ag-root-wrapper
      if (grid.parentElement && grid.parentElement.closest('.ag-root-wrapper')) return;
      if (seenGrids.indexOf(grid) !== -1) return;
      seenGrids.push(grid);

      var widgetName = getWidgetName(grid, seenGrids.length - 1);
      var result = scrapeAgGrid(grid, snapshotTime, widgetName);
      if (result && result.rows.length > 0) results.push(result);
    });

    // 2. Standard HTML tables (not inside ag-grids)
    var allTables = document.querySelectorAll('table');
    allTables.forEach(function(tbl) {
      if (tbl.closest('.ag-root-wrapper')) return;
      if (seenTables.indexOf(tbl) !== -1) return;
      seenTables.push(tbl);

      var widgetName = getWidgetName(tbl, seenGrids.length + seenTables.length - 1);
      var result = scrapeHtmlTable(tbl, snapshotTime, widgetName);
      if (result && result.rows.length > 0) results.push(result);
    });

    return results;
  }

  // ── Widget name extractor — strips live timestamps and counters ────────────
  function getWidgetName(element, fallbackIdx) {
    // Walk up to the nearest recognised widget container
    var ctx = element.closest(
      '.gridItem, gridster-item, li[class*="gridster"], [class*="widget-container"], cxone-dashboard-widget, [class*="dashboard-widget"], [class*="widgetContainer"]'
    ) || element;

    var rawText = '';

    if (ctx) {
      var selectors = [
        '.gridItemHeader', '[class*="widget-title"]', '[class*="panel-title"]', '[class*="tile-title"]',
        '[class*="header-title"]', '[class*="widgetTitle"]', '[class*="widget-name"]',
        'h1', 'h2', 'h3', 'h4', 'h5', '.title', '[class*="title"]', '[class*="header"]'
      ];

      for (var s = 0; s < selectors.length; s++) {
        var el = ctx.querySelector(selectors[s]);
        if (el) {
          rawText = el.innerText && el.innerText.trim();
          if (rawText) break;
        }
      }

      if (!rawText) {
        rawText = ctx.getAttribute && ctx.getAttribute('aria-label');
      }
    }

    if (rawText && rawText.length > 0 && rawText.length < 100) {
      var cleaned = rawText
        .replace(/\s*\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?/gi, '') // HH:MM:SS AM/PM
        .replace(/\s*\(\d+\)\s*/g, '')                              // (123)
        .replace(/\s*\[\d+\]\s*/g, '')                              // [123]
        .replace(/[-_]\d{1,4}$/, '')                                // trailing -123
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) return cleaned;
    }

    return 'Widget_Table_' + (fallbackIdx + 1);
  }

  // ── Ag-Grid scraper ──────────────────────────────────────────────────────────
  function scrapeAgGrid(grid, snapshotTime, name) {
    var headers = [];
    var rows = [];

    grid.querySelectorAll('.ag-header-cell-text').forEach(function(cell) {
      headers.push(cell.innerText && cell.innerText.trim() || '');
    });

    if (headers.length === 0 || headers.every(function(h) { return h === ''; })) {
      headers = [];
      grid.querySelectorAll('.ag-header-cell').forEach(function(cell) {
        var colId = cell.getAttribute('col-id') || '';
        var text = (cell.innerText && cell.innerText.trim()) || colId;
        if (text) headers.push(text);
      });
    }

    grid.querySelectorAll('.ag-row:not(.ag-hidden)').forEach(function(row) {
      var cells = row.querySelectorAll('.ag-cell');
      if (cells.length === 0) return;

      var rowData = [snapshotTime];
      cells.forEach(function(cell) {
        var text = '';
        var groupVal = cell.querySelector('.ag-group-value');
        if (groupVal) {
          text = groupVal.innerText && groupVal.innerText.trim();
        } else {
          text = cell.innerText && cell.innerText.trim().replace(/\s+/g, ' ');
        }
        if (!text) {
          text = cell.getAttribute('aria-label') ||
                 (cell.querySelector('[aria-label]') && cell.querySelector('[aria-label]').getAttribute('aria-label')) ||
                 (cell.querySelector('span[title]') && cell.querySelector('span[title]').getAttribute('title')) || '';
          text = text.trim();
        }
        rowData.push(text);
      });

      if (rowData.slice(1).some(function(v) { return v !== ''; })) {
        rows.push(rowData);
      }
    });

    if (rows.length === 0) return null;
    return { name: name, headers: ['Snapshot Time'].concat(headers), rows: rows };
  }

  // ── HTML table scraper ────────────────────────────────────────────────────────
  function scrapeHtmlTable(tbl, snapshotTime, name) {
    var headers = [];
    var rows = [];

    var thRow = tbl.querySelector('thead tr, tr:first-child');
    if (thRow) {
      thRow.querySelectorAll('th, td').forEach(function(cell) {
        headers.push(cell.innerText && cell.innerText.trim() || '');
      });
    }

    var tbody = tbl.querySelector('tbody') || tbl;
    tbody.querySelectorAll('tr').forEach(function(row) {
      if (row.closest('thead')) return;
      var cells = row.querySelectorAll('td, th');
      if (cells.length === 0) return;

      var rowData = [snapshotTime];
      cells.forEach(function(cell) {
        rowData.push(cell.innerText && cell.innerText.trim().replace(/\s+/g, ' ') || '');
      });

      if (rowData.slice(1).some(function(v) { return v !== ''; })) {
        rows.push(rowData);
      }
    });

    if (rows.length === 0) return null;
    return { name: name, headers: ['Snapshot Time'].concat(headers), rows: rows };
  }

  // ── Tile scraper (KPI counters, queue, service level) ──────────────────────
  function scrapeTiles(snapshotTime) {
    var rows = [];
    var headers = ['Snapshot Time', 'Widget Name', 'Metric', 'Value'];
    var seen = {};

    function addRow(wName, metric, val) {
      var key = wName + '|' + metric;
      if (!seen[key]) {
        seen[key] = true;
        rows.push([snapshotTime, wName, metric, val]);
      }
    }

    var widgetSels = '.gridItem, gridster-item, li[class*="gridster"], [class*="widget-container"], cxone-dashboard-widget, [class*="dashboard-widget"]';
    var allWidgets = Array.from(document.querySelectorAll(widgetSels));

    // Deduplicate: remove any container that contains another matched container
    // (keeps the innermost one so we don't double-count)
    var widgets = allWidgets.filter(function(w) {
      return !allWidgets.some(function(other) {
        return other !== w && w.contains(other);
      });
    });

    widgets.forEach(function(ctx, idx) {
      if (ctx.querySelector('.ag-root-wrapper, ag-grid-angular, table')) return;

      var widgetName = getWidgetName(ctx, idx);

      // ── Queue Counter widget ────────────────────────────────────────────────
      // Hippo-confirmed: h2#bothInQueue = count, h3#longestQueueTimeBoth = wait
      // Also handles generic text-based queue counter as fallback.
      var queueCountEl = ctx.querySelector('h2#bothInQueue, h2.queue-counter-info');
      var waitTimeEl   = ctx.querySelector('h3#longestQueueTimeBoth, h3.queue-counter-info');

      if (queueCountEl) {
        var count = queueCountEl.innerText && queueCountEl.innerText.trim();
        var wait  = waitTimeEl ? (waitTimeEl.innerText && waitTimeEl.innerText.trim()) : null;
        if (count) addRow(widgetName, 'Contacts in Queue', count);
        if (wait)  addRow(widgetName, 'Longest Wait Time', wait);
        return;
      }

      var text = (ctx.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;

      // Generic text-based queue counter fallback
      if (text.indexOf('CONTACTS IN QUEUE') !== -1 || text.indexOf('Longest waiting time') !== -1) {
        var lines = (ctx.textContent || '').split(/[\n\r]+/).map(function(l) { return l.trim(); }).filter(Boolean);
        var countLine = null, timeLine = null;
        for (var l = 0; l < lines.length; l++) {
          if (!countLine && /^\d+$/.test(lines[l])) countLine = lines[l];
          if (!timeLine && /\d{1,2}:\d{2}:\d{2}/.test(lines[l])) timeLine = lines[l];
        }
        addRow(widgetName, 'Contacts in Queue', countLine || '0');
        if (timeLine) addRow(widgetName, 'Longest Wait Time', timeLine);
        return;
      }

      // ── SLA / Canvas widget ─────────────────────────────────────────────────
      // Hippo-confirmed: window.ng is NOT available on this frame so Angular
      // component data cannot be read via getOwningComponent().
      // Instead scrape the legend text NICE renders beside the donut chart:
      //   "Out SLA (42)"  →  Out SLA count
      //   "In SLA (373)"  →  In SLA count
      //   "89.88%"        →  SLA percentage
      if (ctx.querySelector('canvas[basechart], canvas[ng-reflect-labels], canvas')) {
        var allText = ctx.innerText || '';
        var inSlaMatch  = allText.match(/In SLA\s*\((\d+)\)/i);
        var outSlaMatch = allText.match(/Out SLA\s*\((\d+)\)/i);
        var pctMatch    = allText.match(/(\d{1,3}(?:\.\d{1,2})?)%/);

        if (inSlaMatch || outSlaMatch || pctMatch) {
          if (inSlaMatch)  addRow(widgetName, 'In SLA',  inSlaMatch[1]);
          if (outSlaMatch) addRow(widgetName, 'Out SLA', outSlaMatch[1]);
          if (pctMatch)    addRow(widgetName, 'SLA %',   pctMatch[1] + '%');
          return;
        }
        // Canvas with no readable text — skip
        return;
      }

      // ── Generic tiles — skip very long blobs ───────────────────────────────
      if (text.length > 500) return;

      var tileLines = (ctx.textContent || '')
        .split(/[\n\r]+/)
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l.length > 0 && l.length < 100; });

      tileLines.forEach(function(line, i) {
        var metric = i === 0 ? widgetName : widgetName + ' (' + i + ')';
        addRow(widgetName, metric, line);
      });
    });

    return { name: 'KPI_Tiles', headers: headers, rows: rows };
  }

  // ── Safe message sender ──────────────────────────────────────────────────────
  function safeSendMessage(msg) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg, function() {
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLEARVIEW DASHBOARD KEEP-ALIVE
  //
  // The ClearView iframe (dashboard2-na1 / dashboard-na1) has its OWN
  // separate 20-minute inactivity timer that is completely independent of
  // the Angular session idle on the top frame. It watches for mousemove /
  // pointermove events inside the iframe — confirmed by the pause message:
  // "Move your cursor to resume updates."
  //
  // content_main.js only runs on the top frame and cannot reach this.
  // This keepalive runs inside the iframe itself via content_iframe.js.
  //
  // STRATEGY:
  //   1. Every 5 minutes dispatch mousemove + pointermove on this frame's
  //      document so the ClearView timer never reaches 20 minutes.
  //   2. MutationObserver safety net: if the "Dashboard Paused" overlay
  //      appears anyway (e.g. tab was backgrounded), immediately fire the
  //      same events to resume it, then click the close button.
  // ─────────────────────────────────────────────────────────────────────────

  var CLEARVIEW_KEEPALIVE_MS = 5 * 60 * 1000; // 5 min  <<  20 min threshold
  var clearviewKeepAliveTimer = null;

  function fireClearViewActivity() {
    try {
      var cx = Math.round((window.innerWidth  || 800) / 2);
      var cy = Math.round((window.innerHeight || 600) / 2);
      var opts = {
        bubbles: true, cancelable: true,
        clientX: cx, clientY: cy,
        screenX: cx, screenY: cy,
        movementX: 2, movementY: 0   // non-zero movement required by some trackers
      };
      // Fire on document so all listeners at any level receive it
      document.dispatchEvent(new MouseEvent('mousemove',     opts));
      document.dispatchEvent(new PointerEvent('pointermove', opts));
      // Also dispatch on body as some libraries attach there instead
      if (document.body) {
        document.body.dispatchEvent(new MouseEvent('mousemove',     opts));
        document.body.dispatchEvent(new PointerEvent('pointermove', opts));
      }
    } catch (e) { /* non-fatal */ }
  }

  function startClearViewKeepAlive() {
    if (clearviewKeepAliveTimer) return;
    // Fire immediately so the timer resets from the moment the script loads
    fireClearViewActivity();
    clearviewKeepAliveTimer = setInterval(function() {
      fireClearViewActivity();
    }, CLEARVIEW_KEEPALIVE_MS);
    console.log('[Hippo iframe] ClearView keep-alive started (every', CLEARVIEW_KEEPALIVE_MS / 60000, 'min)');
  }

  // Safety net: detect "Dashboard Paused" overlay and auto-resume
  function setupDashboardPauseGuard() {
    if (!document.body) return;
    var pauseObserver = new MutationObserver(function(mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          var text = node.innerText || node.textContent || '';
          if (!/dashboard.{0,10}paused|move your cursor.{0,30}resume|paused due to.{0,30}inactiv/i.test(text)) continue;

          console.warn('[Hippo iframe] "Dashboard Paused" overlay detected — auto-resuming');

          // Fire activity three times with staggered delays so movement delta is non-zero
          fireClearViewActivity();
          setTimeout(function() { fireClearViewActivity(); }, 150);
          setTimeout(function() { fireClearViewActivity(); }, 400);

          // Also click the close (x) button if one is present
          setTimeout(function() {
            try {
              var closeSelectors = [
                'button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]',
                '[class*="close"]', '[class*="dismiss"]', 'button.close',
                '.modal-close', '[data-dismiss]'
              ];
              var clicked = false;
              for (var s = 0; s < closeSelectors.length; s++) {
                var btn = node.querySelector(closeSelectors[s]);
                if (btn) { btn.click(); clicked = true; break; }
              }
              // Last resort: first button in the dialog
              if (!clicked) {
                var anyBtn = node.querySelector('button');
                if (anyBtn) anyBtn.click();
              }
            } catch (e) {}
          }, 500);
        }
      }
    });
    pauseObserver.observe(document.body, { childList: true, subtree: true });
    console.log('[Hippo iframe] Dashboard Pause guard active');
  }

  // Initialise — wait for DOMContentLoaded because this script runs at document_start
  function initClearViewKeepAlive() {
    startClearViewKeepAlive();
    setupDashboardPauseGuard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initClearViewKeepAlive);
  } else {
    // document already ready (injected at document_idle into top frame)
    initClearViewKeepAlive();
  }

})();
