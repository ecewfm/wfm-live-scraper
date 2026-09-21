# Flex — Onboarding Progress

Live account: getflex.zendesk.com (Zendesk) + a public Geckoboard share link.
Goal: scrape 3 pages into wfm-live-scraper, export each to its own Supabase
table(s). Tracked here across sessions so nothing needs to be re-derived
from scratch — see `scrapers/flex/index.js` for the actual implementation
and `sql/flex.sql` for the schema.

## Status

| # | Page | Status | Table(s) |
|---|------|--------|----------|
| 1 | General Ticket Status (Zendesk view) | ✅ Implemented | `flex_tickets` |
| 2 | Geckoboard "Tickets Nearing SLA Breach" | ✅ Implemented | `flex_sla_watch` |
| 3 | Ticket Status Explore dashboard (Looker embed) | 🟨 Mostly implemented, verified live | `flex_explore_tiles` |

## 1. General Ticket Status — DONE

URL: `https://getflex.zendesk.com/agent/filters/22437671830423?brand_id=360002102693`

Confirmed via live DOM probe:
- Plain semantic Garden `<table data-test-id="generic-table">` — NOT a
  virtual-list/ARIA grid (unlike Wyze/Eden's WFM app).
- 16 `<thead th>` columns in order: Select-all, Conversation, Agent
  collision, Group privacy, **Ticket status**, **ID**, **Priority**,
  **SLA**, **Subject**, **Requester**, **Requested**, **Group**,
  **Assignee**, **Category (U)**, **Channel**, Actions.
- `<tbody>` rows: one `<tr class="...StyledRow...">` per ticket (16
  `<td>`s, same order), plus an occasional single-cell
  `<tr class="...StyledGroupRow...">` divider row between priority buckets
  (e.g. "Priority: Normal") — skipped, captured instead as `priorityGroup`
  on every ticket row that follows.
- SLA cell holds TWO lines of text (e.g. "Breached by 16 days" / "-16d") —
  kept as two separate fields (`slaText`/`slaShort`).
- Real pagination: Prev/Next buttons + a "(Page X of Y)" counter
  (`data-test-id="views_views-header-page-amount"`) — NOT virtualized
  scroll. Scraper clicks "Next" and waits for the first row's ticket ID to
  change until it reaches the last page, every tick.
- Login: CONFIRMED — "Sign in with Google" → a Google account/password
  popup → an authenticator app 2FA code prompt → then the real dashboard.
  NOT a plain Zendesk email/password form, so unlike edenhealth/wyze there
  is no credential auto-login attempt at all — same posture as
  `scrapers/homebase/index.js`'s Okta SSO (navigate, check, and if not
  logged in, just wait for a human + `resume flex`). `isLoginUrl()` is
  deliberately broad (`!getflex.zendesk.com/agent/`) rather than matching
  one specific login path, since the Google+2FA flow bounces through
  domains (accounts.google.com, etc.) that aren't ours to predict.

Implemented in `scrapers/flex/index.js` (`scrapeTicketTablePage`,
`scrapeAllTickets`, `writeFlexData`) → `flex_tickets` in `sql/flex.sql`.

## 2. Geckoboard "Tickets Nearing SLA Breach" — DONE

URL: `https://share.geckoboard.com/dashboards/BUMCTLXCJC5APKJ6` (public
share link — no login of any kind, confirmed).

Confirmed via live DOM probe (took a few rounds — noted here so the dead
ends aren't re-explored):
- The share-link page is a SINGLE cross-origin iframe
  (`id="gb-dashboard-iframe"`, src `.../v5/dashboards/<id>/inception`).
- Navigating to that iframe's src DIRECTLY (standalone, in its own tab) is
  a DEAD END — it just shows a recursive self-embedding placeholder
  (probably a bootstrapping check that only renders real content when
  genuinely loaded as a child frame of the share page).
- The REAL widget content renders directly inside that same iframe when
  loaded properly as a child frame — confirmed by switching the Chrome
  DevTools console context to that frame (the small "top" dropdown in the
  Console panel) and probing from there. No further iframe nesting.
- Inside that frame: a plain `<table><tbody><tr><td>`, 6 columns in order:
  **ID**, **Subject**, **Assignee**, **Assignee tags**, **Next SLA breach
  at**, **Ticket group**.
- Each cell's `innerText` contains its content TWICE (a truncate/tooltip
  rendering quirk) — deduped in `cellText()` back down to one copy.
