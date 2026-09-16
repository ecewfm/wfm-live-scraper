// content_roster.js — Wyze Dashboard Scraper (WFM Live)
// Runs on the WFM Agent Status page (https://wyzelabs.zendesk.com/wfm/v2/agent-status).
// Scrapes the ECE team's agent roster and sends it to background.js, which
// writes straight into WFM Live's Supabase `wyze_agents` table — the same
// table wfm-live-scraper's scrapers/wyze/index.js writes to.
//
// DOM-scraping logic (classifyRow / parseAgentLi / selectByTeamIfNeeded) is a
// direct port of scrapers/wyze/index.js's scrapeEceRoster() and
// selectByTeamIfNeeded() — that code runs inside Playwright's page.evaluate(),
// this runs directly in the page as a content script, so the logic is
// unchanged, just no longer wrapped in an evaluate() call.

(function () {
  'use strict';

  const TARGET_GROUP = 'ECE';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── "By team" dropdown — Ant Design only opens it on mousedown; a plain
  // .click() already fires mousedown/mouseup/click, so this is enough. ──────
  async function selectByTeamIfNeeded() {
    const current = document.querySelector('.ant-select-selection-item');
    if (current && (current.getAttribute('title') === 'By team')) return;

    const trigger = document.querySelector('.ant-select-selector');
    if (!trigger) return;
    trigger.click();

    const deadline = Date.now() + 5000;
    let byTeamOption = null;
    while (Date.now() < deadline) {
      byTeamOption = document.querySelector(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="By team"]'
      );
      if (byTeamOption) break;
      await sleep(150);
    }
    if (byTeamOption) byTeamOption.click();
  }

  async function waitForAgentListDom(maxMs = 30000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const vList = document.querySelector('.virtual-list');
      if (vList && vList.querySelectorAll('li.sc-dkYRCH').length > 0) return true;
      await sleep(300);
    }
    return false;
  }

  // A row is a TEAM HEADER (not an agent) when it has an <h6> but no other
  // detail columns rendered alongside it — just the team name, <=2 lines of
  // text total. Every agent row always has more than that (activity, ticket
  // number, adherence, etc. columns).
  function classifyRow(li) {
    const h6 = li.querySelector('h6');
    const lines = li.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean);
    return { h6Text: h6 ? h6.innerText.trim() : null, isHeader: !!h6 && lines.length <= 2 };
  }

  function parseAgentLi(li) {
    const nameEl = li.querySelector('h6');
    const name = nameEl ? nameEl.innerText.trim() : '';
    const perf = li.querySelector('[data-testid="AgentPerformanceContent"]');
    const getCol = id => {
      if (!perf) return '';
      const el = perf.querySelector(`[data-testid="${id}"]`);
      return el ? el.innerText.trim().replace(/\n/g, ' ').trim() : '';
    };
    const badgeEl = li.querySelector('[data-testid="AgentDetailsColoredTask"]');
    const activity = badgeEl ? badgeEl.innerText.trim() : getCol('ColumnWorkstream');
    return {
      name, activity,
      ticketNumber: getCol('ColumnTicketId'),
      activityDuration: getCol('ColumnActivityDuration'),
      adherenceCurrent: getCol('ColumnAdherenceCurrent'),
      adherenceDuration: getCol('ColumnAdherenceDuration'),
      status: getCol('ColumnTalkActivity'),
      statusDuration: getCol('ColumnTalkActivityDuration'),
    };
  }

  // Virtual list only renders visible rows — scroll it through its full
  // range and dedupe by agent name, same as the Node scraper does.
  //
  // STATE TRACKING ACROSS SCROLL STEPS — not re-deriving the boundary fresh
  // each time. The old approach re-found the "ECE" header row from scratch
  // on every scroll step, then walked forward from it. That silently broke
  // the moment the ECE header itself scrolled out of the viewport:
  // virtualization removes rows outside the render window from the DOM
  // entirely, so once scrolled far enough, no h6 with text "ECE" exists
  // anywhere in the DOM any more — the search came back empty and every row
  // after the first screenful was dropped (confirmed live via a DOM probe:
  // capped the roster at ~28 of 104 real ECE agents, cutting off around
  // "Helson", never reaching e.g. "Ryan Gajunera"). Fixed by tracking "am I
  // currently inside the ECE block" as state that persists across scroll
  // steps instead — it only needs to have been true ONCE (when the header
  // was still rendered), and flips off only when a DIFFERENT team's header
  // (e.g. "Foundever") is seen while that state is on.
  async function scrapeEceRoster() {
    const vList = document.querySelector('.virtual-list');
    if (!vList) return [];

    const agentMap = new Map();
    let insideTarget = false;   // currently inside the ECE block (persists across scroll steps)
    let doneWithTarget = false; // scrolled past ECE into the next team — stop for good

    const processWindow = () => {
      if (doneWithTarget) return;
      const lis = Array.from(vList.querySelectorAll('li.sc-dkYRCH'));
      for (const li of lis) {
        const { h6Text, isHeader } = classifyRow(li);
        if (isHeader) {
          if (h6Text === TARGET_GROUP) {
            insideTarget = true;
          } else if (insideTarget) {
            doneWithTarget = true;
            insideTarget = false;
          }
          continue;
        }
        if (insideTarget) {
          const agent = parseAgentLi(li);
          if (agent.name) agentMap.set(agent.name, agent);
        }
      }
    };

    const stepSize = Math.max(vList.clientHeight - 60, 60);
    const savedPos = vList.scrollTop;

    vList.scrollTop = 0; await sleep(200); processWindow();
    let lastTop = -1;
    while (!doneWithTarget) {
      const atBottom = vList.scrollTop >= vList.scrollHeight - vList.clientHeight - 5;
      if (atBottom || vList.scrollTop === lastTop) break;
      lastTop = vList.scrollTop;
      vList.scrollTop += stepSize;
      await sleep(200); processWindow();
    }
    vList.scrollTop = savedPos;
    return Array.from(agentMap.values());
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
    await selectByTeamIfNeeded().catch(() => {});
    const agents = await scrapeEceRoster();
    if (agents.length === 0) {
      return { ok: false, error: 'No ECE agents found — is the roster fully loaded and "By team" selected?' };
    }
    const res = await safeSend({ type: 'WYZE_WRITE_AGENTS', agents });
    if (!res?.ok) return { ok: false, error: res?.error || 'background write failed' };
    return {
      ok: true,
      summary: `Synced ${agents.length} ECE agent(s) to wyze_agents`,
      previewItems: agents.map(a => ({ name: a.name, detail: `${a.status || '-'} ${a.statusDuration || ''}`.trim() })),
    };
  }

  async function init() {
    const ready = await waitForAgentListDom();
    if (!ready) {
      console.warn('[Wyze Roster] Agent list never appeared — is the WFM Agent Status page fully loaded?');
    }
    await selectByTeamIfNeeded().catch(() => {});

    window.WyzeOverlay.create({
      title: 'Wyze Agent Roster Scraper',
      writesTo: 'WFM Live Supabase (wyze_agents)',
      storageKeyPrefix: 'wyze_roster',
      defaultInterval: 30,
      onSnap,
    });
  }

  setTimeout(init, 1500);
})();
