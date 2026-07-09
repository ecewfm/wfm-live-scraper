-- ─────────────────────────────────────────────────────────────────────────────
-- ZenBusiness (NICE CXone) — dedicated tables + dashboard registration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Same generic, schema-free approach used for Hippo — widget names/columns are
-- discovered at scrape time rather than hardcoded, so a newly-appearing widget
-- never needs a schema change. Once real widgets are seen after the first
-- login, known ones can be promoted to dedicated typed tables the same way
-- Hippo's Licensed Agents/Level 1 were (see sql/hippo.sql for that pattern).
--   zenbusiness_kpis      — one row per (widget, metric) tile. New tile → new row.
--   zenbusiness_datasets  — one row per discovered ag-Grid widget, full
--                           headers+rows stored as JSONB. New widget → new row.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. KPI label-value table (tiles: queue counters, SLA %, etc.) ─────────────
CREATE TABLE IF NOT EXISTS zenbusiness_kpis (
  id          text PRIMARY KEY,          -- "zenbusiness:{widget}:{metric}"
  account_id  text NOT NULL,
  kpi_key     text,
  label       text,                      -- metric name, e.g. "SLA %"
  skill       text,                      -- widget name, e.g. "CS CARE PHONES SLA"
  value       text,
  raw_value   text,
  updated_at  timestamptz DEFAULT now()
);

-- ── 2. Generic ag-Grid table widgets — dynamic shape ───────────────────────────
CREATE TABLE IF NOT EXISTS zenbusiness_datasets (
  id            text PRIMARY KEY,        -- "zenbusiness:{dataset_name}"
  account_id    text NOT NULL,
  dataset_name  text,                    -- widget title as scraped
  headers       jsonb,                   -- column headers, e.g. ["Snapshot Time","Agent","State"]
  rows          jsonb,                   -- array of row arrays
  row_count     int  DEFAULT 0,
  updated_at    timestamptz DEFAULT now()
);

-- ── 2b. Agent-roster widgets → each widget gets its OWN typed table ────────────
-- Reverted from one shared table (team_name column) to one table per widget,
-- since the real columns genuinely differ per widget: most are Agent Name/
-- Agent State/Agent State Time, but Agent Contact View adds Contact No/Skill/
-- Channel, and ECE Contact List uses different header names entirely. See
-- scrapers/zenbusiness/index.js' KNOWN_AGENT_WIDGETS for the exact per-widget
-- header→column mapping (matched by header NAME, not position).
--
-- NOTE: the old shared zenbusiness_agent_states table is no longer written to
-- as of this change — it still exists with whatever data it had, but nothing
-- updates it going forward. Drop it manually if/when you're sure you don't
-- need it (not done here — dropping a table isn't something to automate).
CREATE TABLE IF NOT EXISTS zenbusiness_collection_team (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zenbusiness_cs_success_email (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zenbusiness_cs_success_chat (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zenbusiness_retention_team (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zenbusiness_web_services (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zenbusiness_cs_care_phones (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zenbusiness_moneybanking_team (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, state text, state_time text, updated_at timestamptz DEFAULT now()
);
-- Agent Contact View has extra columns (contact/skill/channel) the others don't.
CREATE TABLE IF NOT EXISTS zenbusiness_agent_contact_view (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, contact_no text, skill text, channel text,
  state text, state_time text, updated_at timestamptz DEFAULT now()
);
-- ECE Contact List has a channel column the plain team widgets don't.
CREATE TABLE IF NOT EXISTS zenbusiness_ece_contact_list (
  id text PRIMARY KEY, account_id text NOT NULL, agent_name text, channel text, state text, state_time text, updated_at timestamptz DEFAULT now()
);

-- ── 3. Realtime — safe to re-run; skips tables already in the publication ─────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'zenbusiness_kpis', 'zenbusiness_datasets',
    'zenbusiness_collection_team', 'zenbusiness_cs_success_email', 'zenbusiness_cs_success_chat',
    'zenbusiness_retention_team', 'zenbusiness_web_services', 'zenbusiness_cs_care_phones',
    'zenbusiness_moneybanking_team', 'zenbusiness_agent_contact_view', 'zenbusiness_ece_contact_list'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;

-- ── 4. Register ZenBusiness in the dashboard ───────────────────────────────────
INSERT INTO wfm_accounts (id, display_name, active, sort_order, created_at)
VALUES ('zenbusiness', 'ZenBusiness', true, EXTRACT(EPOCH FROM now())::int, now())
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, active = true;

-- First-time setup only — does nothing if the row already exists, so this
-- never clobbers any KPI groups/labels you've since configured in Settings.
INSERT INTO wfm_settings (id, account_id, data_source, updated_at)
VALUES (
  'zenbusiness', 'zenbusiness',
  '{
    "version": 2,
    "kpiTable": "zenbusiness_kpis",
    "kpiAccountCol": "account_id",
    "kpiGroupCol": "skill",
    "kpiRowKeyCol": "",
    "kpiUpdatedAt": "updated_at",
    "kpiLabels": { "sla": "SLA %", "aht": "AHT", "abn": "ABN %", "wait": "Awaiting" },
    "extraTiles": [],
    "groups": [{ "id": "global", "name": "Global", "cells": {} }],
    "agentTable": "",
    "agentAccountCol": "account_id",
    "agentNameCol": "",
    "agentStatusCol": "",
    "agentDurationCol": "",
    "agentDurationSecs": ""
  }'::jsonb,
  now()
)
ON CONFLICT (id) DO NOTHING;

-- Pre-configures all 9 Agent Sources so the dashboard's Agent Status list
-- shows every team combined without needing to click through Settings —
-- see components/SettingsModal.tsx's "ADDITIONAL AGENT SOURCES" section if
-- you ever want to review/adjust these. Uses jsonb `||` merge (not a full
-- replace) so it only touches agentTable/agentSources — any KPI groups,
-- custom tile labels, or other Data Source settings you've already
-- configured for ZenBusiness are left exactly as they are.
UPDATE wfm_settings
SET data_source = data_source || '{
    "agentTable": "",
    "agentSources": [
      { "id": "collection_team",     "label": "Collection Team",     "table": "zenbusiness_collection_team",     "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "cs_success_email",    "label": "CS Success - Email",  "table": "zenbusiness_cs_success_email",    "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "cs_success_chat",     "label": "CS Success - Chat",   "table": "zenbusiness_cs_success_chat",     "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "retention_team",      "label": "Retention Team",      "table": "zenbusiness_retention_team",      "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "web_services",        "label": "Web Services",        "table": "zenbusiness_web_services",        "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "cs_care_phones",      "label": "CS CARE - PHONES",    "table": "zenbusiness_cs_care_phones",      "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "moneybanking_team",   "label": "MoneyBanking Team",   "table": "zenbusiness_moneybanking_team",   "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "agent_contact_view",  "label": "Agent Contact View",  "table": "zenbusiness_agent_contact_view",  "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" },
      { "id": "ece_contact_list",    "label": "ECE Contact List",    "table": "zenbusiness_ece_contact_list",    "accountCol": "account_id", "nameCol": "agent_name", "statusCol": "state", "durationCol": "state_time", "durationSecsCol": "", "groupByCol": "" }
    ]
  }'::jsonb,
  updated_at = now()
WHERE id = 'zenbusiness';
