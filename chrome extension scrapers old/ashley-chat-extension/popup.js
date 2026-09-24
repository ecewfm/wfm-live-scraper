// Ashley LivePerson Chat Scraper — popup.js
// All popup logic lives here (MV3 requires external JS file, not inline scripts).

'use strict';

const STORAGE_KEY_STATE  = 'lp_auto_state';
const STORAGE_KEY_FOLDER = 'lp_drive_folder';

let lpTabId         = null;
let isRunning       = false;
let driveFolderId   = null;
let driveFolderNm   = null;
let autologinPaused = false;
let clearPending    = false;   // 2-step clear — no confirm() needed
let statusTimer     = null;

// ── Activity log ──────────────────────────────────────────────────────────────
function log(msg, type) {
  const box = document.getElementById('log-box');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'log-entry ' + (type || 'info');
  d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  box.insertBefore(d, box.firstChild);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}

// ── Credentials status banner ─────────────────────────────────────────────────
// type: 'ok' | 'warn' | 'err'
function showStatus(msg, type, autohideMs) {
  const el = document.getElementById('creds-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'visible ' + (type || 'ok');
  if (statusTimer) clearTimeout(statusTimer);
  if (autohideMs) {
    statusTimer = setTimeout(() => hideStatus(), autohideMs);
  }
}

function hideStatus() {
  const el = document.getElementById('creds-status');
  if (el) el.className = '';   // removes 'visible' → display:none via CSS
}

// ── Auto-login toggle rendering ───────────────────────────────────────────────
function renderToggle() {
  const btn   = document.getElementById('autologin-toggle');
  const label = document.getElementById('autologin-state-label');
  if (!btn || !label) return;
  if (autologinPaused) {
    btn.classList.add('paused');
    label.textContent = 'Paused';
    label.style.color = '#f59e0b';
  } else {
    btn.classList.remove('paused');
    label.textContent = 'Enabled';
    label.style.color = '#22c55e';
  }
}

// ── Detect LP tab ─────────────────────────────────────────────────────────────
function detectTab() {
  chrome.tabs.query({}, tabs => {
    const lpTab = tabs.find(t => t.url && t.url.includes('z1.le.liveperson.net'));
    const dot    = document.getElementById('page-dot');
    const status = document.getElementById('page-status');
    if (lpTab) {
      lpTabId = lpTab.id;
      dot.className      = 'status-dot found';
      status.textContent = '✅ Dashboard found (Tab #' + lpTab.id + ')';
      document.getElementById('btn-manual').disabled = false;
      document.getElementById('btn-export').disabled = false;
      document.getElementById('btn-start').disabled  = isRunning;
    } else {
      lpTabId = null;
      dot.className      = 'status-dot';
      status.textContent = '⚠️ Open z1.le.liveperson.net/amd/dashboard';
      document.getElementById('btn-manual').disabled = true;
      document.getElementById('btn-export').disabled = true;
      document.getElementById('btn-start').disabled  = true;
    }
  });
}

function updateFolderDisplay() {
  const dd  = document.getElementById('drive-display');
  const btn = document.getElementById('btn-disconnect');
  if (driveFolderId) {
    dd.textContent  = '✅ Drive: ' + driveFolderNm;
    dd.className    = 'drive-display';
    btn.style.display = '';
  } else {
    dd.textContent  = 'No Drive folder set';
    dd.className    = 'drive-display none';
    btn.style.display = 'none';
  }
}

function sendToContent(msg, cb) {
  if (!lpTabId) { if (cb) cb({ error: 'No LP tab found' }); return; }
  chrome.tabs.sendMessage(lpTabId, msg, res => cb && cb(res || {}));
}

// ── Reset clear button to its default state ───────────────────────────────────
function resetClearBtn() {
  clearPending = false;
  const btn = document.getElementById('btn-clear-creds');
  btn.textContent = '🗑';
  btn.style.background = '';   // reverts to .btn-danger CSS class
  btn.title = 'Clear saved credentials';
}

// ── Load all persisted state on popup open ────────────────────────────────────
chrome.storage.local.get(
  [STORAGE_KEY_STATE, STORAGE_KEY_FOLDER, 'lp_credentials', 'lp_autologin_paused'],
  res => {
    isRunning       = !!res[STORAGE_KEY_STATE];
    driveFolderId   = res[STORAGE_KEY_FOLDER] ? res[STORAGE_KEY_FOLDER].id   : null;
    driveFolderNm   = res[STORAGE_KEY_FOLDER] ? res[STORAGE_KEY_FOLDER].name : null;
    autologinPaused = !!res.lp_autologin_paused;

    document.getElementById('btn-start').disabled = isRunning;
    document.getElementById('btn-stop').disabled  = !isRunning;
    if (isRunning) log('Auto-scraper is running', 'success');

    updateFolderDisplay();
    renderToggle();
    detectTab();

    if (res.lp_credentials) {
      document.getElementById('cred-user').value = res.lp_credentials.username || '';
      document.getElementById('cred-pass').value = res.lp_credentials.password || '';
      showStatus('✅ Credentials on file: ' + res.lp_credentials.username, 'ok');
    }
  }
);

// ── React to storage changes pushed from content script ───────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY_STATE]) {
    isRunning = !!changes[STORAGE_KEY_STATE].newValue;
    document.getElementById('btn-start').disabled = isRunning;
    document.getElementById('btn-stop').disabled  = !isRunning;
  }
  if (changes[STORAGE_KEY_FOLDER]) {
    const f = changes[STORAGE_KEY_FOLDER].newValue;
    driveFolderId = f ? f.id   : null;
    driveFolderNm = f ? f.name : null;
    updateFolderDisplay();
  }
});

