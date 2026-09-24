// Ashley LivePerson Chat Scraper - background.js

// ── Token Manager ─────────────────────────────────────────────────────────────
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
let   cachedToken    = null;
let   tokenFetchedAt = 0;
let   refreshAlarm   = null;

async function getFreshToken(forceRefresh = false) {
  const age   = Date.now() - tokenFetchedAt;
  const stale = age > TOKEN_REFRESH_INTERVAL_MS;

  if (forceRefresh || stale || !cachedToken) {
    if (cachedToken) {
      await new Promise(resolve =>
        chrome.identity.removeCachedAuthToken({ token: cachedToken }, resolve)
      );
      cachedToken = null;
    }
    const token = await new Promise((resolve, reject) =>
      chrome.identity.getAuthToken({ interactive: false }, t => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      })
    );
    cachedToken    = token;
    tokenFetchedAt = Date.now();
    console.log('[LP] Token refreshed at', new Date().toLocaleTimeString());
  }
  return cachedToken;
}

function scheduleTokenRefresh() {
  if (refreshAlarm) clearInterval(refreshAlarm);
  refreshAlarm = setInterval(async () => {
    try {
      await getFreshToken(true);
      console.log('[LP] Proactive token refresh OK');
    } catch (e) {
      console.warn('[LP] Proactive token refresh failed:', e.message);
    }
  }, TOKEN_REFRESH_INTERVAL_MS);
}

// ── Tab Focus Manager ─────────────────────────────────────────────────────────
async function focusLPTab() {
  return new Promise((resolve, reject) => {
    chrome.windows.getLastFocused({ populate: true }, prevWindow => {
      const prevWindowId = prevWindow ? prevWindow.id : null;
      const prevTabId    = prevWindow ? (prevWindow.tabs.find(t => t.active) || {}).id : null;

      chrome.tabs.query({ url: 'https://*.le.liveperson.net/*' }, tabs => {
        if (!tabs || tabs.length === 0) {
          resolve({ restored: false });
          return;
        }
        const lpTab = tabs[0];
        chrome.windows.update(lpTab.windowId, { focused: true }, () => {
          chrome.tabs.update(lpTab.id, { active: true }, () => {
            setTimeout(() => {
              resolve({ restored: true, prevWindowId, prevTabId, lpTabId: lpTab.id });
            }, 400);
          });
        });
      });
    });
  });
}

async function restoreFocus(prevWindowId, prevTabId) {
  if (!prevWindowId) return;
  return new Promise(resolve => {
    chrome.windows.update(prevWindowId, { focused: true }, () => {
      if (prevTabId) {
        chrome.tabs.update(prevTabId, { active: true }, () => resolve());
      } else {
        resolve();
      }
    });
  });
}

// ── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Save login credentials from autologin overlay ────────────────────────
  if (msg.type === 'SAVE_CREDENTIALS') {
    chrome.storage.local.set({ lp_credentials: { username: msg.username, password: msg.password } }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Return stored login credentials to autologin.js ─────────────────────
  if (msg.type === 'GET_CREDENTIALS') {
    chrome.storage.local.get('lp_credentials', res => {
      if (res.lp_credentials) {
        sendResponse({ username: res.lp_credentials.username, password: res.lp_credentials.password });
      } else {
        sendResponse({});
      }
    });
    return true;
  }

  // ── Google OAuth token ───────────────────────────────────────────────────
  if (msg.type === 'GET_AUTH_TOKEN') {
    getFreshToken(false)
      .then(token => sendResponse({ token }))
      .catch(() => {
        chrome.identity.getAuthToken({ interactive: true }, token => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            cachedToken    = token;
            tokenFetchedAt = Date.now();
            scheduleTokenRefresh();
            sendResponse({ token });
          }
        });
      });
    return true;
  }

  // ── Force refresh token ──────────────────────────────────────────────────
  if (msg.type === 'REFRESH_AUTH_TOKEN') {
    getFreshToken(true)
      .then(token => sendResponse({ token }))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }

  // ── Focus the LivePerson tab before scraping ─────────────────────────────
  if (msg.type === 'FOCUS_TAB') {
    focusLPTab()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Restore focus to previous tab/window after scraping ──────────────────
  if (msg.type === 'RESTORE_FOCUS') {
    const { prevWindowId, prevTabId } = msg;
    restoreFocus(prevWindowId, prevTabId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Upload a file to Google Drive (create or update) ─────────────────────
  if (msg.type === 'UPLOAD_TO_DRIVE') {
    const { folderId, fileName, content } = msg;
    handleDriveUpload(folderId, fileName, content)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Clear file ID cache for a folder (call when folder changes) ──────────
  if (msg.type === 'CLEAR_FILE_ID_CACHE') {
    const { folderId } = msg;
    chrome.storage.local.get('lp_drive_file_ids', res => {
      const cache = res.lp_drive_file_ids || {};
      if (folderId) {
        // Remove only entries for this folder
        Object.keys(cache).forEach(k => { if (k.startsWith(folderId + '/')) delete cache[k]; });
      } else {
        // Clear all
        Object.keys(cache).forEach(k => delete cache[k]);
      }
      chrome.storage.local.set({ lp_drive_file_ids: cache }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // ── Scrape the LivePerson dashboard by injecting a function ───────────────
  if (msg.type === 'SCRAPE_LP') {
    chrome.tabs.query({ url: 'https://*.le.liveperson.net/*' }, tabs => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ ok: false, error: 'LivePerson tab not found' });
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: scrapeLivePerson
      }, results => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const result = results && results[0] && results[0].result;
        if (result) {
          sendResponse({ ok: true, data: result });
        } else {
          sendResponse({ ok: false, error: 'No data returned from scraper' });
        }
      });
    });
    return true;
  }

});

