// lib/scrape.js
// Ports the scrape() + ensureExpanded() + getTile() logic from content.js.
// Everything that touches the DOM runs inside page.evaluate() so it executes
// in the browser context. Node.js only receives the plain data object back.

// ── Expand collapsed agent status sections ───────────────────────────────────
async function ensureExpanded(page) {
  await page.evaluate(() => {
    const statusLabels = /Available|Ringing|In call|After call work|Offline|Not available|On a break/i;
    document.querySelectorAll('[aria-expanded="false"], [data-state="closed"]').forEach(el => {
      if (statusLabels.test(el.innerText || '')) {
        try { el.click(); } catch (_) {}
      }
    });
  });
  // Give React time to re-render after clicks
  await page.waitForTimeout(500);
}

// ── Core scrape function — mirrors content.js scrape() exactly ───────────────
async function scrapeAircall(page) {
  // Expand any collapsed agent-status sections first
  await ensureExpanded(page);

  // Run the entire scrape in browser context (has access to DOM)
  const data = await page.evaluate(() => {
    const result = {
      kpis:       {},
      calls:      [],
      userStatus: {},
      agents:     [],
      hasData:    false
    };

    // ── getTile — reads a KPI tile value ─────────────────────────────────
    function getTile(id) {
      const el = document.querySelector(`[data-test="${id}"]`);
      if (!el) return 'N/A';
      const v = el.querySelector('[data-test="tile-number"]') || el.querySelector('[data-test="tile-duration"]');
      if (v) return v.innerText.trim().replace(/\n/g, ' ');
      let txt = el.innerText.trim();
      const h = el.querySelector('[data-test="tile-header"]');
      if (h) txt = txt.replace(h.innerText.trim(), '').trim();
      const e = el.querySelector('[data-test="tile-extra"]');
      if (e) txt = txt.replace(e.innerText.trim(), '').trim();
      return txt.split('\n')[0].trim();
    }

    // ── KPI tiles ─────────────────────────────────────────────────────────
    result.kpis['sla']              = getTile('sla-tile');
    result.kpis['total_calls']      = getTile('total-calls-tile');
    result.kpis['outbound']         = getTile('outbound-tile');
    result.kpis['inbound']          = getTile('inbound-tile');
    result.kpis['answered']         = getTile('answered-tile');
    result.kpis['unanswered']       = getTile('unanswered-tile');
    result.kpis['time_to_answer']   = getTile('time-to-answer-tile');
    result.kpis['longest_waiting']  = getTile('longest-waiting-tile');
    result.kpis['available_users']  = getTile('available-users-tile');
    result.kpis['calls_waiting']    = getTile('calls-waiting-tile');

    const ct = document.querySelector('[data-test="calls-table-container"]');
    if (ct) {
      const m = ct.innerText.match(/(\d+)\s*calls/);
      result.kpis['calls_in_table'] = m ? m[1] : '0';
    }

    const ust = document.querySelector('[data-test="user-status-tile"]');
    if (ust) {
      const m2 = ust.innerText.match(/(\d+)\s*Total/);
      result.kpis['total_users'] = m2 ? m2[1] : '0';
    }

    // ── User status counts ────────────────────────────────────────────────
    let tot = 0;
    document.querySelectorAll('[data-test="count"]').forEach(el => {
      tot += parseInt(el.innerText) || 0;
      const gp = el.parentElement ? el.parentElement.parentElement : null;
      if (gp) {
        const lbl = gp.innerText.trim().replace(el.innerText.trim(), '').trim().split('\n')[0].trim();
        if (lbl) result.userStatus[lbl] = el.innerText.trim();
      }
    });
    if ((!result.kpis['total_users'] || result.kpis['total_users'] === '0' || result.kpis['total_users'] === 'N/A') && tot > 0) {
      result.kpis['total_users'] = String(tot);
    }

    // ── Agent status details (from body text — same approach as content.js) ─
    const statusGroups = ['Available','Ringing','In call','After call work','Not available','Do not disturb','On a break','Out for lunch','Back office','In training','Other','Offline'];
    const isDur = s => /^\d+(d|h|min|s)/.test(s.replace(/\s/g, '')) && s.trim().length > 0;

    const bt = document.body.innerText;
    const ui = bt.indexOf('User status\nUser status');
    if (ui >= 0) {
      const sec   = bt.substring(ui, ui + 6000);
      const lines = sec.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      let cs = '', i = 0;
      while (i < lines.length) {
        const ln = lines[i];
        if (statusGroups.indexOf(ln) >= 0) {
          cs = ln; i++;
          if (lines[i] && /^\d+$/.test(lines[i])) i++;
          continue;
        }
        if (cs && ln.length > 0 && statusGroups.indexOf(ln) < 0 && ln !== 'User status') {
          // Pattern: [optional initials], name, duration
          if (/^[a-zA-Z0-9]{1,3}$/.test(ln) && lines[i+1] && lines[i+2] && isDur(lines[i+2])) {
            result.agents.push({ name: lines[i+1], status: cs, duration: lines[i+2] });
            i += 3; continue;
          }
          if (lines[i+1] && isDur(lines[i+1])) {
            result.agents.push({ name: ln, status: cs, duration: lines[i+1] });
            i += 2; continue;
          }
        }
        i++;
      }
    }

    // ── Active calls table ─────────────────────────────────────────────────
    const tbl = document.querySelector('table');
    if (tbl) {
      tbl.querySelectorAll('tr').forEach((row, r) => {
        if (r === 0) return; // skip header
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return;
        const pe  = cells[0] ? cells[0].querySelector('path') : null;
        const pd  = pe ? pe.getAttribute('d') : '';
        const dir = pd && pd.startsWith('M16') ? 'Outbound' : (pd && pd.startsWith('M31') ? 'Inbound' : 'Unknown');
        result.calls.push({
          direction: dir,
          user:      cells[1] ? cells[1].innerText.trim() : '',
          number:    cells[2] ? cells[2].innerText.trim() : '',
          customer:  cells[3] ? cells[3].innerText.trim() : '',
          status:    cells[4] ? cells[4].innerText.replace(/\n/g, ' ').trim() : '',
          started_at: cells[5] ? cells[5].innerText.trim() : ''
        });
      });
    }

    // Mark as having real data if at least one KPI is non-empty
    result.hasData = Object.values(result.kpis).some(v => v && v !== 'N/A' && v !== '-' && v !== '');

    return result;
  });

  return data;
}

// ── Retry wrapper — mirrors doSnap() retry logic ─────────────────────────────
// Retries up to maxAttempts if KPIs come back empty (tiles still rendering).
async function scrapeWithRetry(page, accountId, maxAttempts = 3) {
  const tag = `[${accountId}]`;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await scrapeAircall(page);
    lastResult = data;

    if (data.hasData) return data;

    if (attempt < maxAttempts) {
      console.warn(`${tag} KPIs empty on attempt ${attempt}/${maxAttempts} — retrying in 1s...`);
      await page.waitForTimeout(1000);
    }
  }

  if (lastResult && !lastResult.hasData) {
    console.warn(`${tag} All ${maxAttempts} attempts returned empty KPIs — tiles may still be loading.`);
  }

  return lastResult;
}

module.exports = { scrapeWithRetry };