// ── Metric updates from content script ───────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'LP_METRICS_UPDATE') return;
  const act = msg.activitySummary || {};
  const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '-'; };
  s('m-assigned', act['Assigned']);
  s('m-load',     act['Load']);
  s('m-closed',   act['Closed']);
  s('m-csat',     act['CSAT']);
  const inf = document.getElementById('snap-info');
  if (inf) inf.textContent = 'Agents: ' + (msg.agentCount || 0) + ' | Snapshots: ' + (msg.snapCount || 0);
  if (msg.logMsg) log(msg.logMsg, msg.logType || 'info');
});

// ── Controls ──────────────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  sendToContent({ type: 'LP_START_AUTO' }, res => {
    if (res && res.ok) {
      log('Auto started', 'success');
      document.getElementById('btn-start').disabled = true;
      document.getElementById('btn-stop').disabled  = false;
    } else {
      log('Could not start: ' + (res?.error || 'unknown'), 'error');
    }
  });
});

document.getElementById('btn-stop').addEventListener('click', () => {
  sendToContent({ type: 'LP_STOP_AUTO' }, () => {
    log('Stopped', 'warn');
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled  = true;
  });
});

document.getElementById('btn-manual').addEventListener('click', () => {
  log('Manual snapshot triggered...', 'info');
  sendToContent({ type: 'LP_MANUAL_SNAP' }, res => {
    if (res && res.ok) log('✅ Snapshot complete', 'success');
    else log('Snapshot error: ' + (res?.error || 'unknown'), 'error');
  });
});

document.getElementById('btn-export').addEventListener('click', () => {
  log('Exporting CSVs...', 'info');
  sendToContent({ type: 'LP_EXPORT_CSV' }, res => {
    if (res && res.ok) log('✅ CSVs exported', 'success');
    else log('Export error: ' + (res?.error || 'unknown'), 'error');
  });
});

document.getElementById('btn-folder').addEventListener('click', () => {
  log('Opening folder picker...', 'info');
  sendToContent({ type: 'LP_PICK_FOLDER' }, res => {
    if (res && res.ok) log('✅ Folder set: ' + (res.name || ''), 'success');
    else log('Folder pick cancelled or failed', 'warn');
  });
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  chrome.storage.local.remove(STORAGE_KEY_FOLDER, () => {
    driveFolderId = null; driveFolderNm = null;
    updateFolderDisplay();
    log('Drive disconnected', 'warn');
    sendToContent({ type: 'LP_DISCONNECT_DRIVE' }, () => {});
  });
});

// ── Auto-login toggle ─────────────────────────────────────────────────────────
document.getElementById('autologin-toggle').addEventListener('click', () => {
  autologinPaused = !autologinPaused;
  renderToggle();   // instant visual — don't wait for storage
  chrome.storage.local.set({ lp_autologin_paused: autologinPaused }, () => {
    if (autologinPaused) {
      showStatus('⏸  Auto-login paused — navigate to LP freely', 'warn', 4000);
      log('Auto-login paused', 'warn');
    } else {
      showStatus('▶  Auto-login re-enabled', 'ok', 3000);
      log('Auto-login enabled', 'success');
    }
  });
});

// ── Save Credentials ──────────────────────────────────────────────────────────
document.getElementById('btn-save-creds').addEventListener('click', () => {
  resetClearBtn();   // cancel any pending clear
  const username = document.getElementById('cred-user').value.trim();
  const password = document.getElementById('cred-pass').value;
  if (!username || !password) {
    showStatus('⚠️  Enter both email and password first', 'warn', 4000);
    return;
  }
  chrome.storage.local.set({ lp_credentials: { username, password } }, () => {
    const ts = new Date().toLocaleTimeString();
    showStatus('✅  Saved at ' + ts + '\n' + username, 'ok', 6000);
    log('💾 Credentials saved for ' + username, 'success');
  });
});

// ── Clear Credentials (2-step — no confirm() dialog needed) ──────────────────
document.getElementById('btn-clear-creds').addEventListener('click', () => {
  if (!clearPending) {
    // Step 1: warn and wait for a second click
    clearPending = true;
    const btn = document.getElementById('btn-clear-creds');
    btn.textContent        = '✓?';
    btn.style.background   = 'linear-gradient(135deg,#92400e,#f59e0b)';
    btn.title              = 'Click again to confirm clear';
    showStatus('⚠️  Tap 🗑 again to confirm — clears saved login', 'warn');

    // Auto-cancel after 4 s
    setTimeout(() => {
      if (clearPending) {
        resetClearBtn();
        chrome.storage.local.get('lp_credentials', r => {
          if (r.lp_credentials) showStatus('✅ Credentials on file: ' + r.lp_credentials.username, 'ok');
          else hideStatus();
        });
      }
    }, 4000);

  } else {
    // Step 2: confirmed
    resetClearBtn();
    chrome.storage.local.remove('lp_credentials', () => {
      document.getElementById('cred-user').value = '';
      document.getElementById('cred-pass').value = '';
      showStatus('🗑  Credentials cleared — overlay will appear on next LP login', 'warn', 6000);
      log('🗑 Credentials cleared', 'warn');
    });
  }
});

// ── Refresh tab detection every 3 s ──────────────────────────────────────────
setInterval(detectTab, 3000);