// ── Drive upload helper ───────────────────────────────────────────────────────
// File ID cache: { "folderId/fileName": "driveFileId" }
// Stored in chrome.storage.local under key "lp_drive_file_ids"
// This ensures we always update the SAME file and never create duplicates.

async function getCachedFileId(folderId, fileName) {
  return new Promise(resolve => {
    chrome.storage.local.get('lp_drive_file_ids', res => {
      const cache = res.lp_drive_file_ids || {};
      resolve(cache[folderId + '/' + fileName] || null);
    });
  });
}

async function setCachedFileId(folderId, fileName, fileId) {
  return new Promise(resolve => {
    chrome.storage.local.get('lp_drive_file_ids', res => {
      const cache = res.lp_drive_file_ids || {};
      cache[folderId + '/' + fileName] = fileId;
      chrome.storage.local.set({ lp_drive_file_ids: cache }, resolve);
    });
  });
}

async function getToken() {
  let token;
  try {
    token = await getFreshToken(false);
  } catch (e) {
    token = await new Promise((resolve, reject) =>
      chrome.identity.getAuthToken({ interactive: false }, t => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      })
    );
  }
  if (!token) throw new Error('No auth token available');
  return token;
}

async function doUpload(token, fileId, folderId, fileName, content) {
  const blob     = new Blob([content], { type: 'text/csv' });
  const metadata = { name: fileName, mimeType: 'text/csv' };
  if (!fileId) metadata.parents = [folderId];

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const uploadUrl = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;

  const res = await fetch(uploadUrl, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form
  });

  return res;
}

