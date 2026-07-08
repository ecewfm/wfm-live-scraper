-- ─────────────────────────────────────────────────────────────────────────────
-- Hippo (NICE CXone) — dedicated tables + dashboard registration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- NICE CXone dashboards are tenant-configurable — widgets vary per account and
-- can change over time. Instead of hardcoding a column per KPI/table (like the
-- Five9 scrapers do), these two tables absorb ANY newly-discovered widget
-- without ever needing a schema change:
--   hippo_kpis      — one row per (widget, metric) tile. New tile → new row.
--   hippo_datasets  — one row per discovered table widget (ag-Grid/HTML), full
--                     headers+rows stored as JSONB. New table widget → new row.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. KPI label-value table (tiles: queue counters, SLA %, etc.) ─────────────
CREATE TABLE IF NOT EXISTS hippo_kpis (
  id          text PRIMARY KEY,          -- "hippo:{widget}:{metric}"
  account_id  text NOT NULL,
  kpi_key     text,
  label       text,                      -- metric name, e.g. "SLA %"
  skill       text,                      -- widget name, e.g. "Service Level"
  value       text,
  raw_value   text,
  updated_at  timestamptz DEFAULT now()
);

-- ── 2. Generic table widgets (ag-Grid / HTML tables) — dynamic shape ──────────
CREATE TABLE IF NOT EXISTS hippo_datasets (
  id            text PRIMARY KEY,        -- "hippo:{dataset_name}"
  account_id    text NOT NULL,
  dataset_name  text,                    -- widget title as scraped
  headers       jsonb,                   -- column headers, e.g. ["Snapshot Time","Agent","State"]
  rows          jsonb,                   -- array of row arrays
  row_count     int  DEFAULT 0,
  updated_at    timestamptz DEFAULT now()
);

-- ── 2b. Known widgets promoted to typed tables (real columns, not JSONB) ──────
-- Confirmed headers as of 2026-07-08. If NICE ever adds/renames a column on
-- these widgets, update both this schema AND KNOWN_WIDGETS in
-- scrapers/hippo/index.js — until then, they no longer land in hippo_datasets.
CREATE TABLE IF NOT EXISTS hippo_licensed_agents (
  id                text PRIMARY KEY,     -- "hippo:licensed_agents:{agent_name}"
  account_id        text NOT NULL,
  agent_name        text,
  team_name         text,
  session_time      text,                 -- e.g. "00:07:06"
  agent_state       text,                 -- e.g. "Available", "Break", "Logged Out"
  agent_state_time  text,                 -- time in current state, e.g. "00:03:17"
  updated_at        timestamptz DEFAULT now()
);

-- Assumed same schema as hippo_licensed_agents (same "AGENT NAME" lead column) —
-- adjust columns above/below if Level 1's actual headers turn out to differ.
CREATE TABLE IF NOT EXISTS hippo_level_1 (
  id                text PRIMARY KEY,     -- "hippo:level_1:{agent_name}"
  account_id        text NOT NULL,
  agent_name        text,
  team_name         text,
  session_time      text,
  agent_state       text,
  agent_state_time  text,
  updated_at        timestamptz DEFAULT now()
);

-- TODO: hippo_contact_list — waiting on actual headers/rows sample (starts
-- with "CONTACT NO", different schema than the agent-roster widgets above).

-- ── 3. Realtime — safe to re-run; skips tables already in the publication ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'hippo_kpis') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE hippo_kpis;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'hippo_datasets') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE hippo_datasets;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'hippo_licensed_agents') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE hippo_licensed_agents;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'hippo_level_1') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE hippo_level_1;
  END IF;
END $$;

-- ── 4. Register Hippo in the dashboard ─────────────────────────────────────────
-- Makes "Hippo" appear as an account and points it at the hippo_kpis table for
-- SLA/queue tiles. hippo_datasets (arbitrary table widgets) has no fixed shape,
-- so it isn't wired into wfm_settings here — that needs a generic-table viewer
-- on the dashboard side if/when you want to display those widgets directly.
INSERT INTO wfm_accounts (id, display_name, active, sort_order, created_at)
VALUES ('hippo', 'Hippo', true, EXTRACT(EPOCH FROM now())::int, now())
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, active = true;

INSERT INTO wfm_settings (id, account_id, data_source, updated_at)
VALUES (
  'hippo', 'hippo',
  '{
    "kpiTable": "hippo_kpis",
    "kpiAccountCol": "account_id",
    "kpiGroupCol": "skill",
    "kpiSlaCol": "value",
    "kpiQueueCol": "value",
    "kpiAsaCol": "value",
    "kpiAbnCol": "",
    "kpiAgentsCol": "",
    "kpiUpdatedAt": "updated_at",
    "agentTable": "",
    "agentAccountCol": "",
    "agentNameCol": "",
    "agentStatusCol": "",
    "agentDurationCol": "",
    "agentDurationSecs": ""
  }'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET data_source = EXCLUDED.data_source, updated_at = now();