- No pagination — small, fixed "nearing breach" list.
- For Playwright: reachable via
  `page.waitForSelector('iframe#gb-dashboard-iframe').contentFrame()` —
  Playwright isn't subject to the same JS-level same-origin restriction a
  page's own script hits, so no DevTools trick is needed there.
  **CONFIRMED working live** — a real scrape run wrote 10 SLA-watch rows.

Implemented in `scrapers/flex/index.js` (`ensureGeckoboardPage`,
`getGeckoboardFrame`, `scrapeSlaBreachWidget`, `writeFlexSlaWatch`) →
`flex_sla_watch` in `sql/flex.sql`.

## 3. Ticket Status Explore dashboard — MOSTLY IMPLEMENTED, VERIFIED LIVE

URL: `https://getflex.zendesk.com/explore/studio?brand_id=360002102693#/dashboards/precanned/13EAEF5951D595E3281C80635C5BE556547FE5A572EE6A091B1237E8C49E4EBA`

By far the deepest/most fragile of the three sources — NOT native Zendesk
Explore rendering (unlike Eden Health/Wyze's `kpi-queryid-*` tiles). Confirmed
via extensive live DOM probing AND a real end-to-end integration test run
(`login()` → `scrape()` against the actual site, reusing the persisted
session) — **33 real tiles/data-points scraped successfully in one tick.**

### Structure

- The dashboard is a **Looker embed** (`zendeskproductionuseast1.cloud.looker.com`),
  reached via: Zendesk page's own iframe (URL carries short-lived signed
  `embed_navigation_token`/`embed_authentication_token` JWTs, ~1hr session —
  **never hardcode this URL**) → a Looker "dashboard" frame, found via
  `page.frames()` (which returns the WHOLE flattened frame tree, any depth —
  no need to manually descend via `contentFrame()` chains).
- **Both the Looker iframe itself AND its dashboard content take several
  seconds to actually appear/render** — CONFIRMED needing real polling, not
  a fixed wait: `waitForLookerFrame()` polls `page.frames()` (observed
  ~5-6s), and a SEPARATE poll is needed afterward for `[class*="ElementTitle"]`
  to actually have any matches (observed a few more seconds) — the frame
  existing does NOT mean its React content has mounted yet. Skipping either
  poll silently produces zero results with no error, which is exactly what
  happened before both were added (a real, caught bug, not just caution).
- Two tile shapes are handled — see below. Twelve tiles total exist on the
  dashboard: "SLA status by channel", "SLA status", "Email", "Messaging",
  "Voice", "Satisfaction distribution by channel", "Satisfaction score by
  channel", "Ticket status for email/messaging/voice (historical data)",
  "Ticket status", "Tickets in progress".

### (a) "Multiple Value" numeric tiles — WORKING

Covers "SLA status", "Email", "Messaging", "Voice", "Satisfaction score by
channel", and the historical/ticket-status tiles.

- Each renders in its OWN per-tile iframe, individually **sandboxed**
  (`iframe sandbox` without `allow-same-origin`) — a same-host
  `contentDocument` reach-in from a sibling/parent frame's own JS returns
  `null` even though they share a hostname (this blocked manual
  DevTools-console probing). **CONFIRMED this does NOT block Playwright** —
  `elementHandle.contentFrame()` operates through the browser's automation
  protocol (same access level as DevTools), not page-JS.
- Each per-tile iframe carries an **`aria-label` matching its own title**
  (e.g. `iframe[aria-label="Email"]`) — the direct, reliable way tiles are
  found (`scrapeMultipleValueTiles`). The iframe `src` itself carries NO
  tile-identifying info (every tile using this viz shares the exact same
  src, e.g. `.../render/marketplace_viz_multiple_value::multiple_value-marketplace`),
  so src/order can't be used to tell tiles apart — aria-label can.
- Tiles lazy-load their iframe only once scrolled into view —
  `scrollLookerDashboardIntoView()` handles this. **A real, confirmed bug**
  in an earlier version: it scrolled `document.scrollingElement`, which has
  NOTHING to scroll in this dashboard (`scrollHeight === clientHeight`,
  total no-op) — fixed to find the actual scrollable container generically
  (by computed `overflow-y` + `scrollHeight > clientHeight`), since the
  real container's class name is an auto-generated styled-components hash
  not worth hardcoding.
- Inside each tile: elements with `[class*="DataPointGroup"]`/
  `DataPointValue` classes — each data point renders as two lines of text,
  label then value (e.g. `"Messaging\n74%"`).

