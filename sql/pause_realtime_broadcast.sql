-- ─────────────────────────────────────────────────────────────────────────────
-- Pause the broadcast triggers — band-aid until the webhook relay ships
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- The dashboard's Realtime subscription is now disabled client-side
-- (REALTIME_ENABLED = false in Dashboard.tsx), which stops the "received"
-- side of Supabase's per-message billing (1 sent + N received per broadcast).
-- But the triggers built in realtime_status_broadcast.sql / realtime_kpi_
-- broadcast.sql still fire realtime.send() on every real change regardless
-- of whether any client is subscribed — and per Supabase's own billing rule,
-- the SEND itself always counts as at least 1 message, even with zero
-- receivers. So without this, messages would still accumulate, just without
-- the viewer-count multiplier.
--
-- Guarded with existence checks (to_regclass + pg_trigger) so this is safe to
-- run even if some of these triggers were never actually created yet (e.g.
-- realtime_kpi_broadcast.sql only partially ran) — it just skips whatever
-- isn't there instead of erroring.
--
-- DISABLE (not DROP) so this is trivially reversible — either flip
-- REALTIME_ENABLED back to true once ready, or point these same triggers at
-- a Database Webhook for the self-hosted relay instead of realtime.send().
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_status_change' AND tgrelid = to_regclass('wfm_agent_states')) THEN
    ALTER TABLE wfm_agent_states DISABLE TRIGGER trg_notify_status_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_status_change' AND tgrelid = to_regclass('talkdesk_agent_states')) THEN
    ALTER TABLE talkdesk_agent_states DISABLE TRIGGER trg_notify_status_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_status_change' AND tgrelid = to_regclass('five9_agent_states')) THEN
    ALTER TABLE five9_agent_states DISABLE TRIGGER trg_notify_status_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_status_change' AND tgrelid = to_regclass('uniters_agent_states')) THEN
    ALTER TABLE uniters_agent_states DISABLE TRIGGER trg_notify_status_change;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_kpi_change' AND tgrelid = to_regclass('wfm_kpi_snapshots')) THEN
    ALTER TABLE wfm_kpi_snapshots DISABLE TRIGGER trg_notify_kpi_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_kpi_change' AND tgrelid = to_regclass('talkdesk_lob_kpis')) THEN
    ALTER TABLE talkdesk_lob_kpis DISABLE TRIGGER trg_notify_kpi_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_kpi_change' AND tgrelid = to_regclass('five9_kpis')) THEN
    ALTER TABLE five9_kpis DISABLE TRIGGER trg_notify_kpi_change;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_kpi_change' AND tgrelid = to_regclass('uniters_kpis')) THEN
    ALTER TABLE uniters_kpis DISABLE TRIGGER trg_notify_kpi_change;
  END IF;
END $$;

-- ── To re-enable later (once REALTIME_ENABLED flips back to true, or the
-- webhook relay is ready) — mirror image, ENABLE instead of DISABLE:
--
-- ALTER TABLE wfm_agent_states      ENABLE TRIGGER trg_notify_status_change;
-- ALTER TABLE talkdesk_agent_states ENABLE TRIGGER trg_notify_status_change;
-- ALTER TABLE five9_agent_states    ENABLE TRIGGER trg_notify_status_change;
-- ALTER TABLE uniters_agent_states  ENABLE TRIGGER trg_notify_status_change;
-- ALTER TABLE wfm_kpi_snapshots     ENABLE TRIGGER trg_notify_kpi_change;
-- ALTER TABLE talkdesk_lob_kpis     ENABLE TRIGGER trg_notify_kpi_change;
-- ALTER TABLE five9_kpis            ENABLE TRIGGER trg_notify_kpi_change;
-- ALTER TABLE uniters_kpis          ENABLE TRIGGER trg_notify_kpi_change;
