-- ─────────────────────────────────────────────────────────────────────────────
-- Uniters — dedicated Five9 tables + dashboard registration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Uniters gets its OWN tables (uniters_*), fully separate from PerfectServe's
-- five9_* tables. Rows still carry account_id = 'uniters' because the dashboard
-- filters each account by its account_id column.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. KPI label-value table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uniters_kpis (
  id          text PRIMARY KEY,          -- "uniters:{kpi_key}"
  account_id  text NOT NULL,
  kpi_key     text,
  label       text,
  skill       text,
  value       text,
  raw_value   text,
  updated_at  timestamptz DEFAULT now()
);

-- ── 2. Flat global KPI summary (one row — dashboard tiles) ─────────────────────
CREATE TABLE IF NOT EXISTS uniters_global_kpis (
  id               text PRIMARY KEY,     -- account_id ("uniters")
  account_id       text NOT NULL,
  sla              text,
  avg_handle_time  text,
  calls_in_queue   text,
  calls_abandoned  text,
  total_calls      text,
  agents_ready     int  DEFAULT 0,
  agents_not_ready int  DEFAULT 0,
  agents_on_call   int  DEFAULT 0,
  updated_at       timestamptz DEFAULT now()
);

-- ── 3. Agent states (one row per agent, full Unister grid) ────────────────────
CREATE TABLE IF NOT EXISTS uniters_agent_states (
  id                 text PRIMARY KEY,   -- "uniters:{username|name}"
  account_id         text NOT NULL,
  name               text,
  username           text,
  email              text,
  state              text,
  duration           text,
  current_state      text,
  state_since        text,
  call_type          text,
  campaign           text,
  customer           text,
  media_availability text,
  on_hold_duration   text,
  on_hold_since      text,
  reason             text,
  reason_duration    text,
  not_ready_duration text,
  on_call_duration   text,
  total_cap          text,
  voice_wl           text,
  chat_wl            text,
  agent_groups       text,
  user_profile       text,
  working_on         text,
  updated_at         timestamptz DEFAULT now()
);

-- ── 4. ACD status (per-skill queue stats) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS uniters_acd_status (
  id                    text PRIMARY KEY, -- "uniters:{skill_name}"
  account_id            text NOT NULL,
  skill_name            text,
  calls_in_queue        text,
  active_agents         text,
  on_calls              text,
  ready_for_calls       text,
  not_ready_for_calls   text,
  current_longest_queue text,
  longest_queue_time    text,
  service_level         text,
  avg_speed_of_answer   text,
  calls_handled         text,
  updated_at            timestamptz DEFAULT now()
);

-- ── 5. Campaign statistics (one row per campaign) ─────────────────────────────
CREATE TABLE IF NOT EXISTS uniters_campaign_stats (
  id                  text PRIMARY KEY,   -- "uniters:{campaign_name}"
  account_id          text NOT NULL,
  campaign_name       text,
  total_calls         text,
  calls_abandoned     text,
  avg_handle_time     text,
  avg_speed_of_answer text,
  drop_call_pct       text,
  avg_talk_time       text,
  avg_wrap_time       text,
  calls_connected     text,
  handled_calls       text,
  updated_at          timestamptz DEFAULT now()
);

-- ── 6. Realtime (ignore "already member of publication" errors) ───────────────
ALTER PUBLICATION supabase_realtime ADD TABLE uniters_kpis;
ALTER PUBLICATION supabase_realtime ADD TABLE uniters_global_kpis;
ALTER PUBLICATION supabase_realtime ADD TABLE uniters_agent_states;
ALTER PUBLICATION supabase_realtime ADD TABLE uniters_acd_status;
ALTER PUBLICATION supabase_realtime ADD TABLE uniters_campaign_stats;

-- ── 7. Register Uniters in the dashboard ──────────────────────────────────────
-- Makes "Uniters" appear as an account and points it at the uniters_* tables.
INSERT INTO wfm_accounts (id, display_name, active, sort_order, created_at)
VALUES ('uniters', 'Uniters', true, EXTRACT(EPOCH FROM now())::int, now())
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, active = true;

INSERT INTO wfm_settings (id, account_id, data_source, updated_at)
VALUES (
  'uniters', 'uniters',
  '{
    "kpiTable": "uniters_kpis",
    "kpiAccountCol": "account_id",
    "kpiGroupCol": "skill",
    "kpiSlaCol": "value",
    "kpiQueueCol": "value",
    "kpiAsaCol": "value",
    "kpiAbnCol": "",
    "kpiAgentsCol": "",
    "kpiUpdatedAt": "updated_at",
    "agentTable": "uniters_agent_states",
    "agentAccountCol": "account_id",
    "agentNameCol": "name",
    "agentStatusCol": "state",
    "agentDurationCol": "duration",
    "agentDurationSecs": ""
  }'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET data_source = EXCLUDED.data_source, updated_at = now();
