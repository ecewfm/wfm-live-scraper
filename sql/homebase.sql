-- ─────────────────────────────────────────────────────────────────────────────
-- Homebase (Talkdesk) — dedicated tables + dashboard registration
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Homebase's Live Dashboard is the same underlying Talkdesk product as
-- ashley-phones (confirmed via a live DOM probe — same reporting-live-
-- dashboards-ui iframe, same [data-testid="widget-card"] convention), but
-- its widget set is per-queue rather than per-LOB, so it gets its own
-- tables instead of reusing talkdesk_lob_kpis/talkdesk_agent_states.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Global KPIs (one row — dashboard tiles) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS homebase_global_kpis (
  id                          text PRIMARY KEY,   -- account_id ("homebase")
  account_id                  text NOT NULL,
  contacts_in_queue           text,
  contacts_in_queue_threshold text,
  service_level               text,
  abandon_rate                text,
  longest_wait_time           text,               -- aggregate value; can be "Ø" (none)
  updated_at                  timestamptz DEFAULT now()
);

-- ── 2. Per-queue breakdown (Live Contacts In Queue + Longest Wait Time) ────────
CREATE TABLE IF NOT EXISTS homebase_queue_stats (
  id                 text PRIMARY KEY,   -- "homebase:{queue_name}"
  account_id         text NOT NULL,
  queue_name         text,
  contacts_in_queue  text,
  longest_wait_time  text,               -- can be "Ø" (none)
  updated_at         timestamptz DEFAULT now()
);

-- ── 3. Agent states (Live Agents List) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS homebase_agent_states (
  id                  text PRIMARY KEY,  -- "homebase:{agent_name}"
  account_id          text NOT NULL,
  agent_name          text,
  queues              text,
  status              text,
  channels            text,
  occupancy           text,              -- e.g. "51/100"
  time_in_status      text,
  updated_at          timestamptz DEFAULT now()
);

-- ── 4. Live contacts list (Contacts List — replaced in full each cycle,
-- same pattern as wfm_active_calls, since this is inherently transient) ────────
CREATE TABLE IF NOT EXISTS homebase_active_contacts (
  id            text PRIMARY KEY,        -- "homebase:{row_index}"
  account_id    text NOT NULL,
  status        text,
  agent         text,
  contact_info  text,
  queues        text,
  live_queues   text,
  duration      text,
  hold_time     text,
  callback      text,
  updated_at    timestamptz DEFAULT now()
);

-- ── 5. Realtime (ignore "already member of publication" errors) ───────────────
ALTER PUBLICATION supabase_realtime ADD TABLE homebase_global_kpis;
ALTER PUBLICATION supabase_realtime ADD TABLE homebase_queue_stats;
ALTER PUBLICATION supabase_realtime ADD TABLE homebase_agent_states;
ALTER PUBLICATION supabase_realtime ADD TABLE homebase_active_contacts;

-- ── 6. Register Homebase in the dashboard ──────────────────────────────────────
INSERT INTO wfm_accounts (id, display_name, active, sort_order, created_at)
VALUES ('homebase', 'Homebase', true, EXTRACT(EPOCH FROM now())::int, now())
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, active = true;

INSERT INTO wfm_settings (id, account_id, data_source, updated_at)
VALUES (
  'homebase', 'homebase',
  '{
    "kpiTable": "homebase_global_kpis",
    "kpiAccountCol": "account_id",
    "kpiGroupCol": "",
    "kpiSlaCol": "service_level",
    "kpiQueueCol": "contacts_in_queue",
    "kpiAsaCol": "",
    "kpiAbnCol": "abandon_rate",
    "kpiAgentsCol": "",
    "kpiUpdatedAt": "updated_at",
    "agentTable": "homebase_agent_states",
    "agentAccountCol": "account_id",
    "agentNameCol": "agent_name",
    "agentStatusCol": "status",
    "agentDurationCol": "time_in_status",
    "agentDurationSecs": ""
  }'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET data_source = EXCLUDED.data_source, updated_at = now();
