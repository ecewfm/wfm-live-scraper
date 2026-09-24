// Ashley LivePerson Chat Scraper - Content Script
// Injected automatically on z1.le.liveperson.net

(function () {
  'use strict';

  const STORAGE_KEY_STATE    = 'lp_auto_state';
  const STORAGE_KEY_INTERVAL = 'lp_interval';
  const STORAGE_KEY_FOLDER   = 'lp_drive_folder';
  const RELOAD_THRESHOLD     = 3;
  const RELOAD_DELAY_MS      = 3000;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Always true — content script only runs on z1.le.liveperson.net ───────
  function isOnDashboard() {
    return location.hostname.includes('.le.liveperson.net') ||
           location.hash.includes('/amd/dashboard') ||
           location.pathname.includes('/amd/dashboard');
  }

  // ── Wait for the dashboard widgets to be ready ───────────────────────────
  function waitForApp(cb, maxWait = 60000) {
    const start = Date.now();
    const iv = setInterval(() => {
      const ready = !!document.querySelector(
        '[data-test="shift_status.widget"], ' +
        'article.in-queue, ' +
        '[data-test*="agentName_content"], ' +
        '#manager-vue-app, ' +
        '[class*="manager-workspace"], ' +
        'article.widget, ' +
        '[data-test="shift_status.title"]'
      );
      if (ready || Date.now() - start > maxWait) {
        clearInterval(iv);
        cb(ready);
      }
    }, 1000);
  }

  // ── Route change observer ────────────────────────────────────────────────
  function observeRoute() {
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash !== lastHash) {
        lastHash = location.hash;
        const ov = document.getElementById('__lp_overlay');
        if (!ov) return;
        ov.style.display = isOnDashboard() ? '' : 'none';
      }
    }, 500);
  }

  // ── Persist state helpers ────────────────────────────────────────────────
  function saveState(running, intervalSec) {
    chrome.storage.local.set({ [STORAGE_KEY_STATE]: running, [STORAGE_KEY_INTERVAL]: intervalSec });
  }
  function loadState(cb) {
    chrome.storage.local.get([STORAGE_KEY_STATE, STORAGE_KEY_INTERVAL, STORAGE_KEY_FOLDER], cb);
  }
  function saveFolderInfo(id, name) {
    chrome.storage.local.set({ [STORAGE_KEY_FOLDER]: { id, name } });
  }
  function clearFolderInfo() {
    chrome.storage.local.remove(STORAGE_KEY_FOLDER);
  }
  function clearDriveFileIdCache(folderId) {
    chrome.runtime.sendMessage({ type: 'CLEAR_FILE_ID_CACHE', folderId: folderId || null });
  }

  // ── Inject once ──────────────────────────────────────────────────────────
  function inject(savedState) {
    if (document.getElementById('__lp_overlay')) return;

    const CSS = `
#__lp_overlay{position:fixed;top:80px;right:20px;width:340px;background:#0d1117;border:1px solid #3b82f6;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.7),0 0 0 1px rgba(59,130,246,0.2);z-index:999999;font-family:'Segoe UI',Arial,sans-serif;color:#e0e0e0;font-size:13px;user-select:none;min-width:200px}
#__lp_overlay.collapsed #__lp_body{display:none}
#__lp_overlay.collapsed{border-color:#555}
#__lp_overlay.collapsed #__lp_header{border-radius:12px;border-bottom:none}
#__lp_header{background:linear-gradient(135deg,#1a1f2e,#0d1528);border-radius:12px 12px 0 0;padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:move;border-bottom:1px solid #1e2d45}
#__lp_dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0}
#__lp_dot.running{background:#3b82f6;box-shadow:0 0 6px #3b82f6;animation:__lp_pulse 1.5s infinite}
@keyframes __lp_pulse{0%,100%{opacity:1}50%{opacity:0.4}}
#__lp_title{font-weight:700;font-size:13px;color:#60a5fa;flex:1}
#__lp_countdown{font-size:10px;color:#ffd700;margin-left:auto}
#__lp_last_time{font-size:10px;color:#f59e0b}
#__lp_toggle{background:none;border:1px solid #333;color:#888;cursor:pointer;border-radius:4px;padding:2px 7px;font-size:11px;flex-shrink:0}
#__lp_body{padding:10px 12px}
.__lp_card{background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px;margin-bottom:8px}
.__lp_card_title{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.__lp_btn_row{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.__lp_btn{border:none;color:#fff;cursor:pointer;border-radius:6px;padding:8px 6px;font-size:12px;font-weight:700;transition:transform 0.1s,opacity 0.2s;white-space:nowrap}
.__lp_btn:active{transform:scale(0.96)}
.__lp_btn:disabled{opacity:0.35;cursor:not-allowed}
.__lp_btn_start{background:linear-gradient(135deg,#1e3a8a,#3b82f6)}
.__lp_btn_stop{background:linear-gradient(135deg,#991b1b,#ef4444)}
.__lp_btn_manual{width:100%;background:linear-gradient(135deg,#1e40af,#3b82f6);margin-bottom:6px}
.__lp_btn_export{width:100%;background:linear-gradient(135deg,#0d9488,#2dd4bf);margin-bottom:6px}
.__lp_btn_path{width:100%;background:linear-gradient(135deg,#5b21b6,#8b5cf6);margin-bottom:6px;font-size:11px}
.__lp_btn_disconnect{width:100%;background:linear-gradient(135deg,#7f1d1d,#dc2626);margin-bottom:6px;font-size:11px}
.__lp_interval_row{display:flex;gap:6px;align-items:center;margin-top:6px}
.__lp_interval_row label{font-size:9px;color:#6b7280;flex-shrink:0}
.__lp_interval_row input{flex:1;background:#0d1117;border:1px solid #374151;color:#fff;border-radius:5px;padding:5px;font-size:12px;text-align:center}
.__lp_interval_row button{background:#374151;border:none;color:#fff;cursor:pointer;border-radius:5px;padding:5px 10px;font-size:11px}
.__lp_kpi_grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.__lp_kpi_item{background:#0d1117;border-radius:5px;padding:5px 7px}
.__lp_kpi_label{font-size:9px;color:#4b5563;margin-bottom:1px}
.__lp_kpi_val{font-size:16px;font-weight:700;color:#fff;line-height:1.1}
.__lp_kpi_val.blue{color:#3b82f6}
.__lp_kpi_val.green{color:#22c55e}
.__lp_kpi_val.yellow{color:#f59e0b}
.__lp_kpi_val.red{color:#ef4444}
.__lp_log{background:#060a0f;border-radius:6px;padding:7px;max-height:120px;overflow-y:auto;margin-top:4px}
.__lp_log_entry{font-size:10px;padding-bottom:2px;margin-bottom:2px;border-bottom:1px solid #0d1117;line-height:1.3}
.__lp_log_entry.success{color:#22c55e}
.__lp_log_entry.error{color:#ef4444}
.__lp_log_entry.info{color:#6b7280}
.__lp_log_entry.warn{color:#f59e0b}
#__lp_path_display{font-size:9px;color:#3b82f6;padding:3px 5px;background:#060a0f;border-radius:4px;margin-top:4px;min-height:16px;word-break:break-all}
#__lp_path_display.none{color:#4b5563}
.__lp_snap_info{font-size:9px;color:#4b5563;text-align:right;margin-top:4px}
.__lp_picker_section_label{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;padding:6px 4px 4px;margin-top:4px;border-top:1px solid #1f2937}
.__lp_picker_section_label:first-child{margin-top:0;border-top:none}
.__lp_picker_folder_btn{display:block;width:100%;text-align:left;background:#111827;border:1px solid #1f2937;color:#e0e0e0;cursor:pointer;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:5px;transition:background 0.15s,border-color 0.15s}
.__lp_picker_folder_btn:hover{background:#1f2937;border-color:#374151}
.__lp_picker_folder_btn.shared{border-left:2px solid #3b82f6}
.__lp_picker_empty{font-size:11px;color:#4b5563;padding:10px 4px;text-align:center}
`;
    const sEl = document.createElement('style');
    sEl.id = '__lp_style';
    sEl.textContent = CSS;
    document.head.appendChild(sEl);

    const ov = document.createElement('div');
    ov.id = '__lp_overlay';
    ov.innerHTML = `
<div id="__lp_header">
  <div id="__lp_dot"></div>
  <span id="__lp_title">LP Chat Scraper</span>
  <span id="__lp_last_time"></span>
  <span id="__lp_countdown"></span>
  <button id="__lp_toggle">▲</button>
</div>
<div id="__lp_body">
  <div class="__lp_card">
    <div class="__lp_card_title">Controls</div>
    <div class="__lp_btn_row">
      <button class="__lp_btn __lp_btn_start" id="__lp_btn_start">▶ Start Auto</button>
      <button class="__lp_btn __lp_btn_stop"  id="__lp_btn_stop" disabled>⏹ Stop</button>
    </div>
    <button class="__lp_btn __lp_btn_manual"  id="__lp_btn_manual">⬇ Manual Snapshot</button>
    <button class="__lp_btn __lp_btn_export"  id="__lp_btn_export">⬇ Export All CSVs Now</button>
    <button class="__lp_btn __lp_btn_path"    id="__lp_btn_path">📁 Set Google Drive Folder</button>
    <button class="__lp_btn __lp_btn_disconnect" id="__lp_btn_disconnect" style="display:none">🔌 Disconnect Drive</button>
    <div id="__lp_path_display" class="none">No Drive folder set</div>
    <div class="__lp_interval_row">
      <label>INTERVAL (s)</label>
      <input type="number" id="__lp_interval" value="30" min="10" max="3600">
      <button id="__lp_btn_apply">Apply</button>
    </div>
  </div>
  <div class="__lp_card">
    <div class="__lp_card_title">Live Metrics</div>
    <div class="__lp_kpi_grid">
      <div class="__lp_kpi_item"><div class="__lp_kpi_label">Assigned</div><div class="__lp_kpi_val blue" id="__lp_m_assigned">-</div></div>
      <div class="__lp_kpi_item"><div class="__lp_kpi_label">Load</div><div class="__lp_kpi_val yellow" id="__lp_m_load">-</div></div>
      <div class="__lp_kpi_item"><div class="__lp_kpi_label">Closed</div><div class="__lp_kpi_val green" id="__lp_m_closed">-</div></div>
      <div class="__lp_kpi_item"><div class="__lp_kpi_label">CSAT</div><div class="__lp_kpi_val green" id="__lp_m_csat">-</div></div>
    </div>
    <div class="__lp_snap_info" id="__lp_snap_info">Agents: - | Snapshots: 0</div>
  </div>
  <div class="__lp_card">
    <div class="__lp_card_title">Activity Log</div>
    <div class="__lp_log" id="__lp_log"></div>
  </div>
</div>`;
    document.body.appendChild(ov);

    let intervalSec   = savedState.interval || 30;
    let snapCount     = 0;
    let isRunning     = false;
    let driveFolderId = savedState.folder ? savedState.folder.id   : null;
    let driveFolderNm = savedState.folder ? savedState.folder.name : null;
    let autoTimer     = null;
    let cdTimer       = null;
    let emptyStreak   = 0;

    document.getElementById('__lp_interval').value = intervalSec;

    // ── Helpers ───────────────────────────────────────────────────────────
    function log(msg, type) {
      const box = document.getElementById('__lp_log');
      if (!box) return;
      const d = document.createElement('div');
      d.className = '__lp_log_entry ' + (type || 'info');
      d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      box.insertBefore(d, box.firstChild);
      while (box.children.length > 60) box.removeChild(box.lastChild);
    }

    function updateFolderDisplay() {
      const pd  = document.getElementById('__lp_path_display');
      const btn = document.getElementById('__lp_btn_disconnect');
      if (driveFolderId) {
        if (pd)  { pd.textContent = '✅ Drive: ' + driveFolderNm; pd.className = ''; }
        if (btn) btn.style.display = '';
      } else {
        if (pd)  { pd.textContent = 'No Drive folder set'; pd.className = 'none'; }
        if (btn) btn.style.display = 'none';
      }
    }

    // ── Main scrape ────────────────────────────────────────────────────────
    async function scrape() {
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'SCRAPE_LP' }, res => resolve(res || {}));
      });

      if (result && result.ok && result.data) {
        return result.data;
      } else {
        log('Scrape error: ' + (result && result.error ? result.error : 'unknown'), 'warn');
        return null;
      }
    }

    // ── Empty detection ────────────────────────────────────────────────────
    function isDataEmpty(data) {
      if (!data) return true;
      return data.agents.length === 0 &&
             data.queueSummary.length === 0 &&
             Object.keys(data.activitySummary).length === 0;
    }

    function triggerReload() {
      log('⚠️ Page seems broken. Reloading in ' + (RELOAD_DELAY_MS / 1000) + 's...', 'warn');
      saveState(true, intervalSec);
      setTimeout(() => location.reload(), RELOAD_DELAY_MS);
    }

    // ── Auth ───────────────────────────────────────────────────────────────
    function getToken() {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, res => {
          if (res && res.token) resolve(res.token);
          else reject(new Error(res ? res.error : 'No response from background'));
        });
      });
    }

    function requestFocus() {
      return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'FOCUS_TAB' }, res => resolve(res || {}));
      });
    }

    function requestRestoreFocus(prevWindowId, prevTabId) {
      return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'RESTORE_FOCUS', prevWindowId, prevTabId }, res => resolve(res || {}));
      });
    }

    // ── Drive folder picker ────────────────────────────────────────────────
    // Fetches folders from both My Drive and all Shared Drives the user
    // has access to, then shows them in a searchable picker UI.
    async function pickDriveFolder() {
      log('Authenticating with Google...', 'info');
      let token;
      try {
        const res = await new Promise(resolve =>
          chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, resolve)
        );
        token = res && res.token ? res.token : null;
        if (!token) throw new Error('No token available');
      } catch (e) { log('Auth failed: ' + e.message, 'error'); return; }

      log('Loading Drive folders...', 'info');

      // ── 1. Fetch My Drive folders ──────────────────────────────────────
      let myDriveFolders = [];
      try {
        const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,parents,driveId)&pageSize=200&orderBy=name&corpora=user&includeItemsFromAllDrives=false&supportsAllDrives=false`,
          { headers: { Authorization: 'Bearer ' + token } }
        );
        const d = await r.json();
        myDriveFolders = d.files || [];
      } catch (e) { log('Could not load My Drive folders: ' + e.message, 'error'); }

      // ── 2. Fetch Shared Drives list ────────────────────────────────────
      let sharedDrives = [];
      try {
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/drives?pageSize=50&fields=drives(id,name)`,
          { headers: { Authorization: 'Bearer ' + token } }
        );
        const d = await r.json();
        sharedDrives = d.drives || [];
      } catch (e) { log('Could not load Shared Drives: ' + e.message, 'warn'); }

      // ── 3. Fetch folders inside each Shared Drive ──────────────────────
      // Also add the drive root itself as a selectable target.
      let sharedDriveFolders = [];
      for (const drive of sharedDrives) {
        sharedDriveFolders.push({
          id: drive.id, name: drive.name,
          driveId: drive.id, driveName: drive.name, isRoot: true
        });
        try {
          const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and trashed=false`);
          const r = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,parents,driveId)&pageSize=200&orderBy=name&corpora=drive&driveId=${drive.id}&includeItemsFromAllDrives=true&supportsAllDrives=true`,
            { headers: { Authorization: 'Bearer ' + token } }
          );
          const d = await r.json();
          (d.files || []).forEach(f => sharedDriveFolders.push({ ...f, driveName: drive.name }));
        } catch (e) { log('Could not load folders for "' + drive.name + '": ' + e.message, 'warn'); }
      }

      if (myDriveFolders.length === 0 && sharedDriveFolders.length === 0) {
        log('No folders found. Check Drive permissions.', 'warn'); return;
      }

      showFolderPicker(myDriveFolders, sharedDriveFolders);
    }

    // ── Folder picker UI ────────────────────────────────────────────────────
    function showFolderPicker(myDriveFolders, sharedDriveFolders) {
      const old = document.getElementById('__lp_picker');
      if (old) old.remove();

      const picker = document.createElement('div');
      picker.id = '__lp_picker';
      picker.style.cssText = [
        'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
        'background:#0d1117', 'border:1px solid #3b82f6', 'border-radius:10px',
        'z-index:9999999', 'padding:14px', 'width:340px', 'max-height:500px',
        'display:flex', 'flex-direction:column',
        'box-shadow:0 8px 32px rgba(0,0,0,0.9)',
        'font-family:Segoe UI,Arial,sans-serif', 'color:#e0e0e0', 'font-size:13px'
      ].join(';');

      picker.innerHTML = `
        <div style="font-weight:700;color:#60a5fa;margin-bottom:10px;font-size:13px;flex-shrink:0">
          📁 Select Google Drive Folder
        </div>
        <div style="position:relative;margin-bottom:8px;flex-shrink:0">
          <input
            id="__lp_picker_search"
            type="text"
            placeholder="🔍 Search folders..."
            style="width:100%;box-sizing:border-box;background:#111827;border:1px solid #374151;color:#e0e0e0;border-radius:6px;padding:7px 10px;font-size:12px;outline:none;"
          />
        </div>
        <div id="__lp_folder_list" style="flex:1;overflow-y:auto;margin-bottom:10px;min-height:0"></div>
        <div style="flex-shrink:0">
          <button id="__lp_picker_cancel" style="width:100%;background:#374151;border:none;color:#fff;cursor:pointer;border-radius:6px;padding:7px;font-size:12px">Cancel</button>
        </div>
      `;
      document.body.appendChild(picker);

      const list        = document.getElementById('__lp_folder_list');
      const searchInput = document.getElementById('__lp_picker_search');

      // Auto-focus search on open
      setTimeout(() => searchInput && searchInput.focus(), 50);

      // ── Build flat entry list for filtering ──────────────────────────
      const allEntries = [];
      myDriveFolders.forEach(f => allEntries.push({
        id: f.id, name: f.name, displayName: f.name,
        isShared: false, driveName: 'My Drive', isRoot: false
      }));
      sharedDriveFolders.forEach(f => allEntries.push({
        id: f.id, name: f.name, displayName: f.name,
        isShared: true, driveName: f.driveName || 'Shared Drive', isRoot: !!f.isRoot
      }));

      // ── Render list based on current search query ────────────────────
      function renderList(query) {
        list.innerHTML = '';
        const q = query.trim().toLowerCase();
        const filtered = q
          ? allEntries.filter(e =>
              e.name.toLowerCase().includes(q) ||
              e.driveName.toLowerCase().includes(q)
            )
          : allEntries;

        if (filtered.length === 0) {
          const empty = document.createElement('div');
          empty.className = '__lp_picker_empty';
          empty.textContent = 'No folders match "' + query + '"';
          list.appendChild(empty);
          return;
        }

        if (q) {
          // Flat results when searching — show drive name as sub-label
          filtered.forEach(f => appendFolderBtn(list, f, true));
        } else {
          // Grouped view — My Drive first, then each Shared Drive
          const myEntries = filtered.filter(e => !e.isShared);
          if (myEntries.length > 0) {
            appendSectionLabel(list, '📂 My Drive');
            myEntries.forEach(f => appendFolderBtn(list, f, false));
          }
          const sharedEntries = filtered.filter(e => e.isShared);
          if (sharedEntries.length > 0) {
            const driveNames = [];
            sharedEntries.forEach(e => { if (!driveNames.includes(e.driveName)) driveNames.push(e.driveName); });
            driveNames.forEach(driveName => {
              appendSectionLabel(list, '🔵 ' + driveName);
              sharedEntries.filter(e => e.driveName === driveName)
                           .forEach(f => appendFolderBtn(list, f, false));
            });
          }
        }
      }

      function appendSectionLabel(container, text) {
        const lbl = document.createElement('div');
        lbl.className = '__lp_picker_section_label';
        lbl.textContent = text;
        container.appendChild(lbl);
      }

      function appendFolderBtn(container, f, showDrive) {
        const btn = document.createElement('button');
        btn.className = '__lp_picker_folder_btn' + (f.isShared ? ' shared' : '');
        const icon = f.isRoot ? '🔵' : '📁';
        let label = icon + ' ' + f.displayName;
        if (showDrive) {
          label += `<span style="display:block;font-size:10px;color:#6b7280;margin-top:1px">${f.isShared ? f.driveName : 'My Drive'}</span>`;
        }
        btn.innerHTML = label;
        btn.onclick = () => {
          if (driveFolderId && driveFolderId !== f.id) clearDriveFileIdCache(driveFolderId);
          driveFolderId = f.id;
          driveFolderNm = f.isShared
            ? (f.isRoot ? f.name : f.driveName + ' / ' + f.name)
            : f.name;
          saveFolderInfo(driveFolderId, driveFolderNm);
          updateFolderDisplay();
          log('✅ Drive folder set: ' + driveFolderNm, 'success');
          picker.remove();
        };
        container.appendChild(btn);
      }

      // Initial render (no search)
      renderList('');

      // Live search
      searchInput.addEventListener('input', () => renderList(searchInput.value));

      // Cancel button
      document.getElementById('__lp_picker_cancel').onclick = () => picker.remove();

      // Escape key closes picker
      function onKey(e) {
        if (e.key === 'Escape') { picker.remove(); document.removeEventListener('keydown', onKey); }
      }
      document.addEventListener('keydown', onKey);
      const obs = new MutationObserver(() => {
        if (!document.getElementById('__lp_picker')) {
          document.removeEventListener('keydown', onKey);
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true });
    }

    // ── CSV helpers ────────────────────────────────────────────────────────
    function esc(v) {
      const s = String(v == null ? '' : v).replace(/"/g, '""');
      return (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0)
        ? '"' + s + '"' : s;
    }

    // ── activity_summary.csv ───────────────────────────────────────────────
    function csvActivitySummary(data) {
      const L = [['Metric', 'Value'].map(esc).join(',')];
      Object.entries(data.activitySummary).forEach(([k, v]) => {
        L.push([esc(k), esc(v)].join(','));
      });
      return L.join('\r\n');
    }

    // ── queue_summary.csv ──────────────────────────────────────────────────
    function csvQueueSummary(data) {
      if (data.queueSummary.length === 0) return 'Skill,In Queue,Wait Time\r\n';
      const L = [['Skill', 'In Queue', 'Wait Time'].map(esc).join(',')];
      data.queueSummary.forEach(row => {
        L.push([esc(row.skill), esc(row.inQueue), esc(row.waitTime)].join(','));
      });
      return L.join('\r\n');
    }

    // ── agents.csv ─────────────────────────────────────────────────────────
    function csvAgents(data) {
      if (data.agents.length === 0) {
        return 'Agent Name,Status,Status Duration,Group,Active,Assigned,Closed,Load,Online Rate,CSAT,Max Slots,Transfers,Transfer Rate,Skills\r\n';
      }
      const maxSkills = Math.max(0, ...data.agents.map(a => (a.skills || []).length));
      const skillHeaders = Array.from({ length: maxSkills }, (_, i) => 'Skill ' + (i + 1));
      const headers = [
        'Agent Name', 'Status', 'Status Duration', 'Group',
        'Active', 'Assigned', 'Closed', 'Load', 'Online Rate',
        'CSAT', 'Max Slots', 'Transfers', 'Transfer Rate',
        ...skillHeaders
      ];
      const L = [headers.map(esc).join(',')];
      data.agents.forEach(a => {
        const skillCols = Array.from({ length: maxSkills }, (_, i) => esc((a.skills || [])[i] || ''));
        L.push([
          esc(a.name),
          esc(a.status),
          esc(a.statusDuration),
          esc(a.group),
          esc(a.activeConvs),
          esc(a.assignedConvs),
          esc(a.closedConvs),
          esc(a.load),
          esc(a.onlineRate),
          esc(a.csat),
          esc(a.maxSlots),
          esc(a.transfers),
          esc(a.transferRate),
          ...skillCols
        ].join(','));
      });
      return L.join('\r\n');
    }

    // ── conversations.csv ──────────────────────────────────────────────────
    function csvConversations(data) {
      const conversations = data.conversations || [];
      if (conversations.length === 0) {
        return 'Visitor Name,Status,Response Time,Agent Name,Agent Group,Skill,Start Time,CSAT Score\r\n';
      }
      const headers = [
        'Visitor Name', 'Status', 'Response Time',
        'Agent Name', 'Agent Group', 'Skill',
        'Start Time', 'CSAT Score'
      ];
      const L = [headers.map(esc).join(',')];
      conversations.forEach(c => {
        L.push([
          esc(c.visitorName),
          esc(c.status),
          esc(c.responseTime),
          esc(c.agentName),
          esc(c.agentGroupName),
          esc(c.skill),
          esc(c.startTimestamp),
          esc(c.csatScore)
        ].join(','));
      });
      return L.join('\r\n');
    }

    // ── combined_summary.csv ───────────────────────────────────────────────
    function csvCombined(data) {
      const now = new Date(), p = n => n < 10 ? '0' + n : n;
      const ls = now.getFullYear() + '-' + p(now.getMonth()+1) + '-' + p(now.getDate()) +
                 ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
      const L = [];
      L.push('ASHLEY LIVEPERSON CHAT - MANAGER WORKSPACE SNAPSHOT');
      L.push('Snapshot Time (Local),' + esc(ls));
      L.push('Snapshot Time (UTC),'   + esc(now.toISOString()));
      L.push('Snapshot #,' + snapCount);
      L.push('');
      L.push('=== ACTIVITY SUMMARY ===');
      L.push(csvActivitySummary(data));
      L.push('');
      L.push('=== QUEUE SUMMARY ===');
      L.push(csvQueueSummary(data));
      L.push('');
      L.push('=== AGENTS ===');
      L.push(csvAgents(data));
      L.push('');
      L.push('=== CONVERSATIONS ===');
      L.push(csvConversations(data));
      return L.join('\r\n');
    }

    // ── Assemble all files ─────────────────────────────────────────────────
    function buildFiles(data) {
      return [
        { name: 'combined_summary.csv',  content: csvCombined(data)        },
        { name: 'activity_summary.csv',  content: csvActivitySummary(data) },
        { name: 'queue_summary.csv',     content: csvQueueSummary(data)    },
        { name: 'agents.csv',            content: csvAgents(data)          },
        { name: 'conversations.csv',     content: csvConversations(data)   }
      ];
    }

    // ── Drive upload ───────────────────────────────────────────────────────
    async function uploadToDrive(files) {
      if (!driveFolderId) { log('No Drive folder set!', 'error'); return false; }
      try { await getToken(); } catch (e) { log('Auth failed: ' + e.message, 'error'); return false; }
      log('Uploading ' + files.length + ' files to Drive...', 'info');
      let allOk = true;
      for (const f of files) {
        const res = await new Promise(resolve =>
          chrome.runtime.sendMessage(
            { type: 'UPLOAD_TO_DRIVE', folderId: driveFolderId, fileName: f.name, content: f.content },
            resolve
          )
        );
        if (res && res.ok) {
          console.log('[LP] ' + f.name + ' → Drive ID: ' + (res.result?.id || '?'));
        } else {
          log('❌ Upload failed: ' + f.name + ' — ' + (res?.error || 'unknown'), 'error');
          allOk = false;
        }
      }
      return allOk;
    }

    // ── Fallback download ──────────────────────────────────────────────────
    function fallbackDownload(files) {
      files.forEach((f, idx) => {
        setTimeout(() => {
          const blob = new Blob([f.content], { type: 'text/csv' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = f.name; a.style.display = 'none';
          document.body.appendChild(a); a.click();
          setTimeout(() => { if (a.parentNode) document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
        }, idx * 300);
      });
    }

    // ── UI update ──────────────────────────────────────────────────────────
    function updateUI(data) {
      if (!data) return;
      const act = data.activitySummary || {};
      const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '-'; };
      s('__lp_m_assigned', act['Assigned']);
      s('__lp_m_load',     act['Load']);
      s('__lp_m_closed',   act['Closed']);
      s('__lp_m_csat',     act['CSAT']);
      const inf = document.getElementById('__lp_snap_info');
      if (inf) inf.textContent = 'Agents: ' + (data.agents || []).length + ' | Snapshots: ' + snapCount;

      // Push update to popup if open
      try {
        chrome.runtime.sendMessage({
          type:            'LP_METRICS_UPDATE',
          activitySummary: act,
          agentCount:      (data.agents || []).length,
          snapCount:       snapCount
        });
      } catch (e) {}
    }

    // ── Snapshot ───────────────────────────────────────────────────────────
    async function doSnap() {
      log('Capturing...', 'info');
      let focusInfo = {};
      try { focusInfo = await requestFocus(); } catch (e) { log('Focus request failed: ' + e.message, 'warn'); }
      await sleep(600);

      let data;
      try { data = await scrape(); } catch (e) { log('Err: ' + e.message, 'error'); return; }

      if (focusInfo.restored && focusInfo.prevWindowId) {
        try { await requestRestoreFocus(focusInfo.prevWindowId, focusInfo.prevTabId); }
        catch (e) { console.warn('[LP] Focus restore failed:', e.message); }
      }

      if (!data) return;

      if (isDataEmpty(data)) {
        emptyStreak++;
        log('⚠️ Empty data (' + emptyStreak + '/' + RELOAD_THRESHOLD + ')', 'warn');
        if (emptyStreak >= RELOAD_THRESHOLD) { triggerReload(); return; }
        return;
      }
      emptyStreak = 0;
      snapCount++;

      const files = buildFiles(data);
      const convCount = (data.conversations || []).length;

      if (driveFolderId) {
        const ok = await uploadToDrive(files);
        if (ok) log('✅ Drive upload #' + snapCount + ' — ' + data.agents.length + ' agents, ' + convCount + ' convs', 'success');
        else    log('⚠️ Some files failed — check console', 'warn');
      } else {
        log('⚠️ No Drive folder — using fallback download', 'warn');
        fallbackDownload(files);
        log('✅ CSVs #' + snapCount + ' downloaded', 'success');
      }

      updateUI(data);
      const lt = document.getElementById('__lp_last_time');
      if (lt) lt.textContent = new Date().toLocaleTimeString() + ' (#' + snapCount + ')';
    }

    // ── Auto-run controls ──────────────────────────────────────────────────
    function setRunUI(r) {
      isRunning = r;
      const dot = document.getElementById('__lp_dot');
      if (dot) dot.className = r ? 'running' : '';
      const bs = document.getElementById('__lp_btn_start');
      const bp = document.getElementById('__lp_btn_stop');
      if (bs) bs.disabled = r; if (bp) bp.disabled = !r;
    }

    function stopAuto(persist = true) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (cdTimer)   { clearInterval(cdTimer);   cdTimer   = null; }
      setRunUI(false);
      const cd = document.getElementById('__lp_countdown');
      if (cd) cd.textContent = '';
      if (persist) saveState(false, intervalSec);
      log('Stopped', 'warn');
    }

    async function startAuto(resuming = false) {
      if (!driveFolderId && !resuming) {
        log('Please set a Google Drive folder first.', 'warn');
        await pickDriveFolder();
        if (!driveFolderId) return;
      }
      setRunUI(true);
      saveState(true, intervalSec);
      log((resuming ? '🔄 Resumed' : 'Auto started') + ' (' + intervalSec + 's)', 'success');
      doSnap();
      let rem = intervalSec;
      if (cdTimer) clearInterval(cdTimer);
      cdTimer = setInterval(() => {
        rem--;
        if (rem < 0) rem = intervalSec;
        const el = document.getElementById('__lp_countdown');
        if (el) el.textContent = rem > 0 ? 'Next:' + rem + 's' : '...';
      }, 1000);
      autoTimer = setInterval(() => { doSnap(); rem = intervalSec; }, intervalSec * 1000);
    }

    // ── Message listener (from popup) ──────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'LP_START_AUTO') {
        startAuto(false).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === 'LP_STOP_AUTO') {
        stopAuto(true);
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'LP_MANUAL_SNAP') {
        doSnap().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === 'LP_EXPORT_CSV') {
        scrape().then(data => {
          if (!data) { sendResponse({ ok: false, error: 'No data' }); return; }
          fallbackDownload(buildFiles(data));
          log('✅ All CSVs Exported Manually', 'success');
          sendResponse({ ok: true });
        });
        return true;
      }
      if (msg.type === 'LP_PICK_FOLDER') {
        pickDriveFolder().then(() => sendResponse({ ok: true, name: driveFolderNm }));
        return true;
      }
      if (msg.type === 'LP_DISCONNECT_DRIVE') {
        if (driveFolderId) clearDriveFileIdCache(driveFolderId);
        driveFolderId = null; driveFolderNm = null;
        clearFolderInfo(); updateFolderDisplay();
        if (isRunning) stopAuto(true);
        log('Drive folder disconnected', 'warn');
        sendResponse({ ok: true });
        return true;
      }
    });

    // ── Button wiring ──────────────────────────────────────────────────────
    document.getElementById('__lp_btn_start').onclick = () => startAuto(false);
    document.getElementById('__lp_btn_stop').onclick  = () => stopAuto(true);
    document.getElementById('__lp_btn_manual').onclick = () => { log('Manual snapshot', 'info'); doSnap(); };
    document.getElementById('__lp_btn_export').onclick = async () => {
      log('Exporting All CSVs Now...', 'info');
      let data;
      try { data = await scrape(); } catch (e) { log('Err: ' + e.message, 'error'); return; }
      if (!data) return;
      fallbackDownload(buildFiles(data));
      log('✅ All CSVs Exported Manually', 'success');
    };
    document.getElementById('__lp_btn_path').onclick = () => pickDriveFolder();
    document.getElementById('__lp_btn_disconnect').onclick = () => {
      if (driveFolderId) clearDriveFileIdCache(driveFolderId);
      driveFolderId = null; driveFolderNm = null;
      clearFolderInfo(); updateFolderDisplay();
      if (isRunning) stopAuto(true);
      log('Drive folder disconnected', 'warn');
    };
    document.getElementById('__lp_btn_apply').onclick = () => {
      const v = parseInt(document.getElementById('__lp_interval').value || '30');
      if (v >= 10) {
        intervalSec = v; saveState(isRunning, intervalSec);
        log('Interval: ' + v + 's', 'info');
        if (isRunning) { stopAuto(false); startAuto(true); }
      } else { log('Min 10s', 'warn'); }
    };
    document.getElementById('__lp_toggle').onclick = () => {
      const ovEl = document.getElementById('__lp_overlay');
      const btn  = document.getElementById('__lp_toggle');
      if (ovEl.classList.contains('collapsed')) { ovEl.classList.remove('collapsed'); btn.textContent = '▲'; }
      else { ovEl.classList.add('collapsed'); btn.textContent = '▼'; }
    };

    // ── Drag ───────────────────────────────────────────────────────────────
    (function () {
      const ovEl = document.getElementById('__lp_overlay');
      const hdr  = document.getElementById('__lp_header');
      let dx = 0, dy = 0, x = 0, y = 0, dragging = false;
      hdr.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true; x = e.clientX; y = e.clientY;
        const rect = ovEl.getBoundingClientRect(); dx = rect.left; dy = rect.top;
        if (isNaN(dx)) { dx = parseInt(ovEl.style.left) || 0; }
        if (isNaN(dy)) { dy = parseInt(ovEl.style.top)  || 0; }
        document.addEventListener('mousemove', onM);
        document.addEventListener('mouseup',   onU);
        e.preventDefault();
      });
      function onM(e) {
        if (!dragging) return;
        let nx = dx + (e.clientX - x), ny = dy + (e.clientY - y);
        nx = Math.max(0, Math.min(window.innerWidth  - ovEl.offsetWidth, nx));
        ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
        ovEl.style.left = nx + 'px'; ovEl.style.top = ny + 'px'; ovEl.style.right = 'auto';
      }
      function onU() { dragging = false; document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU); }
    })();

    // ── Initial load ───────────────────────────────────────────────────────
    (async () => {
      await sleep(2000);
      const init = await scrape();
      updateUI(init);
      updateFolderDisplay();
      const agentCount = init ? (init.agents || []).length : 0;
      const queueCount = init ? (init.queueSummary || []).length : 0;
      const convCount  = init ? (init.conversations || []).length : 0;
      log('✅ LP Scraper ready! ' + agentCount + ' agents, ' + queueCount + ' skills, ' + convCount + ' convs', 'success');
      if (savedState.wasRunning && driveFolderId) {
        log('🔄 Auto-resuming after reload...', 'info');
        await startAuto(true);
      } else {
        log('Click Start Auto or Set Google Drive Folder.', 'info');
      }
    })();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  waitForApp(appFound => {
    if (!appFound) {
      console.log('[LP Scraper] Dashboard widgets not detected, injecting anyway...');
    }
    loadState(res => {
      inject({
        wasRunning: !!res[STORAGE_KEY_STATE],
        interval:   res[STORAGE_KEY_INTERVAL] || 30,
        folder:     res[STORAGE_KEY_FOLDER]   || null
      });
      observeRoute();
    });
  });

})();