// signalr_interceptor.js — Hippo Dashboard Scraper (WFM Live)
// Carried over unchanged from the original NICE inContact Dashboard Scraper
// extension. Runs in the PAGE CONTEXT (not the isolated content-script
// world), so it can reach window.ng for the Angular SLA widget read — that's
// the only reason this file exists separately from content_iframe.js.
// ─────────────────────────────────────────────────────────────────────────────
// Injected into the NICE inContact dashboard page context via a <script> tag
// (web_accessible_resources). Runs BEFORE the page JS so it can patch:
//   1. jQuery SignalR hub callbacks (ClearViewHub, DashboardHub, etc.)
//   2. WebSocket messages (fallback for non-SignalR transports)
//   3. Fetch / XHR calls returning KPI JSON (snapshot / REST fallback)
//
// Captured data is posted to the CONTENT SCRIPT world via:
//   window.postMessage({ __niceKpi: true, payload: {...} }, '*')
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  if (window.__niceInterceptorActive) return;
  window.__niceInterceptorActive = true;

  // ── Accumulated KPI state ────────────────────────────────────────────────────
  const state = {
    kpis: {},          // tileId / metricKey → { label, value, raw, color, tileType }
    rawMessages: [],   // last 50 raw hub payloads for debugging
    signalRAttached: false,
    wsAttached: false,
    lastUpdate: null,
  };

  function emit() {
    state.lastUpdate = new Date().toISOString();
    window.postMessage({ __niceKpi: true, payload: JSON.parse(JSON.stringify(state)) }, '*');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function storeRaw(src, data) {
    state.rawMessages.push({ src, data, t: Date.now() });
    if (state.rawMessages.length > 50) state.rawMessages.shift();
  }

  function processHubPayload(src, payload) {
    if (!payload || typeof payload !== 'object') return;
    storeRaw(src, payload);

    // ── Handle tile/widget updates ─────────────────────────────────────────────
    // NICE ClearView hub sends objects with various shapes depending on version.
    // We normalise them all into state.kpis[key] = { label, value, raw, color }

    // Shape A: { widgets: [ { id, title, currentValue, thresholdColor, ... } ] }
    if (Array.isArray(payload.widgets)) {
      payload.widgets.forEach(w => parseWidget(w));
      emit();
      return;
    }

    // Shape B: { data: [ { widgetId, metricValue, ... } ] }
    if (Array.isArray(payload.data)) {
      payload.data.forEach(d => parseDataItem(d));
      emit();
      return;
    }

    // Shape C: { widgetId, metricValue, label, thresholdColor }
    if (payload.widgetId !== undefined || payload.tileId !== undefined) {
      parseWidget(payload);
      emit();
      return;
    }

    // Shape D: array of widget objects (top-level array)
    if (Array.isArray(payload)) {
      payload.forEach(item => {
        if (typeof item === 'object' && item !== null) parseWidget(item);
      });
      emit();
      return;
    }

    // Shape E: flat key→value map  { "Calls In Queue": 4, "SLA": "92%" … }
    if (typeof payload === 'object') {
      let changed = false;
      Object.entries(payload).forEach(([k, v]) => {
        if (typeof v === 'number' || typeof v === 'string') {
          state.kpis[k] = { label: k, value: String(v), raw: v };
          changed = true;
        }
      });
      if (changed) emit();
    }
  }

  function parseWidget(w) {
    if (!w || typeof w !== 'object') return;

    // Try to derive a stable key
    const id = w.widgetId || w.tileId || w.id || w.reportingId || null;

    // Title / label — various property names used across versions
    const label =
      w.title || w.header || w.name || w.metricName || w.displayName || w.label ||
      (id ? 'Tile_' + id : 'unknown');

    // Value — formatted display value preferred; fall back to raw numbers
    const displayVal =
      w.currentValue  !== undefined ? w.currentValue  :
      w.metricValue   !== undefined ? w.metricValue   :
      w.value         !== undefined ? w.value         :
      w.formattedValue !== undefined ? w.formattedValue : null;

    if (displayVal === null && id === null) return; // nothing useful

    const key = id ? String(id) : label;
    state.kpis[key] = {
      label:     label,
      value:     displayVal !== null ? String(displayVal) : '',
      raw:       displayVal,
      color:     w.thresholdColor || w.color || w.statusColor || null,
      tileType:  w.tileType || w.widgetType || w.type || null,
      entityId:  w.entityId || w.skillId || w.agentId || null,
    };
  }

  function parseDataItem(d) {
    if (!d || typeof d !== 'object') return;
    const key   = d.widgetId || d.tileId || d.metricName || d.label || 'item_' + Date.now();
    const label = d.label || d.metricName || d.title || String(key);
    const value = d.metricValue !== undefined ? d.metricValue : d.value;
    state.kpis[String(key)] = {
      label: label,
      value: value !== undefined ? String(value) : '',
      raw:   value,
      color: d.thresholdColor || d.color || null,
    };
  }

  // ── 1. Patch SignalR (jQuery $.connection) ─────────────────────────────────
  // SignalR hubs are registered on $.connection after the script loads.
  // We poll until jQuery + SignalR are available, then wrap the hub's
  // received callbacks.

  const SIGNALR_POLL_MS  = 250;
  const SIGNALR_POLL_MAX = 240; // 60 s
  let   signalRPollCount = 0;

  const KNOWN_HUBS = [
    'clearViewHub', 'dashboardHub', 'cVHub', 'cvHub', 'liveDataHub',
    'agentStatusHub', 'statisticsHub', 'notificationHub',
  ];

  function tryAttachSignalR() {
    const jq = window.jQuery || window.$;
    if (!jq || !jq.connection) {
      signalRPollCount++;
      if (signalRPollCount < SIGNALR_POLL_MAX) {
        setTimeout(tryAttachSignalR, SIGNALR_POLL_MS);
      } else {
        console.warn('[Hippo Interceptor] SignalR not found after 60s — falling back to WS/XHR intercept only');
      }
      return;
    }

    // Attach to ALL registered hubs
    const conn  = jq.connection;
    const hubNames = Object.keys(conn).filter(k => k !== 'hub' && typeof conn[k] === 'object' && conn[k] !== null);
    const targets  = hubNames.length ? hubNames : KNOWN_HUBS;

    targets.forEach(hubName => {
      const hub = conn[hubName];
      if (!hub || typeof hub !== 'object') return;

      // Ensure client namespace exists
      if (!hub.client) hub.client = {};

      // Wrap any existing handlers + install catch-all
      const wrapClient = (client) => {
        const originalHandlers = Object.assign({}, client);

        // Re-install wrapped versions
        Object.keys(originalHandlers).forEach(method => {
          const orig = originalHandlers[method];
          client[method] = function (...args) {
            try {
              const payload = args.length === 1 ? args[0] : args;
              processHubPayload('signalr:' + hubName + ':' + method, payload);
            } catch (e) {}
            return orig && orig.apply(this, args);
          };
        });

        // Catch-all for methods not yet registered
        const proxyHandler = {
          set(target, prop, value) {
            if (typeof value === 'function') {
              const orig = value;
              target[prop] = function (...args) {
                try {
                  const payload = args.length === 1 ? args[0] : args;
                  processHubPayload('signalr:' + hubName + ':' + prop, payload);
                } catch (e) {}
                return orig.apply(this, args);
              };
            } else {
              target[prop] = value;
            }
            return true;
          }
        };

        try {
          return new Proxy(client, proxyHandler);
        } catch (e) {
          return client; // Proxy not available (shouldn't happen in MV3 context)
        }
      };

      hub.client = wrapClient(hub.client);
      console.log('[Hippo Interceptor] SignalR hub patched:', hubName);
    });

    state.signalRAttached = true;
    console.log('[Hippo Interceptor] SignalR intercept active on', targets.length, 'hub(s)');

    // Also hook the connection.received event (fires for EVERY message)
    try {
      const origReceived = conn.hub.received;
      conn.hub.received = function (data) {
        try { processHubPayload('signalr:hub.received', data); } catch(e) {}
        return origReceived && origReceived.call(this, data);
      };
    } catch(e) {}
  }

  setTimeout(tryAttachSignalR, 100);

  // ── 2. WebSocket intercept (transport fallback / direct WS) ────────────────
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);

    ws.addEventListener('message', function (e) {
      try {
        // Skip heartbeats / short frames
        if (!e.data || e.data.length < 10) return;
        let parsed;
        try { parsed = JSON.parse(e.data); } catch (_) { return; }
        processHubPayload('ws:' + url, parsed);
      } catch (err) {}
    });

    return ws;
  };
  Object.keys(OrigWS).forEach(k => { try { window.WebSocket[k] = OrigWS[k]; } catch (_) {} });
  window.WebSocket.prototype = OrigWS.prototype;
  state.wsAttached = true;

  // ── 3. XHR intercept — catch /checkTokenWithAccessData, snapshot endpoints ──
  const OrigXHR   = window.XMLHttpRequest;
  const origOpen  = OrigXHR.prototype.open;
  const origSend  = OrigXHR.prototype.send;

  const INTERESTING_XHR = [
    'checkTokenWithAccessData', 'basicdashboard',
    'dashboardData', 'snapshot', 'liveData', 'statistics',
    'widgetData', 'tileData', 'ClearView',
  ];

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__niceUrl = url || '';
    return origOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.send = function (body) {
    const url = this.__niceUrl || '';
    const interesting = INTERESTING_XHR.some(k => url.includes(k));
    if (interesting) {
      this.addEventListener('load', () => {
        try {
          const parsed = JSON.parse(this.responseText);
          processHubPayload('xhr:' + url, parsed);
        } catch (_) {}
      });
    }
    return origSend.call(this, body);
  };

  // ── 4. Fetch intercept ───────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const res = await origFetch(...args);
    const interesting = INTERESTING_XHR.some(k => url.includes(k));
    if (interesting) {
      try {
        const clone = res.clone();
        const text  = await clone.text();
        const parsed = JSON.parse(text);
        processHubPayload('fetch:' + url, parsed);
      } catch (_) {}
    }
    return res;
  };

  // ── 5. Angular Component Scraper (Service Level / SLA) ─────────────────────
  // Probe-confirmed mapping (NICE CXone):
  //
  //   comp.chartConfig.data.labels   = ["Out SLA", "In SLA"]
  //   comp.chartConfig.data.datasets = [{ data: [outCount, inCount], ... }]
  //
  // Data lives on comp.chartConfig (the Chart.js config object), NOT comp.data.
  // Widget names are read from span.overflowModuleName in the real DOM, giving
  // stable names like "Service Level", "CS CARE PHONES SLA", etc.
  //
  // window.ng.getOwningComponent() works only in PAGE context (here).
  // Results are posted back via postMessage → content_iframe.js.

  function scrapeAngularSlaWidgets() {
    const results = [];
    if (!window.ng || typeof window.ng.getOwningComponent !== 'function') return results;

    const seenComps = new WeakSet();

    // Resolve widget name from the DOM container above the canvas
    function resolveWidgetName(canvas, fallbackIdx) {
      try {
        const ctx = canvas.closest('gridster-item, .gridItem, [class*="widget-container"], cxone-dashboard-widget');
        if (ctx) {
          const nameEl = ctx.querySelector('span.overflowModuleName, [class*="widget-title"], [class*="tile-title"], h3, h4');
          const raw = nameEl ? (nameEl.innerText || '').trim() : '';
          if (raw && raw.length > 0 && raw.length < 120) {
            return raw
              .replace(/\s*\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?/gi, '')
              .replace(/\s*\(\d+\)\s*/g, '')
              .replace(/\s+/g, ' ')
              .trim();
          }
        }
      } catch (_) {}
      return 'Service Level ' + (fallbackIdx + 1);
    }

    function processCanvas(canvas, fallbackIdx) {
      try {
        const comp = window.ng.getOwningComponent(canvas);
        if (!comp || seenComps.has(comp)) return;
        seenComps.add(comp);

        const widgetName = resolveWidgetName(canvas, fallbackIdx);

        // ── Primary path: comp.chartConfig.data (Chart.js config object) ────
        const cfg = comp.chartConfig;
        if (cfg && cfg.data && Array.isArray(cfg.data.labels) && Array.isArray(cfg.data.datasets)) {
          const labels  = cfg.data.labels;   // e.g. ["Out SLA", "In SLA"]
          const dataset = cfg.data.datasets[0];
          const dataArr = dataset && Array.isArray(dataset.data) ? dataset.data : [];

          let outCount = null, inCount = null;

          labels.forEach(function(label, i) {
            const lc = String(label).toLowerCase();
            if (lc.includes('out')) outCount = dataArr[i] != null ? Number(dataArr[i]) : null;
            if (lc.includes('in'))  inCount  = dataArr[i] != null ? Number(dataArr[i]) : null;
          });

          if (inCount !== null || outCount !== null) {
            const total = (inCount || 0) + (outCount || 0);

            if (total > 0) {
              // Real data is loaded — compute and emit.
              const slaPct = ((inCount || 0) / total * 100).toFixed(2) + '%';
              results.push({ widgetName: widgetName, metric: 'SLA %',   value: slaPct });
              results.push({ widgetName: widgetName, metric: 'In SLA',  value: String(inCount  != null ? inCount  : 0) });
              results.push({ widgetName: widgetName, metric: 'Out SLA', value: String(outCount != null ? outCount : 0) });
              return;
            }
            // total === 0: Chart.js data array is still at its initialization
            // state ([0, 0]) right after a dashboard restart/refresh — the real
            // SignalR counts have not been pushed yet. Fall through to the
            // center-text path below rather than emitting a spurious 'N/A'.
            // The DOM text scraper in content_iframe.js will already have the
            // correct value from the legend ("In SLA (46)  Out SLA (0)").
          }
        }

        // ── Secondary path: comp.chartConfig.options.elements.center.text ───
        // Some versions render only the center text (the SLA % string)
        const centerText = cfg &&
                           cfg.options &&
                           cfg.options.elements &&
                           cfg.options.elements.center &&
                           cfg.options.elements.center.text;
        if (centerText && String(centerText).trim().length > 0) {
          results.push({ widgetName: widgetName, metric: 'SLA %', value: String(centerText).trim() });
          return;
        }

        // ── Tertiary path: comp.data fallback (older NICE versions) ─────────
        if (comp.data) {
          const d = comp.data;
          const outSla = d.OutService  != null ? d.OutService  : null;
          const inSla  = d.InService   != null ? d.InService   : null;
          const svcLvl = d.ServiceLevel != null ? d.ServiceLevel : null;

          if (outSla !== null || inSla !== null) {
            const slaPct = svcLvl !== null
              ? (svcLvl * 100).toFixed(2) + '%'
              : (inSla !== null && outSla !== null && (inSla + outSla) > 0)
                ? (inSla / (inSla + outSla) * 100).toFixed(2) + '%'
                : 'N/A';

            results.push({ widgetName: widgetName, metric: 'SLA %',   value: slaPct });
            results.push({ widgetName: widgetName, metric: 'In SLA',  value: String(inSla  != null ? inSla  : 'N/A') });
            results.push({ widgetName: widgetName, metric: 'Out SLA', value: String(outSla != null ? outSla : 'N/A') });
          }
        }

      } catch (err) {
        console.warn('[Hippo SLA] processCanvas error:', err.message);
      }
    }

    // Search document and any shadow roots for canvas[basechart]
    function searchShadows(root, depth) {
      if (depth > 5) return;
      try {
        var canvases = root.querySelectorAll('canvas[basechart]');
        canvases.forEach(function(canvas, i) { processCanvas(canvas, i); });
        root.querySelectorAll('*').forEach(function(el) {
          if (el.shadowRoot) searchShadows(el.shadowRoot, depth + 1);
        });
      } catch (_) {}
    }

    try { searchShadows(document, 0); } catch (_) {}
    return results;
  }

  // Listen for SLA scrape requests from content_iframe.js
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'NICE_REQUEST_SLA_SCRAPE') return;
    const snapshotTime = e.data.snapshotTime || new Date().toISOString();
    const slaResults   = scrapeAngularSlaWidgets();
    window.postMessage({ type: 'NICE_SLA_SCRAPE_RESULT', slaResults, snapshotTime }, '*');
  });

  console.log('[Hippo Interceptor] Active — WS + XHR + Fetch patched, waiting for SignalR...');
})();