### (b) Donut/pie tiles — "SLA status by channel" WORKING, "Satisfaction distribution by channel" NOT YET

- These render **directly inline** in the Looker dashboard frame's own DOM
  — a D3-based chart, NOT a per-tile iframe like (a) above. No
  `contentFrame()` hop needed; the SVG lives right there.
- **The exact values are ONLY available via hover tooltip** — there is no
  static text, `__data__` binding (checked, not present), or accessible
  data table for them; only the arc's fill COLOR (which maps consistently
  to category: `#BC4045` red=Breached, `#AF872C` amber=Nearing breach,
  `#509F7B` green=Within SLA) is available without hovering.
- **Browser-console synthetic hover (`element.dispatchEvent(new MouseEvent(...))`)
  NEVER triggered the tooltip**, in any event-type combination tried
  (mouseover/mousemove, then a full pointerenter/pointerover/pointermove
  sequence) — dispatched events are always `isTrusted:false`, and this
  chart's hover detection appears to require genuinely trusted input.
  **Real Playwright `page.mouse.move()` DOES trigger it** — confirmed both
  by screenshot and by reading the resulting tooltip text programmatically.
- Getting this reliable took real iteration, all now baked into the code:
  - A single instant `page.mouse.move(x, y)` jump often failed to trigger
    the tooltip; moving AWAY first then approaching with smooth multi-step
    movement (`{ steps: 15 }`) — mimicking a real cursor slide — worked
    far more consistently.
  - The tooltip doesn't exist in the DOM until hovered (confirmed zero
    matching elements at rest) and needs a short poll-with-jiggle after
    the hover to actually appear, not a single fixed-delay check
    (`hoverAndReadDonutTooltip`).
  - A donut's arc path midpoint (50% of path length) can land on a point
    that's VISUALLY COVERED by a DIFFERENT overlapping segment (donut
    charts commonly draw a full background ring UNDER a smaller foreground
    arc) — this caused real, observed duplicate/missing categories
    ("Email - Within SLA" reported twice, "Email - Breached" missing
    entirely) until fixed by trying several points along each path (50%,
    25%, 75%, 35%, 65%) and verifying via `elementFromPoint` that the
    point actually resolves to the SAME path (tagged with a temporary
    `data-flex-idx` attribute) before trusting its tooltip.
  - A stale tooltip from the PREVIOUS hover can still be in the DOM when
    the NEXT segment (or next tile) starts checking — this caused a real,
    observed bug where "Satisfaction distribution by channel" reported
    `"Voice - Breached"` (an SLA category, not a satisfaction one) purely
    because it was leftover from the PREVIOUS tile's last hover.
    `waitForDonutTooltipCleared()` actively polls for the tooltip to
    disappear between every segment and before starting each tile, rather
    than assuming a mouse-move-away is instant/sufficient.
  - A final defensive dedupe by `(tile, label)` is kept even after all of
    the above, in case some edge case still slips through.
- **"SLA status by channel" is fully working and verified across multiple
  live runs** — correctly returns all 7 segments (Email: Breached/Nearing
  breach/Within SLA; Messaging: same 3; Voice: Breached only, matching its
  all-red ring), no duplicates, no cross-tile bleed.
- **"Satisfaction distribution by channel" is NOT working** — its `<h2>`
  title is found, but `waitForDonutTileReady()` never finds a chart SVG
  with more than 2 `<path>` elements there (tried both a fixed SVG index
  AND a "most paths wins" heuristic — neither found it). This isn't simply
  a wrong-selector issue at this point; it's more likely a genuinely
  different chart type for this tile (e.g. bars/rects instead of arc
  paths) that hasn't been probed. Left unhandled rather than guessed at —
  this was NOT the account's stated priority ("especially SLA status by
  channel" was the explicit ask), so it was deliberately not chased
  further this session.
- Both tiles are named in `DONUT_TILE_TITLES` — remove `'Satisfaction
  distribution by channel'` from that list (or fix its detection) once
  its actual chart shape is probed.

### Widget-error recovery

