# Guardian Bikes — Onboarding Progress

Live account: guardian.gorgias.com (Gorgias helpdesk). Goal: scrape 3 pages
into wfm-live-scraper, export each to its own Supabase table(s). Tracked here
across sessions so nothing needs to be re-derived from scratch — see
`scrapers/guardianbikes/index.js` for the actual implementation and
`sql/guardianbikes.sql` for the schema.

## Status

| # | Page | Status | Table(s) |
|---|------|--------|----------|
| 1 | Live overview (`/app/stats/live-overview`) | ✅ Implemented, not yet verified live | `guardianbikes_overview_kpis`, `guardianbikes_ticket_volume` |
| 2 | Live agents (`/app/stats/live-agents`) | ✅ Implemented, not yet verified live | `guardianbikes_agents` |
| 3 | Live voice (`/app/stats/live-voice`) | ✅ Implemented, not yet verified live | `guardianbikes_voice_kpis`, `guardianbikes_live_calls`, `guardianbikes_voice_agents` |

## Gorgias itself

Confirmed via public research (not just this account's DOM): the Gorgias
frontend is a **React + Redux + TypeScript** SPA — see e.g.
[Frontend Engineer React/Redux — Gorgias](https://relocate.me/france/paris/gorgias/frontend-engineer-react-redux-5936).
This matters for HOW its widgets can be read (see below).

**The "live" pages push updates over Ably, not REST polling** — confirmed via
a live network probe (DevTools Network tab, filtered to Fetch/XHR): the only
same-origin request on page load is a one-time
`GET /third-party/auth/realtime`, which returns a short-lived Ably JWT
(`ably_token`, ~1hr expiry, scoped to a channel capability keyed by this
account's internal Gorgias org ID). After that, updates arrive over a
WebSocket straight to Ably's own infrastructure — guardian.gorgias.com itself
is never polled again. **We do not reimplement any of this.** Playwright
already holds a real, logged-in browser session open the whole time — the
actual Gorgias React app does all the realtime work in the background exactly
as it would for a human, and the scraper just reads whatever it has already
rendered, on its own 30s schedule. This is also why, unlike Flex, there is
only ONE Playwright Page for this whole account (no secondary pages needed) —
it's kept open indefinitely and simply re-read every tick, never
re-navigated, since the page keeps itself live-updated on its own (an early
network-probe dead end worth recording: hooking `window.fetch`/XHR/WebSocket
via a console script and then reloading the page found nothing, because
reloading destroys the JS context — and thus any injected hooks — before they
can observe anything; the Ably connection itself was only found by checking
the Network tab directly instead).

## 1. Live overview — IMPLEMENTED, not yet verified against a real login

URL: `https://guardian.gorgias.com/app/stats/live-overview`

Confirmed via live DOM probing (via the browser's own Elements-panel
inspector — a script blindly walking the DOM tree by text content match kept
failing to find the right elements, so this was probed by right-clicking the
actual rendered numbers → Inspect → Copy outerHTML instead, which is more
reliable when the DOM shape isn't known ahead of time):

### (a) Four "key metric" stat cards

"Agents online", "Agents offline", "Assigned open tickets", "Unassigned open
tickets" — CSS-modules components (hashed class suffixes, e.g.
`KeyMetricCell--value--lkl6k`), matched generically via `[class*=]` rather
than the exact hash, since that hash is expected to change on any Gorgias
redeploy. Each stat card's wrapper class contains
`KeyMetricCellWrapper--metric-`; inside it, one element's class contains
`KeyMetricCell--label--` (the label text) and one contains
`KeyMetricCell--value--` (the number).

### (b) "Support Volume" chart

Shows hourly Ticket created / Ticket replied / Ticket closed counts for the
current day. **Confirmed to be Chart.js, rendered on a plain
`<canvas role="img">`** — NOT an SVG like Flex's donut tiles, which means
there are zero real per-data-point DOM elements to click or hover.

Tried and confirmed **`window.Chart` is NOT exposed globally** (bundled
inside Gorgias's own webpack build, not attached to `window`) — so the
"read `Chart.instances`/`Chart.getChart()`" shortcut that would normally work
for a page with a global Chart.js doesn't apply here.

**What DOES work, confirmed via live testing:** since this is (per the
company's own confirmed React/Redux stack) almost certainly
`react-chartjs-2`, the exact chart config — `{ data: { labels, datasets } }`
— is just a normal React prop on a component a few levels above the
`<canvas>` in the tree. Walking the canvas DOM node's `__reactFiber$*`
internal reference up its `.return` chain (a few hops) finds that ancestor's
`memoizedProps.data`, giving the EXACT underlying data with no pixel-reading
or hover-tooltip simulation at all:
```
labels:   [1789963200, 1789966800, ...]   // hourly UNIX-second timestamps
datasets: [
  { label: "Ticket created", data: [5, 4, 4, 2, 3, 0, 3, 6, 15, 21, ...] },
  { label: "Ticket replied", data: [2, 1, 2, 2, 2, 0, 8, 12, 38, 53, ...] },
  { label: "Ticket closed",  data: [2, 1, 2, 1, 0, 0, 7, 13, 34, 60, ...] },
]
```
This is a **more reliable technique than Flex's donut-hover approach** on the
(rare) page shape where it's available — worth trying this same fiber-walk
FIRST on any future canvas-based chart before reaching for hover simulation.
`scrapeSupportVolumeChart()` in `index.js` is written to search UP TO 40 hops
generically (rather than assume a fixed hop count), in case this shifts on a
future Gorgias redeploy.

### Login

**NOT YET CONFIRMED.** This account's actual sign-in page/flow (plain
email+password vs SSO vs 2FA) has never been probed — defaults to
`manualLogin: true` per this codebase's standing convention for any
not-yet-confirmed login (see `scrapers/flex/index.js`/`scrapers/homebase/
index.js`). Navigate, wait for a human to log in in the visible browser
window, then run `resume guardianbikes`. Revisit once the login page itself
is probed — it's possible a scriptable email/password flow exists (matching
edenhealth/wyze's optimistic-auto-login posture) but this has not been
checked.

**Also not yet verified:** the scraper code above has been written and
syntax-checked (`node --check`) but **never run against a real logged-in
session** — there's no confirmed login yet to test it with. Once a human logs
in and runs `resume guardianbikes`, watch the first few ticks' console output
closely for `[guardianbikes] ... write failed` warnings (most likely cause:
`sql/guardianbikes.sql` not yet run against Supabase) and for whether
`scrapeOverviewStatCards()`/`scrapeSupportVolumeChart()` actually find
anything (if Gorgias's build has since changed those hashed class names, or
if react-chartjs-2's prop shape differs from what a fresh probe would show).

Implemented in `scrapers/guardianbikes/index.js`: `scrapeOverviewStatCards`,
`scrapeSupportVolumeChart`, `writeOverviewKpis`, `writeTicketVolume` →
`guardianbikes_overview_kpis`/`guardianbikes_ticket_volume` in
`sql/guardianbikes.sql`.

## 2. Live agents — IMPLEMENTED, not yet verified against a real login

URL: `https://guardian.gorgias.com/app/stats/live-agents`

Confirmed via a live DOM probe (this time a console script worked fine, once
we knew to look for a real `<table>` — the earlier blind text-content-search
script that failed on the Overview page was a symptom of that page NOT being
a table at all, not a flaw in the technique itself). A genuine semantic
`<table><thead><tbody><tr><td>` — much simpler than Overview's div/CSS-modules
layout. 6 columns in this order: **Agent**, **Online status**, **Availability**,
**Tickets closed**, **Messages sent**, **Open tickets**.

- **Agent name**: `[class*="TableStat--userName--"]`.
- **Online status**: a generic, reusable "badge" UI component —
  `[data-name="badge"]` — text is `"Online"`/`"Offline"`.
- **Availability**: NOT a plain badge — confirmed to be a
  `react-aria-components` `<Select>` (values seen live: Available,
  Unavailable, Lunch break, 15 minute break, In a meeting, Special project,
  Call wrap-up). The scraper reads ONLY the currently-selected value, from
  `[class*="AgentAvailabilityStatusSelect--badgeText--"]` (nested inside a
  `<button data-name="select-trigger">`) — **deliberately not** the sibling
  hidden native `<select>`'s full `<option>` list sitting right next to it in
  the DOM (confirmed present — an early "just read the whole cell's
  `textContent`" attempt produced garbage like `"Available▾
  AvailableUnavailableLunch break..."` by picking up every option's text too).
- **Tickets closed / Messages sent**: plain numbers, no special markup.
- **Open tickets**: confirmed TWO shapes —
  - Zero tickets: a `[class*="TicketDetailsStat--empty--"]` div reading
    `"No open tickets assigned to this agent"`.
  - Otherwise: a total count (`[class*="TicketDetailsStat--openTickets--"] a`)
    plus a per-channel breakdown, one `[class*="TicketDetailsStat--channel--"]`
    per channel with ≥1 open ticket. Each channel's `<i class="material-icons
    ...">` own text IS the channel identifier — confirmed live values:
    `forum`, `live_help`, `phone`, `email`, `sms` (Material Icons ligature
    names) — paired with its own count in a sibling `<a>`. Genuinely
    convenient: no icon-shape/color guessing needed, the channel name is
    right there as real text.

Verified the logic by hand against real captured data covering all shapes:
zero tickets (Ayla S), single-channel (Jade D: forum only, Kara P: phone
only), and multi-channel (Jamie T: live_help+forum+email; Macy A:
forum+email; Prence Q: live_help+forum+email). All traced through
`scrapeAgentTable()` correctly.

**Not yet verified live** — same caveat as Live Overview: this has been
syntax-checked and dry-required, but never actually run against a real
Playwright session (no confirmed login yet). Also unconfirmed: whether the
agent list ever lazy-loads/paginates beyond what's initially in the DOM (this
account had 25 rows and all 25 were already present without scrolling when
probed, so `scrapeAgentTable()` just reads whatever's in `tbody` at scrape
time — revisit if an account with many more agents shows a partial list).

Implemented in `scrapers/guardianbikes/index.js`: `ensureAgentsPage`,
`scrapeAgentTable`, `writeAgents`, `pruneDepartedAgents` →
`guardianbikes_agents` in `sql/guardianbikes.sql`.

## 3. Live voice — IMPLEMENTED, not yet verified against a real login

URL: `https://guardian.gorgias.com/app/stats/live-voice`

Confirmed via a live DOM probe (console script + downloaded JSON, same
technique as Live Agents). Caption on this page says "KPI cards last updated:
... (auto-refresh every 30 seconds)" — turned out not to matter either way,
same lesson as Overview: we just read whatever's rendered, regardless of
polling vs. Ably-push underneath.

### (a) 11 KPI cards

Calls in queue, Average wait time, Average talk time, SLA Achievement rate,
Inbound calls, Outbound calls, Unanswered calls, Missed calls, Cancelled
calls, Abandoned calls, Callback requests — **a DIFFERENT component than
Overview's** (`MetricCard`/`BigNumberMetric`, not `KeyMetricCell` —
confirmed live: Overview's selector matches zero elements here). Selector:
`[data-name="card"][class*="MetricCard--card--"]` (excludes a trailing
non-card cell that's just the page's own sync/refresh icon).

Label extraction needed a specific trick: the title `<div>` also contains a
sibling icon-tooltip element, so reading its full `textContent` (an early
attempt) picked up the icon's own text and produced garbage like "Calls in
queueinfo". Fixed by reading only the title div's **leading text node**
(`Array.from(titleDiv.childNodes).find(n => n.nodeType === 3 && ...)`)
instead of its full `textContent`.

**Known caveat, not a bug**: 4 of these cards (Missed/Cancelled/Abandoned
calls, Callback requests) have a "#" vs "%" display toggle sitting right next
to them (confirmed live). This scraper reads whatever's CURRENTLY shown —
percentages, as of this probe — with no way to control or even detect which
toggle state is active from the DOM alone. If someone flips that
account-wide setting to "#", the scraped value silently becomes a raw count
instead. Worth flagging to whoever reviews this account's KPI thresholds
later.

### (b) "Live calls" table

A real `<table class="...VoiceCallTable--table--...">` — distinguished from
the Agents-sidebar table below (which shares a more generic base table class
with no distinguishing class of its own) by this MORE SPECIFIC class. One row
per **currently active call only** (not history — confirmed only 1 row
existed with exactly 1 active call happening at probe time). 7 columns:
Activity (direction icon + customer phone number + agent name), Status (e.g.
"In progress"), Time (a badge with a timer icon + duration — read the inner
duration `<div>` specifically, not the badge's whole text, to avoid
concatenating the icon's own "timer" ligature-name text onto the front, e.g.
"timer05:11"), Integration, Queue, Monitor (a "Listen" action button — not
data, skipped), Ticket (a "View ticket" link whose `href` contains a real
ticket ID, extracted via regex).

### (c) Agents sidebar — the "all the statuses" answer

A table found by locating whichever `<table>` contains an
`[class*="AgentCard--container--"]` element (again, no more specific class of
its own on the `<table>` itself). Its `<tbody>` rows **alternate between two
shapes**:
- A "category header" row (`[class*="LiveVoiceAgentsList--categoryCell--"]`,
  text like "Busy (1)", "Available (4)", "Unavailable (4)") — **confirmed
  exactly 3 category groups, always these 3 names.**
- Individual agent rows — an "AgentCard" that (unusually) sits as a **direct
  child of the `<tr>`, not wrapped in its own `<td>`** — invalid-looking
  markup that Playwright/browsers render and read just fine regardless.

**Per-agent status is deliberately NOT hardcoded as a fixed list.** The
specific status (more granular than the 3 category groups — confirmed live:
"On a call" within Busy, "Available" within Available, "Offline" within
Unavailable) is read straight from the status dot's own `aria-label`
(`[class*="ui-avatarstatusindicator-dotswrapper-"][aria-label]`) every tick —
same dynamic-discovery philosophy as the Wyze/Eden status-vocab work earlier
this project. Only 3 distinct per-agent statuses were actually observed live
(one Busy example isn't enough to rule out other Busy-group sub-statuses like
"Ringing"/"Wrapping up") — but that's fine, since the scraper doesn't need an
exhaustive list up front; whatever text Gorgias shows just flows through
automatically, and the Dashboard's own status-threshold UI already discovers
new status values dynamically from live data (see the WFM Live Dashboard
repo's `discoveredStatuses` logic). The dot's `data-color` (red/green/grey,
confirmed live) is captured too as a cheap extra signal. A description
`<div>` under the agent's name holds a duration string (e.g. "04:57" for the
one Busy agent seen live) when present, blank otherwise.

Implemented in `scrapers/guardianbikes/index.js`: `ensureVoicePage`,
`scrapeVoiceKpis`, `scrapeLiveCalls`, `scrapeVoiceAgents`, `writeVoiceKpis`,
`writeLiveCalls` (always prunes, even to zero rows — an idle line is a real,
common state, not a failed scrape), `writeVoiceAgents` →
`guardianbikes_voice_kpis` / `guardianbikes_live_calls` /
`guardianbikes_voice_agents` in `sql/guardianbikes.sql`. The prune helper used
across this file was generalized from a single-table `pruneDepartedAgents()`
into a table-parametrized `pruneDeparted(table, accountId, currentIds)` (same
shape as `scrapers/flex/index.js`'s), since there are now two tables that
need it (`guardianbikes_agents`, `guardianbikes_live_calls`).

## Other notes

- Account id chosen: `guardianbikes` (per the user's own suggestion).
- Nothing here is wired into the WFM Live Dashboard app's UI yet — that's a
  separate, not-yet-discussed decision for later (same as every other new
  account's onboarding in this codebase).
