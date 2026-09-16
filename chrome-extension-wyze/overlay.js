// overlay.js — shared draggable overlay UI for the Wyze Dashboard Scraper
// content scripts (content_roster.js / content_chat.js). Each of those pages
// is its own browser tab (unlike Hippo's single-page-with-iframes NICE
// dashboard), so there is exactly one overlay instance per tab — no need to
// namespace the DOM ids per page. Loaded first via manifest.json's
// content_scripts "js" array, ahead of the page-specific script.
//
// API: window.WyzeOverlay.create({ title, writesTo, storageKeyPrefix,
// defaultInterval, onSnap }) — onSnap is an async function returning
// { ok, summary, previewItems, error } and does the actual scrape + message
// background.js; this file only owns the button/log/countdown/drag chrome.

(function () {
  'use strict';

  function create({ title, writesTo, storageKeyPrefix, defaultInterval = 60, onSnap }) {
    const SK_INTERVAL = `${storageKeyPrefix}_interval`;
    const SK_STATE = `${storageKeyPrefix}_auto_state`;

    let autoTimer = null;
    let cdTimer = null;
    let cdRemaining = 0;
    let isRunning = false;
    let intervalSec = defaultInterval;
    let snapCount = 0;

    function isContextValid() {
      try { return !!chrome.runtime?.id; } catch (e) { return false; }
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

    function escHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function log(msg, type) {
      const box = document.getElementById('__wyze_log');
      if (!box) { console.log(`[${title}]`, msg); return; }
      const d = document.createElement('div');
      d.className = '__wyze_log_entry ' + (type || 'info');
      d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      box.insertBefore(d, box.firstChild);
      while (box.children.length > 60) box.removeChild(box.lastChild);
    }

    function updateDotState(r) { const d = document.getElementById('__wyze_dot'); if (d) d.className = r ? 'running' : ''; }
    function updateButtons() {
      const s = document.getElementById('__wyze_btn_start'), t = document.getElementById('__wyze_btn_stop');
      if (s) s.disabled = isRunning; if (t) t.disabled = !isRunning;
    }
    function updateCountdown(v) { const el = document.getElementById('__wyze_countdown'); if (el) el.textContent = v ? v + 's' : ''; }
    function updateSnapInfo() { const el = document.getElementById('__wyze_snap_info'); if (el) el.textContent = 'Snapshots: ' + snapCount; }

    function setPreview(previewItems) {
      const el = document.getElementById('__wyze_preview');
      if (!el) return;
      if (!previewItems || previewItems.length === 0) {
        el.innerHTML = '<div class="__wyze_empty">Nothing scraped yet</div>';
        return;
      }
      el.innerHTML = previewItems.map(item =>
        `<div class="__wyze_preview_item">
          <span class="__wyze_preview_name">${escHtml(item.name)}</span>
          <span class="__wyze_preview_rows">${escHtml(item.detail)}</span>
        </div>`
      ).join('');
    }

    function makeDraggable(el, hdr) {
      let dx = 0, dy = 0, mx = 0, my = 0, dragging = false;
      hdr.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true; mx = e.clientX; my = e.clientY;
        const r = el.getBoundingClientRect(); dx = r.left; dy = r.top;
        document.addEventListener('mousemove', onM); document.addEventListener('mouseup', onU);
        e.preventDefault();
      });
      function onM(e) { if (!dragging) return; let nx = dx + (e.clientX - mx), ny = dy + (e.clientY - my); nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, nx)); ny = Math.max(0, Math.min(window.innerHeight - 40, ny)); el.style.left = nx + 'px'; el.style.top = ny + 'px'; el.style.right = 'auto'; }
      function onU() { dragging = false; document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU); }
    }

    async function doSnap() {
      log('📷 Scraping…', 'info');
      let result;
      try {
        result = await onSnap();
      } catch (err) {
        result = { ok: false, error: err.message };
      }

      snapCount++;
      updateSnapInfo();

      if (result?.ok) {
        log(`✅ ${result.summary || 'Synced to WFM Live'}`, 'success');
        if (result.previewItems) setPreview(result.previewItems);
      } else {
        log(`❌ Snapshot failed: ${result?.error || 'unknown error'}`, 'error');
      }
    }

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
      if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
      if (persist) storeRemove(SK_STATE);
      updateDotState(false);
      updateButtons();
      updateCountdown('');
      log('⏹ Stopped', 'info');
    }

    function buildOverlay() {
      document.getElementById('__wyze_overlay')?.remove();

      if (!document.getElementById('__wyze_styles_link')) {
        const link = document.createElement('link');
        link.id = '__wyze_styles_link';
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('wyze_styles.css');
        document.head.appendChild(link);
      }

      const ov = document.createElement('div');
      ov.id = '__wyze_overlay';
      ov.innerHTML = `
<div id="__wyze_header">
  <div id="__wyze_dot"></div>
  <span id="__wyze_title">&#128202; ${escHtml(title)}</span>
  <span id="__wyze_countdown"></span>
  <button id="__wyze_toggle">&#9650;</button>
</div>
<div id="__wyze_body">
  <div class="__wyze_card">
    <div class="__wyze_card_title">Controls</div>
    <div class="__wyze_btn_row">
      <button class="__wyze_btn __wyze_btn_start" id="__wyze_btn_start">&#9654; Start Auto</button>
      <button class="__wyze_btn __wyze_btn_stop"  id="__wyze_btn_stop" disabled>&#9209; Stop</button>
    </div>
    <button class="__wyze_btn __wyze_btn_full" id="__wyze_btn_manual">&#128248; Manual Snapshot</button>
    <div id="__wyze_path">✓ Writes to: ${escHtml(writesTo)}</div>
    <div class="__wyze_interval">
      <label>INTERVAL (s)</label>
      <input type="number" id="__wyze_interval_input" value="${intervalSec}" min="15" max="3600">
      <button id="__wyze_btn_apply">Apply</button>
    </div>
  </div>

  <div class="__wyze_card">
    <div class="__wyze_card_title">Last Scrape</div>
    <div id="__wyze_preview" class="__wyze_preview_list">
      <div class="__wyze_empty">Press Manual Snapshot to preview</div>
    </div>
  </div>

  <div class="__wyze_card">
    <div class="__wyze_card_title">Activity Log</div>
    <div class="__wyze_log" id="__wyze_log"></div>
    <div class="__wyze_snap_info" id="__wyze_snap_info">Snapshots: 0</div>
  </div>
</div>`;
      document.body.appendChild(ov);

      document.getElementById('__wyze_btn_start').onclick = () => startAuto(false);
      document.getElementById('__wyze_btn_stop').onclick = () => stopAuto(true);
      document.getElementById('__wyze_btn_manual').onclick = () => doSnap();
      document.getElementById('__wyze_btn_apply').onclick = () => {
        const v = parseInt(document.getElementById('__wyze_interval_input').value || String(defaultInterval));
        if (v >= 15) {
          intervalSec = v;
          storeSet({ [SK_INTERVAL]: v });
          log('Interval: ' + v + 's', 'info');
          if (isRunning) { stopAuto(false); startAuto(true); }
        } else { log('Min 15s', 'warn'); }
      };
      document.getElementById('__wyze_toggle').onclick = () => {
        const ovEl = document.getElementById('__wyze_overlay');
        const btn = document.getElementById('__wyze_toggle');
        ovEl.classList.toggle('collapsed');
        btn.innerHTML = ovEl.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
      };

      makeDraggable(ov, document.getElementById('__wyze_header'));
    }

    // ── Popup messages (Start/Stop/Manual Snapshot from the toolbar popup) ───
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isContextValid()) return;
        if (msg.type === 'WYZE_START_AUTO') { startAuto(false); sendResponse({ ok: true }); }
        if (msg.type === 'WYZE_STOP_AUTO') { stopAuto(true); sendResponse({ ok: true }); }
        if (msg.type === 'WYZE_MANUAL_SNAP') { doSnap().then(() => sendResponse({ ok: true })); return true; }
      });
    } catch (e) {}

    storeGet([SK_INTERVAL, SK_STATE], res => {
      intervalSec = res[SK_INTERVAL] || defaultInterval;
      buildOverlay();
      log(`✅ ${title} ready`, 'success');
      log('ℹ️ Press Manual Snapshot to capture the current page', 'info');
      if (res[SK_STATE]) {
        log('🔁 Auto-resuming…', 'info');
        startAuto(true);
      }
    });

    return { log, setPreview };
  }

  window.WyzeOverlay = { create };
})();
