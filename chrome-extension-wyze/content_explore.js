// content_explore.js — Wyze Dashboard Scraper (WFM Live)
// NOT YET REGISTERED in manifest.json — Wyze's Explore KPI dashboard URL is
// still unknown (config.json's "exploreUrl" is "", same as
// scrapers/wyze/index.js, which skips Explore scraping entirely until it's
// filled in). This file is ready to go the moment that URL is known — see
// README.md's "Adding Explore once the URL is known" section for the two
// edits required (a manifest.json content_scripts entry + a host_permissions
// entry for this file to take effect).
//
// Direct port of scrapers/wyze/index.js's scrapeExploreKpis() — KPI_MAP is
// intentionally empty (Wyze's specific tile query-IDs were never
// catalogued); the generic fallback (any element with a "kpi-queryid-*"
// class) discovers and labels every tile automatically until real labels
// are added here AND in scrapers/wyze/index.js (keep both in sync).

(function () {
  'use strict';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForExploreDom(maxMs = 60000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('.kpi-first-measure-value').length >= 3) return true;
      await sleep(300);
    }
    return false;
  }

  function scrapeExploreKpis() {
    const KPI_MAP = []; // fill in { label, queryid } pairs once catalogued

    const result = [], seen = new Set();

    KPI_MAP.forEach(({ label, queryid }) => {
      seen.add(queryid);
      const el = document.querySelector('.' + queryid);
      const value = el ? el.innerText.trim() : '';
      let delta = '';
      if (el) {
        const container = el.closest('.kpi-first-measure')?.parentElement
          || el.parentElement?.parentElement;
        if (container) {
          const secondEl = container.querySelector('.kpi-second-measure');
          const inlineDiv = secondEl?.querySelector('div[style*="inline"]');
          delta = inlineDiv ? inlineDiv.innerText.trim() : (secondEl?.innerText.trim() || '');
        }
      }
      result.push({ label, value, delta });
    });

    document.querySelectorAll('[class*="kpi-queryid-"]').forEach(el => {
      const qid = Array.from(el.classList).find(c => c.startsWith('kpi-queryid-'));
      if (!qid || seen.has(qid)) return;
      seen.add(qid);
      let p = el.parentElement, labelEl = null;
      for (let i = 0; i < 8; i++) {
        if (!p) break;
        labelEl = p.querySelector('span.sc-bdlOLf');
        if (labelEl) break;
        p = p.parentElement;
      }
      const label = labelEl ? labelEl.innerText.trim() : '(unknown: ' + qid + ')';
      result.push({ label, value: el.innerText.trim(), delta: '' });
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
    const kpis = scrapeExploreKpis();
    if (kpis.length === 0) {
      return { ok: false, error: 'No KPI tiles found — is the Explore dashboard fully loaded?' };
    }
    const res = await safeSend({ type: 'WYZE_WRITE_KPIS', kpis });
    if (!res?.ok) return { ok: false, error: res?.error || 'background write failed' };
    return {
      ok: true,
      summary: `Synced ${kpis.length} KPI tile(s) to wyze_kpis`,
      previewItems: kpis.map(k => ({ name: k.label, detail: k.value })),
    };
  }

  async function init() {
    const ready = await waitForExploreDom();
    if (!ready) {
      console.warn('[Wyze Explore] KPI tiles never appeared — is the Explore dashboard fully loaded?');
    }

    window.WyzeOverlay.create({
      title: 'Wyze Explore KPI Scraper',
      writesTo: 'WFM Live Supabase (wyze_kpis)',
      storageKeyPrefix: 'wyze_explore',
      defaultInterval: 60,
      onSnap,
    });
  }

  setTimeout(init, 1500);
})();