Observed live (via screenshot from the account owner): the dashboard
frequently renders its tile shells (titles visible: "SLA status by
channel", "SLA status", "Email", "Messaging", etc.) but shows every widget
in an error state — a small circular "!" icon in place of any chart/numbers
— instead of real data. Reported as happening "sometimes or most of the
times". A known, apparently common Looker/Explore embedding failure mode
(the underlying query erroring out), and reloading the page is the normal
human fix.

Handled in `scrapeExploreDashboard()`: after the normal generous load-wait
(the same polling that already tells "still loading" apart from "broken" —
important since the dashboard genuinely does take a while to render), if
title tiles clearly exist but **literally none** of the tiles we know how
to read (multi-value + the working donut) produced any data, that's treated
as the widget-error signature — the page gets ONE full reload
(`page.reload()`) and the whole attempt is retried once before giving up
for that tick. "Satisfaction distribution by channel" is deliberately
excluded from this check (see `looksLikeWidgetError()`) since it never
produces data regardless of dashboard health — including it would trigger
a reload on literally every tick, forever.

**Verified live** (with the main scraper stopped via `remove flex`, running a
temporary test script against the real, already-logged-in `flex-profile`):
- Unit-tested `looksLikeWidgetError()` against 5 synthetic input shapes
  (still-loading, healthy, total-error, error-but-only-the-permanently-broken-
  donut-"succeeded", no-multi-value-tiles-exist) — all 5 matched expectation.
- Ran the real `scrapeExploreDashboardAttempt()`/`scrapeExploreDashboard()`
  against the live dashboard: the dashboard happened to be HEALTHY during
  this test (33 real results — SLA status, Email, Messaging counts, etc.),
  so the reload branch did not fire naturally, but this confirms the new
  code didn't regress the happy path.
- Manually forced a real `page.reload()` + re-scrape (the exact sequence
  `scrapeExploreDashboard()` runs when it detects the error signature) and
  confirmed the dashboard comes back healthy and scrapable immediately
  after a reload (25 results on that pass — the count naturally varies a
  little tick-to-tick from donut-hover timing, not a bug).
- **Still not confirmed**: an actual live occurrence of the screenshot's
  error state triggering the reload branch organically during normal
  ticking — the dashboard simply wasn't in that state during this test
  window, and the exact error icon's DOM markup was never probed. This
  remains a coarse "whole-dashboard looks broken" signal, not a targeted
  per-tile error detector, and does not handle a PARTIAL failure (some
  tiles fine, others erroring) at all — only total failure. Watch for the
  `"looks like the known Looker widget-error state"` console warning during
  real operation to confirm it fires correctly when the real error recurs.

### Known remaining risk

- Each donut hover-cycle takes roughly 1-3s (move-away + smooth-approach +
  poll-with-jiggle + clear-wait), and a full tick now takes **~20-50s**
  (observed across live runs) for General ticket table + Geckoboard +
  Explore (numeric tiles + one donut) combined — noticeably more than the
  `interval: 30000` the account is configured for. The account owner chose
  "scrape every tick anyway, accept the latency" rather than throttling
  donut-scraping to every Nth tick — worth revisiting if this consistently
  runs long enough to matter in practice (overlapping ticks are already
  guarded against elsewhere in this codebase via `account-runner.js`'s
  `_ticking` flag, so this is a latency/freshness concern, not a
  correctness one).
- The General ticket table (`flex_tickets`) intermittently returned 0
  tickets in a couple of test runs, unrelated to any Explore-dashboard
  change — not yet root-caused. Worth a closer look if it recurs.

Implemented in `scrapers/flex/index.js`: `ensureExplorePage`,
`waitForLookerFrame`, `findLookerDashboardFrame`,
`scrollLookerDashboardIntoView`, `scrapeMultipleValueTiles`,
`waitForDonutTileReady`, `frameToPageCoords`, `waitForDonutTooltipCleared`,
`hoverAndReadDonutTooltip`, `scrapeDonutTile`, `scrapeAllDonutTiles`,
`scrapeExploreDashboard`, `writeFlexExploreTiles` → `flex_explore_tiles` in
`sql/flex.sql` (donut results reuse the same `tile`/`label`/`value` shape,
with `label` formatted as `"<channel> - <category>"`, e.g.
`"Messaging - Breached"` — no separate table needed).

## Other notes

- Login is 100% manual for this account (Google SSO + 2FA — see section 1)
  — every restart / session expiry requires a human to log in by hand in
  the visible browser window, then run `resume flex`. `config.json`'s
  `email`/`password` fields are UNUSED by `login()` and left blank on
  purpose (kept only in case a scriptable path ever becomes available,
  matching `scrapers/homebase/index.js`'s vestigial fields) — there is
  nothing to "fill in" for login to work.
- Nothing here is wired into the WFM Live Dashboard app's UI yet (this data
  doesn't fit its existing KPI/Agent Status config model) — that's a
  separate, not-yet-discussed decision for later.
