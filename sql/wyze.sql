-- ─────────────────────────────────────────────────────────────────────────────
-- Wyze (Zendesk WFM + Explore + Chat Monitor) — dedicated tables + registration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Three sources feed this account, scraped from three different Zendesk pages
-- in the same tick (see scrapers/wyze/index.js):
--   wyze_agents        — WFM Agent Status page's ECE team roster
--   wyze_kpis          — Explore dashboard's KPI tiles (deferred until the
--                        real dashboard URL is configured in config.json)
--   wyze_chat_monitor  — Chat Monitor page's live queue/response/duration/
--                        agent stats — a source Eden Health doesn't have
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. ECE agent roster (WFM Agent Status page) — same shape as edenhealth_agents
CREATE TABLE IF NOT EXISTS wyze_agents (
  id                  text PRIMARY KEY,  -- "wyze:{agent_name}"
  account_id          text NOT NULL,
  agent_name          text,
  activity            text,              -- e.g. "Phones", "Chats"
  ticket_number       text,
  activity_duration   text,
  adherence_current   text,              -- "In adherence" / "Out of adherence"
  adherence_duration  text,
  status              text,              -- "On call" / "Offline" / "Away" / "Wrap up"
  status_duration     text,              -- time in current status — drives breach tracking
  updated_at          timestamptz DEFAULT now()
);

-- ── 2. KPI label-value table (Explore dashboard tiles) ────────────────────────
-- Same generic shape as edenhealth_kpis/hippo_kpis — no fixed KPI list needed,
-- since Wyze's tile query-IDs haven't been catalogued yet (KPI_MAP is empty
-- in scrapers/wyze/index.js; unknown tiles land here labeled automatically).
CREATE TABLE IF NOT EXISTS wyze_kpis (
  id          text PRIMARY KEY,          -- "wyze:{kpi_key}"
  account_id  text NOT NULL,
  kpi_key     text,
  label       text,
  value       text,
  delta       text,                      -- the tile's secondary/delta measure, if any
  updated_at  timestamptz DEFAULT now()
);

-- ── 3. Chat Monitor live stats — one row per (card, metric) ───────────────────
-- Dynamic/generic on purpose: the Chat Monitor page has several widget shapes
-- (single big number, label/value grids, value/label stacks) covering queue
-- totals, response time, chat duration, agents online, etc. — storing as
-- (card, metric, value) absorbs all of them without a fixed schema per metric.
CREATE TABLE IF NOT EXISTS wyze_chat_monitor (
  id          text PRIMARY KEY,          -- "wyze:{card}:{metric}"
  account_id  text NOT NULL,
  card        text,                      -- widget title, e.g. "Response time", "Queue"
  metric      text,                      -- e.g. "Average", "Longest", "Chats"
  value       text,
  updated_at  timestamptz DEFAULT now()
);

-- ── 4. Realtime — safe to re-run; skips tables already in the publication ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'wyze_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wyze_agents;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'wyze_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wyze_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'wyze_chat_monitor') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wyze_chat_monitor;
  END IF;
END $$;

-- ── 5. Register Wyze in the dashboard ──────────────────────────────────────────
-- kpiSlaCol/kpiQueueCol/kpiAsaCol/kpiAbnCol all point at the same generic
-- "value" column (kpiGroupCol = "label" picks the row) — same pattern as
-- Hippo/Eden Health. Map each KPI slot to its specific row via the Dashboard's
-- Settings > Data Sources cell-picker once Explore scraping is actually live.
-- wyze_chat_monitor isn't wired into a kpi/agent slot here (no fixed shape to
-- map generically) — view/wire it up on the dashboard side separately if you
-- want its numbers surfaced as specific KPI tiles.
INSERT INTO wfm_accounts (id, display_name, active, sort_order, created_at)
VALUES ('wyze', 'Wyze', true, EXTRACT(EPOCH FROM now())::int, now())
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, active = true;

INSERT INTO wfm_settings (id, account_id, data_source, updated_at)
VALUES (
  'wyze', 'wyze',
  '{
    "kpiTable": "wyze_kpis",
    "kpiAccountCol": "account_id",
    "kpiGroupCol": "label",
    "kpiSlaCol": "value",
    "kpiQueueCol": "value",
    "kpiAsaCol": "value",
    "kpiAbnCol": "value",
    "kpiAgentsCol": "value",
    "kpiUpdatedAt": "updated_at",
    "agentTable": "wyze_agents",
    "agentAccountCol": "account_id",
    "agentNameCol": "agent_name",
    "agentStatusCol": "status",
    "agentDurationCol": "status_duration",
    "agentDurationSecs": ""
  }'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET data_source = EXCLUDED.data_source, updated_at = now();
