// content_chat.js — Wyze Dashboard Scraper (WFM Live)
// Runs on the Chat Monitor page (https://wyzelabs.zendesk.com/chat/agent#monitor).
// Scrapes the live queue/response/duration/agent cards and sends them to
// background.js, which writes into WFM Live's Supabase `wyze_chat_monitor`
// table — the same table wfm-live-scraper's scrapers/wyze/index.js writes to.
//
// Direct port of scrapers/wyze/index.js's scrapeChatMonitor() — that runs
// inside Playwright's page.evaluate(), this is the same code running
// natively as a content script.

(function () {
  'use strict';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function findCard(title) {
    return [...document.querySelectorAll('[class*="card___"]')]
      .find(c => c.querySelector('[class*="title___"]')?.innerText.trim() === title);
  }
  function valCount(card) {
    return card
      ? card.querySelectorAll('[class*="metricStack___"] [class*="value___"]').length
      : 2; // missing card — treat as ready
  }

  // Card shells first, then the Response time / Chat duration stacks must
  // each have BOTH values (Longest + Average), since React adds Average
  // asynchronously after the card shell.
  async function waitForChatMonitorDom(maxMs = 60000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('[class*="card___"]').length >= 3 &&
          valCount(findCard('Response time')) >= 2 &&
          valCount(findCard('Chat duration')) >= 2) return true;
      await sleep(300);
    }
    return false;
  }

  // Three widget shapes on this page, each parsed differently:
  //   singleMetric___  — one big value + a sublabel (Queue total, Missed, ...)
  //   metricGrid___    — LABEL then VALUE siblings (Chats per agent, ...)
  //   metricStack___   — VALUE then LABEL siblings (Response time, ...)
  async function scrapeChatMonitor() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (valCount(findCard('Response time')) >= 2 && valCount(findCard('Chat duration')) >= 2) break;
      await sleep(200);
    }

    const result = [];

    document.querySelectorAll('[class*="card___"]').forEach(card => {
      const titleEl = card.querySelector('[class*="title___"]');
      if (!titleEl) return;
      const title = titleEl.innerText.trim();
      if (!title) return;

      const addRow = (metric, value) => result.push({ card: title, metric, value: value || '-' });

      const singleMetric = card.querySelector('[class*="singleMetric___"]');
      if (singleMetric) {
        const val = singleMetric.querySelector('[class*="value___"]')?.innerText.trim() || '-';
        const label = singleMetric.querySelector('[class*="label___"]')?.innerText.trim() || 'Value';
        addRow(label, val);
      }

      card.querySelectorAll('[class*="metricGrid___"] > [class*="label___"]').forEach(labelEl => {
        const label = labelEl.innerText.trim();
        const nextEl = labelEl.nextElementSibling;
        const isVal = nextEl && [...nextEl.classList].some(c => c.includes('value___'));
        const value = isVal ? nextEl.innerText.trim() : '-';
        if (label) addRow(label, value || '-');
      });

      card.querySelectorAll('[class*="metricStack___"] > [class*="value___"]').forEach(valueEl => {
        const value = valueEl.innerText.trim();
        const nextEl = valueEl.nextElementSibling;
        const isLbl = nextEl && [...nextEl.classList].some(c => c.includes('label___'));
        if (isLbl) addRow(nextEl.innerText.trim(), value || '-');
      });
    });

    return result;
  }

  function safeSend(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function onSnap() {
    const chatMonitor = await scrapeChatMonitor();
    if (chatMonitor.length === 0) {
      return { ok: false, error: 'No chat monitor cards found — is the Chat Monitor page fully loaded?' };
    }
    const res = await safeSend({ type: 'WYZE_WRITE_CHAT', chatMonitor });
    if (!res?.ok) return { ok: false, error: res?.error || 'background write failed' };
    return {
      ok: true,
      summary: `Synced ${chatMonitor.length} chat metric(s) to wyze_chat_monitor`,
      previewItems: chatMonitor.map(c => ({ name: `${c.card} — ${c.metric}`, detail: c.value })),
    };
  }

  async function init() {
    const ready = await waitForChatMonitorDom();
    if (!ready) {
      console.warn('[Wyze Chat Monitor] Cards never appeared — is the Chat Monitor page fully loaded?');
    }

    window.WyzeOverlay.create({
      title: 'Wyze Chat Monitor Scraper',
      writesTo: 'WFM Live Supabase (wyze_chat_monitor)',
      storageKeyPrefix: 'wyze_chat',
      defaultInterval: 30,
      onSnap,
    });
  }

  setTimeout(init, 1500);
})();
