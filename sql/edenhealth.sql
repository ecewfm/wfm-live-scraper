-- ─────────────────────────────────────────────────────────────────────────────
-- Eden Health (Zendesk WFM + Explore) — dedicated tables + dashboard registration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Two sources feed this account, scraped from two different Zendesk pages in
-- the same tick (see scrapers/edenhealth/index.js):
--   edenhealth_kpis    — Explore dashboard's ~22 fixed KPI tiles (label/value)
--   edenhealth_agents  — WFM Agent Status page's ECE team roster
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. KPI label-value table (Explore dashboard tiles) ────────────────────────
CREATE TABLE IF NOT EXISTS edenhealth_kpis (
  id          text PRIMARY KEY,          -- "edenhealth:{kpi_key}"
  account_id  text NOT NULL,
  kpi_key     text,
  label       text,                      -- e.g. "Voice - Calls in queue"
  value       text,
  delta       text,                      -- the tile's secondary/delta measure, if any
  updated_at  timestamptz DEFAULT now()
);

-- ── 2. ECE agent roster (WFM Agent Status page) ───────────────────────────────
CREATE TABLE IF NOT EXISTS edenhealth_agents (
  id                  text PRIMARY KEY,  -- "edenhealth:{agent_name}"
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

-- ── 3. Realtime — safe to re-run; skips tables already in the publication ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'edenhealth_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE edenhealth_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'edenhealth_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE edenhealth_agents;
  END IF;
END $$;

-- ── 4. Register Eden Health in the dashboard ───────────────────────────────────
-- kpiSlaCol/kpiQueueCol/kpiAsaCol/kpiAbnCol all point at the same generic
-- "value" column (kpiGroupCol = "label" picks the row) — same pattern as
-- Hippo. Map each KPI slot to its specific row (e.g. "Support - Satisfaction
-- (today)") via the Dashboard's Settings > Data Sources cell-picker, since
-- there's no single obvious SLA/queue/ASA/ABN% tile here (Support/Voice/
-- Messaging each have their own separate metrics).
INSERT INTO wfm_accounts (id, display_name, active, sort_order, created_at)
VALUES ('edenhealth', 'Eden Health', true, EXTRACT(EPOCH FROM now())::int, now())
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, active = true;

INSERT INTO wfm_settings (id, account_id, data_source, updated_at)
VALUES (
  'edenhealth', 'edenhealth',
  '{
    "kpiTable": "edenhealth_kpis",
    "kpiAccountCol": "account_id",
    "kpiGroupCol": "label",
    "kpiSlaCol": "value",
    "kpiQueueCol": "value",
    "kpiAsaCol": "value",
    "kpiAbnCol": "value",
    "kpiAgentsCol": "value",
    "kpiUpdatedAt": "updated_at",
    "agentTable": "edenhealth_agents",
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