// ── Check whether a cached file ID is still alive AND not in the trash ───────
async function checkFileStatus(token, fileId) {
  // Request trashed flag alongside id so we know if it's in the bin
  const res  = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,trashed&supportsAllDrives=true`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (res.status === 404) return 'missing';   // permanently deleted or never existed
  if (!res.ok)            return 'error';
  const data = await res.json();
  if (data.trashed)       return 'trashed';   // in the bin — treat same as missing
  return 'ok';
}

async function handleDriveUpload(folderId, fileName, content) {
  let token = await getToken();

  // 1. Check local cache for a known file ID
  let fileId = await getCachedFileId(folderId, fileName);

  // 2. If we have a cached ID, verify it is still alive and NOT in the trash.
  //    Drive happily accepts PATCH on trashed files (returns 200), so we must
  //    check BEFORE uploading — not after.
  if (fileId) {
    const status = await checkFileStatus(token, fileId);
    if (status === 'trashed' || status === 'missing') {
      console.log('[LP] Cached file for ' + fileName + ' is ' + status + ' — will create a new file');
      await setCachedFileId(folderId, fileName, null);
      fileId = null;
    }
    // 'error' means the metadata check itself failed (e.g. network blip);
    // fall through and let the upload attempt handle it.
  }

  // 3. If no valid cached ID, search Drive for a live (non-trashed) file
  if (!fileId) {
    const searchUrl =
      `https://www.googleapis.com/drive/v3/files?` +
      `q=${encodeURIComponent(`name='${fileName}' and '${folderId}' in parents and trashed=false`)}` +
      `&fields=files(id,name)&orderBy=createdTime&supportsAllDrives=true`;

    const searchRes  = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
      // Always use the FIRST (oldest) file — cache it so we never search again
      fileId = searchData.files[0].id;
      await setCachedFileId(folderId, fileName, fileId);
      console.log('[LP] Found existing Drive file for ' + fileName + ': ' + fileId +
        (searchData.files.length > 1 ? ' (' + (searchData.files.length - 1) + ' duplicate(s) ignored)' : ''));
    }
  }

  // 4. Upload (create if no fileId, update if we have one)
  let uploadRes = await doUpload(token, fileId, folderId, fileName, content);

  // 5. Handle stale cached ID (permanently deleted — hard 404, not trash)
  if (!uploadRes.ok && uploadRes.status === 404 && fileId) {
    console.log('[LP] File ID 404 for ' + fileName + ' — creating new file');
    await setCachedFileId(folderId, fileName, null);
    fileId    = null;
    uploadRes = await doUpload(token, null, folderId, fileName, content);
  }

  // 6. Handle expired token
  if (!uploadRes.ok && uploadRes.status === 401) {
    token     = await getFreshToken(true);
    uploadRes = await doUpload(token, fileId, folderId, fileName, content);
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error('Drive upload failed after token refresh: ' + errText);
    }
  } else if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error('Drive upload failed: ' + errText);
  }

  const result = await uploadRes.json();

  // 7. Cache the file ID from the response (critical on first create)
  if (result.id) {
    await setCachedFileId(folderId, fileName, result.id);
  }

  return result;
}

