// content_main.js — Hippo Dashboard Scraper (WFM Live)
// Handles the overlay UI, auto-loop, and snapshot scraping. Every snapshot is
// sent to background.js, which writes it straight to WFM Live's Supabase
// tables (hippo_kpis / hippo_licensed_agents / hippo_level_1 / hippo_datasets)
// — the same tables wfm-live-scraper's scrapers/hippo/index.js writes to.
//
// Adapted from the original "NICE inContact Dashboard Scraper" extension
// (which uploaded CSVs to Google Drive) — the DOM-scraping side is untouched
// (content_iframe.js / signalr_interceptor.js), only the upload destination
// changed.

(function () {
  'use strict';

  if (!location.href.includes('nice-incontact.com')) return;

  const isDashPage = () =>
    location.href.includes('/dashboard') ||
    location.href.includes('dashboard/wrapper') ||
    location.href.includes('dashboards');

  if (!isDashPage()) {
    let pollCount = 0;
    const navPoll = setInterval(() => {
      pollCount++;
      if (isDashPage()) { clearInterval(navPoll); init(); }
      if (pollCount > 120) clearInterval(navPoll);
    }, 1000);
    return;
  }

  // ── Storage keys ────────────────────────────────────────────────────────
  const SK_INTERVAL = 'hippo_interval';
  const SK_STATE     = 'hippo_auto_state';

  // ── State ───────────────────────────────────────────────────────────────
  let autoTimer   = null;
  let cdTimer     = null;
  let isRunning   = false;
  let intervalSec = 60;
  let snapCount   = 0;
  let lastScrapeResults = [];

  // ── Context guard ───────────────────────────────────────────────────────
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch (e) { return false; }
  }
  function safeSend(msg) {
    return new Promise(resolve => {
      if (!isContextValid()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }
  function storeGet(keys, cb) {
    if (!isContextValid()) { cb({}); return; }
    try { chrome.storage.local.get(keys, r => { if (chrome.runtime.lastError) cb({}); else cb(r); }); }
    catch (e) { cb({}); }
  }
  function storeSet(obj) {
    if (!isContextValid()) return;
    try { chrome.storage.local.set(obj); } catch (e) {}
  }
  function storeRemove(k) {
    if (!isContextValid()) return;
    try { chrome.storage.local.remove(k); } catch (e) {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCRAPER CONTROLLER
  // Sends NICE_REQUEST_DOM_SCRAPE to the top window (where content_iframe.js
  // now also runs) and to any iframes. Collects all NICE_DOM_SCRAPE_RESULT
  // replies within 2.5s then deduplicates by widget name.
  // ──────────────────────────────────────────────────────────────────────────

  function requestScrapeFromIframe() {
    return new Promise(resolve => {
      let datasets = [];
      const snapshotTime = new Date().toISOString();

      const handler = (e) => {
        if (e.data && e.data.type === 'NICE_DOM_SCRAPE_RESULT') {
          if (e.data.datasets && e.data.datasets.length > 0) {
            datasets.push(...e.data.datasets);
          }
        }
      };

      window.addEventListener('message', handler);

      window.postMessage({ type: 'NICE_REQUEST_DOM_SCRAPE', snapshotTime }, '*');

      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(f => {
        try {
          f.contentWindow.postMessage({ type: 'NICE_REQUEST_DOM_SCRAPE', snapshotTime }, '*');
        } catch (e) {}
      });

      setTimeout(() => {
        window.removeEventListener('message', handler);

        const unique = [];
        const seen = new Set();
        datasets.forEach(d => {
          if (!seen.has(d.name)) {
            seen.add(d.name);
            unique.push(d);
          }
        });

        resolve(unique);
      }, 2500);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CSV BUILDER — used only as a local backup if a Supabase write ever fails,
  // so a snapshot is never silently lost.
  // ──────────────────────────────────────────────────────────────────────────

  function sanitizeName(s) {
    if (!s) return 'Dataset';
    return String(s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 50);
  }

  function buildCsv(dataset) {
    const lines = [];
    if (dataset.headers && dataset.headers.length > 0) {
      lines.push(dataset.headers.map(csvEsc).join(','));
    }
    if (dataset.rows && dataset.rows.length > 0) {
      dataset.rows.forEach(row => lines.push(row.map(csvEsc).join(',')));
    }
    return lines.join('\r\n');
  }

  function csvEsc(v) {
    const s = String(v == null ? '' : v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function getFileName(datasetName) {
    return `Hippo_${sanitizeName(datasetName)}.csv`;
  }

  function fallbackDownload(content, fileName) {
    const blob = new Blob([content], { type: 'text/csv' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SNAPSHOT
  // ──────────────────────────────────────────────────────────────────────────

  async function doSnap() {
    log('📷 Scraping dashboard…', 'info');

    const datasets = await requestScrapeFromIframe();

    if (!datasets || datasets.length === 0) {
      log('⚠️ Nothing found — make sure the dashboard is fully loaded', 'warn');
      return;
    }

    snapCount++;
    log(`📊 Found ${datasets.length} table(s)/tile(s) — writing to Supabase…`, 'info');

    const res = await safeSend({ type: 'NICE_WRITE_TO_SUPABASE', datasets });

    if (res?.ok) {
      log(`✅ Synced ${datasets.length} widget(s) to WFM Live`, 'success');
    } else {
      log(`❌ Supabase write failed: ${res?.error || 'unknown error'} — saving local CSV backup instead`, 'error');
      datasets.forEach(d => fallbackDownload(buildCsv(d), getFileName(d.name)));
    }

    lastScrapeResults = datasets;
    updateSnapInfo();
    refreshPreview(datasets);

    log(`Snap #${snapCount}: ${res?.ok ? 'synced to WFM Live' : 'FAILED — local backup saved'}`, res?.ok ? 'success' : 'warn');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // AUTO LOOP
  // ──────────────────────────────────────────────────────────────────────────

  let cdRemaining = 0;

  async function startAuto(resume = false) {
    if (isRunning) return;
    isRunning = true;
    storeSet({ [SK_STATE]: true });
    updateButtons();
    updateDotState(true);
    log(resume ? '🔁 Auto resumed' : `▶ Auto started (${intervalSec}s)`, 'success');
    scheduleNext();
  }

  function scheduleNext() {
    if (!isRunning || !isContextValid()) return;
    cdRemaining = intervalSec;
    updateCountdown(cdRemaining);
    if (cdTimer) clearInterval(cdTimer);
    cdTimer = setInterval(() => {
      if (!isRunning) { clearInterval(cdTimer); return; }
      cdRemaining = Math.max(0, cdRemaining - 1);
      updateCountdown(cdRemaining);
    }, 1000);
    autoTimer = setTimeout(async () => {
      if (!isRunning) return;
      clearInterval(cdTimer);
      await doSnap();
      scheduleNext();
    }, intervalSec * 1000);
  }

  function stopAuto(persist = true) {
    isRunning = false;
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (cdTimer)   { clearInterval(cdTimer);  cdTimer   = null; }
    if (persist)   storeRemove(SK_STATE);
    updateDotState(false);
    updateButtons();
    updateCountdown('');
    log('⏹ Stopped', 'info');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // OVERLAY UI
  // ──────────────────────────────────────────────────────────────────────────

  function buildOverlay() {
    document.getElementById('__nice_overlay')?.remove();

    if (!document.getElementById('__nice_styles_link')) {
      const link = document.createElement('link');
      link.id = '__nice_styles_link';
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('nice_styles.css');
      document.head.appendChild(link);
    }

    const ov = document.createElement('div');
    ov.id = '__nice_overlay';
    ov.innerHTML = `
<div id="__nice_header">
  <div id="__nice_dot"></div>
  <span id="__nice_title">&#128202; Hippo Dashboard Scraper</span>
  <span id="__nice_countdown"></span>
  <button id="__nice_toggle">&#9650;</button>
</div>
<div id="__nice_body">
  <div class="__nice_card">
    <div class="__nice_card_title">Controls</div>
    <div class="__nice_btn_row">
      <button class="__nice_btn __nice_btn_start" id="__nice_btn_start">&#9654; Start Auto</button>
      <button class="__nice_btn __nice_btn_stop"  id="__nice_btn_stop" disabled>&#9209; Stop</button>
    </div>
    <button class="__nice_btn __nice_btn_full"  id="__nice_btn_manual">&#128248; Manual Snapshot</button>
    <div id="__nice_path">✓ Writes to: WFM Live Supabase (hippo)</div>
    <div class="__nice_interval">
      <label>INTERVAL (s)</label>
      <input type="number" id="__nice_interval_input" value="60" min="15" max="3600">
      <button id="__nice_btn_apply">Apply</button>
    </div>
  </div>

  <div class="__nice_card">
    <div class="__nice_card_title">
      Last Scrape
      <span id="__nice_kpi_count" style="float:right;color:#4b5563;font-size:9px"></span>
    </div>
    <div id="__nice_preview" class="__nice_preview_list">
      <div class="__nice_kpi_empty">Press Manual Snapshot to preview</div>
    </div>
  </div>

  <div class="__nice_card">
    <div class="__nice_card_title">Activity Log</div>
    <div class="__nice_log" id="__nice_log"></div>
    <div class="__nice_snap_info" id="__nice_snap_info">Snapshots: 0</div>
  </div>
</div>`;
    document.body.appendChild(ov);

    document.getElementById('__nice_btn_start').onclick  = () => startAuto(false);
    document.getElementById('__nice_btn_stop').onclick   = () => stopAuto(true);
    document.getElementById('__nice_btn_manual').onclick = () => doSnap();
    document.getElementById('__nice_btn_apply').onclick = () => {
      const v = parseInt(document.getElementById('__nice_interval_input').value || '60');
      if (v >= 15) {
        intervalSec = v;
        storeSet({ [SK_INTERVAL]: v });
        log('Interval: ' + v + 's', 'info');
        if (isRunning) { stopAuto(false); startAuto(true); }
      } else { log('Min 15s', 'warn'); }
    };
    document.getElementById('__nice_toggle').onclick = () => {
      const ovEl = document.getElementById('__nice_overlay');
      const btn  = document.getElementById('__nice_toggle');
      ovEl.classList.toggle('collapsed');
      btn.innerHTML = ovEl.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
    };

    makeDraggable(ov, document.getElementById('__nice_header'));
    document.getElementById('__nice_interval_input').value = intervalSec;
  }

  function refreshPreview(datasets) {
    const el = document.getElementById('__nice_preview');
    const ct = document.getElementById('__nice_kpi_count');
    if (!el) return;
    if (!datasets || datasets.length === 0) {
      el.innerHTML = '<div class="__nice_kpi_empty">Nothing scraped yet</div>';
      if (ct) ct.textContent = '';
      return;
    }
    if (ct) ct.textContent = datasets.length + ' file(s)';
    el.innerHTML = datasets.map(d =>
      `<div class="__nice_preview_item">
        <span class="__nice_preview_name">${escHtml(d.name)}</span>
        <span class="__nice_preview_rows">${d.rows.length} rows</span>
      </div>`
    ).join('');
  }

  function makeDraggable(el, hdr) {
    let dx=0,dy=0,mx=0,my=0,dragging=false;
    hdr.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging=true; mx=e.clientX; my=e.clientY;
      const r=el.getBoundingClientRect(); dx=r.left; dy=r.top;
      document.addEventListener('mousemove',onM); document.addEventListener('mouseup',onU);
      e.preventDefault();
    });
    function onM(e){if(!dragging)return;let nx=dx+(e.clientX-mx),ny=dy+(e.clientY-my);nx=Math.max(0,Math.min(window.innerWidth-el.offsetWidth,nx));ny=Math.max(0,Math.min(window.innerHeight-40,ny));el.style.left=nx+'px';el.style.top=ny+'px';el.style.right='auto';}
    function onU(){dragging=false;document.removeEventListener('mousemove',onM);document.removeEventListener('mouseup',onU);}
  }

  // ── UI helpers ──────────────────────────────────────────────────────────
  function log(msg, type) {
    const box = document.getElementById('__nice_log');
    if (!box) { console.log('[Hippo Scraper]', msg); return; }
    const d = document.createElement('div');
    d.className = '__nice_log_entry ' + (type || 'info');
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    box.insertBefore(d, box.firstChild);
    while (box.children.length > 60) box.removeChild(box.lastChild);
  }
  function updateDotState(r){const d=document.getElementById('__nice_dot');if(d)d.className=r?'running':'';}
  function updateButtons(){
    const s=document.getElementById('__nice_btn_start'),t=document.getElementById('__nice_btn_stop');
    if(s)s.disabled=isRunning; if(t)t.disabled=!isRunning;
  }
  function updateCountdown(v){const el=document.getElementById('__nice_countdown');if(el)el.textContent=v?v+'s':'';}
  function updateSnapInfo(){const el=document.getElementById('__nice_snap_info');if(el)el.textContent='Snapshots: '+snapCount;}
  function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  // ── Popup messages ──────────────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!isContextValid()) return;
      if (msg.type==='NICE_START_AUTO')  { startAuto(false); sendResponse({ok:true}); }
      if (msg.type==='NICE_STOP_AUTO')   { stopAuto(true);   sendResponse({ok:true}); }
      if (msg.type==='NICE_MANUAL_SNAP') { doSnap().then(()=>sendResponse({ok:true})); return true; }
    });
  } catch(e) {}

  // ──────────────────────────────────────────────────────────────────────────
  // KEEP-ALIVE (prevent NICE inContact auto-logout)
  //
  // HOW THE IDLE DETECTION WORKS (confirmed by DOM probe):
  //   NICE CXone runs an Angular app whose idle service listens for these
  //   specific events — confirmed via getEventListeners() in DevTools:
  //     document: pointerdown, pointerup, mousedown, touchstart, keydown, click
  //     window:   keypress, keyup, click, scroll
  //   mousemove is NOT in the listener list.
  //
  //   No server-side ping is needed — the active WebSocket (RTA
  //   notifications) keeps the server session alive. The idle timeout is
  //   purely client-side.
  //
  // Now doubly important: this runs on the REAL human's own login session,
  // so an idle-triggered logout would interrupt their actual work too, not
  // just the scraper.
  // ──────────────────────────────────────────────────────────────────────────

  const KEEP_ALIVE_MS = 60 * 1000;
  let keepAliveTimer = null;

  function simulateUserActivity() {
    try {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: false, cancelable: true, clientX: 1, clientY: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup',   { bubbles: false, cancelable: true, clientX: 1, clientY: 1 }));
      document.dispatchEvent(new MouseEvent('mousedown',     { bubbles: false, cancelable: true, clientX: 1, clientY: 1 }));

      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: false, cancelable: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
      window.dispatchEvent(new KeyboardEvent('keypress',  { bubbles: false, cancelable: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
      window.dispatchEvent(new KeyboardEvent('keyup',     { bubbles: false, cancelable: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
    } catch (e) { /* non-fatal */ }
  }

  function setupIdleDialogGuard() {
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const text = node.innerText || node.textContent || '';
          if (!/still there|are you still|idle|session.*expir|inactiv|timed.?out/i.test(text)) continue;

          log('⚠️ Idle dialog detected — auto-dismissing', 'warn');
          simulateUserActivity();

          const btns = node.querySelectorAll('button, [role="button"], .btn, a.button');
          let clicked = false;
          for (const btn of btns) {
            if (/stay|yes|continue|ok|still here|keep|dismiss|i.m here/i.test(btn.innerText || '')) {
              btn.click();
              log('✅ Idle dialog dismissed', 'success');
              clicked = true;
              break;
            }
          }
          if (!clicked && btns.length) {
            btns[0].click();
            log('✅ Idle dialog dismissed (first button fallback)', 'success');
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[Hippo KeepAlive] Idle dialog guard active');
  }

  function startKeepAlive() {
    if (keepAliveTimer) return;
    simulateUserActivity();
    keepAliveTimer = setInterval(() => {
      if (!isContextValid()) { stopKeepAlive(); return; }
      simulateUserActivity();
    }, KEEP_ALIVE_MS);
    console.log('[Hippo KeepAlive] Started — heartbeat every', KEEP_ALIVE_MS / 1000, 's');
    log('🛡️ Keep-alive active (60s)', 'info');
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      console.log('[Hippo KeepAlive] Stopped');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────────────────────────────────────

  async function init() {
    if (!isContextValid()) return;
    document.getElementById('__nice_overlay')?.remove();

    storeGet([SK_INTERVAL, SK_STATE], res => {
      intervalSec = res[SK_INTERVAL] || 60;

      buildOverlay();
      startKeepAlive();
      setupIdleDialogGuard();
      log('✅ Hippo Dashboard Scraper ready', 'success');
      log('ℹ️ Press Manual Snapshot to capture all tables + tiles', 'info');

      if (res[SK_STATE]) {
        log('🔁 Auto-resuming…', 'info');
        startAuto(true);
      }
    });
  }

  // ── SPA navigation watcher ──────────────────────────────────────────────
  let lastUrl = location.href;
  function onNavigate() {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;
    if (!isDashPage()) return;
    if (isRunning) stopAuto(false);
    stopKeepAlive();
    isRunning = false; snapCount = 0;
    setTimeout(init, 2000);
  }
  window.addEventListener('hashchange', onNavigate);
  window.addEventListener('popstate',   onNavigate);
  setInterval(() => { if (!isContextValid()) return; if (location.href !== lastUrl) onNavigate(); }, 800);

  setTimeout(init, 2500);

})();