// ── Scraper function injected into the LivePerson tab ─────────────────────────
// This runs in the page context with full DOM access
function scrapeLivePerson() {
  const txt = el => (el ? (el.innerText || el.textContent || '').trim() : '');

  const result = {
    activitySummary: {},
    queueSummary:    [],
    agents:          [],
    conversations:   [],
    snapshotTime:    new Date().toISOString()
  };

  // ── Activity Summary ─────────────────────────────────────────────────────
  const metricMap = {
    openAssignedConversations:  'Assigned',
    weightedAvgLoad:            'Load',
    totalResolvedConversations: 'Closed',
    csat:                       'CSAT',
    avgWaitTimeFirstResponse:   'First Response Time',
    avgWaitTime:                'Response Time',
    avgConversationsDuration:   'Resolution Time'
  };

  Object.entries(metricMap).forEach(([key, label]) => {
    const el = document.querySelector(`[data-test="shift_status.metric_${key}"]`);
    if (!el) return;

    const valueEl =
      el.querySelector('.metric-value-number') ||
      el.querySelector('[class*="metric-value"]') ||
      el.querySelector('[class*="value-number"]') ||
      el.querySelector('.value');

    if (valueEl) {
      result.activitySummary[label] = txt(valueEl).replace(/\s+/g, ' ');
    } else {
      const fullText = txt(el);
      const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const labelIdx = lines.findIndex(l => l.toUpperCase() === label.toUpperCase());
      if (labelIdx >= 0 && lines[labelIdx + 1]) {
        result.activitySummary[label] = lines.slice(labelIdx + 1).join(' ').trim();
      } else if (lines.length > 1) {
        result.activitySummary[label] = lines.slice(1).join(' ').trim();
      }
    }
  });

  // Sub-metrics
  const subMetrics = {
    extension_overdueConversationsAssigned:              'Overdue Assigned',
    extension_humanOnlineLoad:                           'Online Load',
    extension_humanAwayLoad:                             'Away Load',
    extension_closedByAgent:                             'Closed By Agent',
    extension_closedByConsumer:                          'Closed By Consumer',
    extension_autoClosed:                                'Auto Closed',
    extension_avgTimeToFirstResponseFirstAssignment:     'First Response From Assignment',
    extension_avgTimeToResponse:                         'Response From Assignment'
  };

  Object.entries(subMetrics).forEach(([key, label]) => {
    const el = document.querySelector(`[data-test="shift_status.metric_${key}"]`);
    if (!el) return;
    const fullText = txt(el).replace(/\s+/g, ' ').trim();
    if (fullText) result.activitySummary[label] = fullText;
  });

  // ── Queue Summary ────────────────────────────────────────────────────────
  const queueWidget = document.querySelector('article.in-queue');
  if (queueWidget) {
    const tableBody = queueWidget.querySelector(
      '[class*="table-body"], [class*="tableBody"], tbody, [class*="skills-list"], [class*="skillsList"]'
    );

    if (tableBody) {
      const rows = tableBody.querySelectorAll(
        '[class*="table-row"],[class*="tableRow"],[class*="skill-row"],[class*="skillRow"],tr'
      );
      rows.forEach(row => {
        const cells = row.querySelectorAll(
          '[class*="table-cell"],[class*="tableCell"],[class*="cell"],td'
        );
        if (cells.length >= 2) {
          const skillName = txt(cells[0]);
          const inQueue   = txt(cells[1]);
          const waitTime  = cells[2] ? txt(cells[2]) : '';
          if (skillName && skillName.length > 1 && !/^SKILL$/i.test(skillName)) {
            result.queueSummary.push({ skill: skillName, inQueue, waitTime });
          }
        }
      });
    }

    if (result.queueSummary.length === 0) {
      const lines = txt(queueWidget)
        .split('\n')
        .map(l => l.replace(/\t/g, '|').trim())
        .filter(l => l.length > 0);

      let inTable = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^SKILL/i.test(l)) { inTable = true; continue; }
        if (!inTable) continue;
        const parts = l.split('|').map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length >= 2 && !/^\d+-\d+/.test(parts[0]) && !/^(IN QUEUE|WAIT TIME)/i.test(parts[0])) {
          result.queueSummary.push({
            skill:    parts[0],
            inQueue:  parts[1] || '0',
            waitTime: parts[2] || ''
          });
        }
      }
    }
  }

  // ── Agents Table ─────────────────────────────────────────────────────────
  const agentNameCells = Array.from(
    document.querySelectorAll('[data-test*="agentName_content"]')
  );

  agentNameCells.forEach(nameEl => {
    const dtVal = nameEl.getAttribute('data-test') || '';
    const match = dtVal.match(/agents\.data_(\d+)_agentName_content/);
    if (!match) return;
    const agentId = match[1];

    const get = field => {
      const statusVal = document.querySelector(
        `[data-test="agents.data_${agentId}_${field}_status_value"]`
      );
      if (statusVal) return txt(statusVal);
      const plainVal = document.querySelector(
        `[data-test="agents.data_${agentId}_${field}_value"]`
      );
      if (plainVal) return txt(plainVal);
      const content = document.querySelector(
        `[data-test="agents.data_${agentId}_${field}_content"]`
      );
      if (content) {
        const directText = Array.from(content.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .join('');
        return directText || txt(content).split('\n')[0];
      }
      return '';
    };

    const skillsEl = document.querySelector(
      `[data-test="agents.data_${agentId}_agentSkills_values"]`
    );
    const skills = skillsEl
      ? Array.from(skillsEl.querySelectorAll('span, [class*="tag"], [class*="chip"], [class*="skill"]'))
          .map(s => txt(s).trim())
          .filter(s => s.length > 0 && !/^\+\d+$/.test(s))
      : [];
    if (skills.length === 0 && skillsEl) {
      const raw = txt(skillsEl);
      if (raw) skills.push(...raw.split('\n').map(l => l.trim()).filter(l => l && !/^\+\d+$/.test(l)));
    }

    const agentName = txt(nameEl).split('\n')[0].trim();
    if (!agentName || agentName.length < 2) return;

    result.agents.push({
      name:           agentName,
      status:         get('agentCurrentStatus'),
      statusDuration: get('agentCurrentStatusReasonStartTime'),
      group:          get('agentGroupName'),
      activeConvs:    get('activeConversations'),
      assignedConvs:  get('assignedConversations'),
      closedConvs:    get('closedConversations'),
      load:           get('agentLoad'),
      onlineRate:     get('onlineRate'),
      csat:           get('csat'),
      maxSlots:       get('maxSlots'),
      transfers:      get('transfers'),
      transferRate:   get('transferRate'),
      skills:         skills
    });
  });

  // ── Conversations Table ───────────────────────────────────────────────────
  // The Conversations widget uses: conversations.column_{field}_{AGENT_ID}[_content]
  // Multiple rows share the same agent ID — each row is a distinct conversation.
  // We collect all _content cells for visitorName (one per row) then build each row.
  try {
    const convWidget = document.querySelector('[data-test="conversations.widget"]');
    if (convWidget) {
      // Collect all unique agent IDs present in the conversations widget
      const allConvEls = Array.from(
        convWidget.querySelectorAll('[data-test^="conversations.column_visitorName_"]')
      );

      // Each element with data-test="conversations.column_visitorName_{AGENTID}_content"
      // represents one conversation row
      const rowEls = allConvEls.filter(el =>
        el.getAttribute('data-test').endsWith('_content')
      );

      rowEls.forEach(visitorEl => {
        const dt      = visitorEl.getAttribute('data-test') || '';
        // Extract agent ID: conversations.column_visitorName_{AGENTID}_content
        const idMatch = dt.match(/conversations\.column_visitorName_(\d+)_content/);
        if (!idMatch) return;
        const agentId = idMatch[1];

        // Helper to get a field value for this specific row element's siblings
        // We need to find the containing row element and look within it
        const rowContainer = visitorEl.closest(
          '[class*="table-row"], [class*="tableRow"], [class*="row"], tr, li'
        ) || visitorEl.parentElement;

        const getField = (field) => {
          // Try _content first (most reliable text)
          const contentSel = `[data-test="conversations.column_${field}_${agentId}_content"]`;
          // Look within the same row container first
          let el = rowContainer ? rowContainer.querySelector(contentSel) : null;
          if (el) return txt(el);
          // Fallback: find element that is closest in DOM to visitorEl
          // by looking at all matching elements and picking the one
          // in the same parent structure
          const allMatching = Array.from(
            document.querySelectorAll(contentSel)
          );
          if (allMatching.length === 1) return txt(allMatching[0]);
          // If multiple (multiple conversations per agent), find the one
          // in the same ancestor as visitorEl
          for (const m of allMatching) {
            if (visitorEl.closest('[class*="widget"]') === m.closest('[class*="widget"]')) {
              // Try to match by position — find the one closest in DOM order
              return txt(m);
            }
          }
          return '';
        };

        // For status, type, responseTime — use non-_content elements
        const getStatusOrType = (field) => {
          const sel = `[data-test="conversations.column_${field}_${agentId}"]`;
          const allMatching = Array.from(rowContainer
            ? rowContainer.querySelectorAll(sel)
            : document.querySelectorAll(sel)
          );
          if (allMatching.length > 0) return txt(allMatching[0]);
          return '';
        };

        // Determine status: check for OPEN or CLOSE sub-elements
        let status = '';
        const openEl  = rowContainer
          ? rowContainer.querySelector(`[data-test="conversations.column_status_OPEN_${agentId}"]`)
          : null;
        const closeEl = rowContainer
          ? rowContainer.querySelector(`[data-test="conversations.column_status_CLOSE_${agentId}"]`)
          : null;
        if (openEl)  status = 'Open';
        else if (closeEl) status = 'Closed';
        else status = getStatusOrType('status');

        const visitorName  = txt(visitorEl);
        if (!visitorName) return; // skip empty rows

        // Get responseTime — try negative/positive variants
        let responseTime = getField('responseTime');
        if (!responseTime) {
          const negEl = rowContainer
            ? rowContainer.querySelector(`[data-test*="conversations.column_responseTime_${agentId}_time_duration"]`)
            : null;
          if (negEl) responseTime = txt(negEl);
        }

        result.conversations.push({
          visitorName:    visitorName,
          status:         status,
          responseTime:   responseTime,
          agentName:      getField('agentName'),
          agentGroupName: getField('agentGroupName'),
          skill:          getField('skill'),
          startTimestamp: getField('startTimestamp'),
          csatScore:      getField('csatScore')
        });
      });
    }
  } catch (e) {
    console.warn('[LP] Conversations scrape error:', e.message);
  }

  return result;
}