-- ─────────────────────────────────────────────────────────────────────────────
-- KPI table Realtime — broadcast only on actual value changes
-- Run once in: Supabase Dashboard → SQL Editor → New Query
--
-- Same problem as the agent-status tables (see realtime_status_broadcast.sql),
-- applied to the 4 KPI tables the dashboard subscribes to: wfm_kpi_snapshots,
-- talkdesk_lob_kpis, five9_kpis, uniters_kpis. Every scraper upserts these
-- every ~30s tick regardless of whether the actual numbers changed (updated_at
-- always moves) — with several browser tabs open, each unconditional write
-- was multiplied into that many delivered Realtime messages, all day, even
-- when nothing on screen would have actually changed.
--
-- FIX: a trigger compares the OLD vs NEW row (minus id/account_id/updated_at,
-- which never carry meaningful info) and only broadcasts when something
-- actually differs. Unlike the status trigger, this one doesn't need a named
-- "value column" argument per table — these 4 tables have different shapes
-- (wfm_kpi_snapshots has many dynamic KPI columns, talkdesk_lob_kpis has
-- fixed sla/aht/etc columns, five9_kpis/uniters_kpis are single-value rows),
-- so comparing the WHOLE row generically (ignoring bookkeeping columns) works
-- uniformly across all of them without per-table configuration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_kpi_change()
RETURNS trigger
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  ignore_cols text[] := ARRAY['id', 'account_id', 'updated_at'];
  old_data    jsonb;
  new_data    jsonb;
  acct_id     text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_data := to_jsonb(OLD) - ignore_cols;
    new_data := NULL;
    acct_id  := OLD.account_id;
  ELSE
    new_data := to_jsonb(NEW) - ignore_cols;
    acct_id  := NEW.account_id;

    IF TG_OP = 'UPDATE' THEN
      old_data := to_jsonb(OLD) - ignore_cols;
      IF old_data IS NOT DISTINCT FROM new_data THEN
        RETURN NEW; -- nothing meaningful changed this tick — skip broadcast
      END IF;
    END IF;
    -- TG_OP = 'INSERT' (brand-new row) always broadcasts.
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'table',      TG_TABLE_NAME,
      'account_id', acct_id
    ),
    'kpi_change',      -- event name — matches Dashboard.tsx's .on('broadcast', { event: 'kpi_change' }, ...)
    'wfm-realtime',    -- topic — matches the dashboard's single 'wfm-realtime' channel
    false              -- public channel, same posture as the status-change trigger
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ── Triggers — one per KPI table ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_notify_kpi_change ON wfm_kpi_snapshots;
CREATE TRIGGER trg_notify_kpi_change
AFTER INSERT OR UPDATE OR DELETE ON wfm_kpi_snapshots
FOR EACH ROW EXECUTE FUNCTION notify_kpi_change();

DROP TRIGGER IF EXISTS trg_notify_kpi_change ON talkdesk_lob_kpis;
CREATE TRIGGER trg_notify_kpi_change
AFTER INSERT OR UPDATE OR DELETE ON talkdesk_lob_kpis
FOR EACH ROW EXECUTE FUNCTION notify_kpi_change();

DROP TRIGGER IF EXISTS trg_notify_kpi_change ON five9_kpis;
CREATE TRIGGER trg_notify_kpi_change
AFTER INSERT OR UPDATE OR DELETE ON five9_kpis
FOR EACH ROW EXECUTE FUNCTION notify_kpi_change();

DROP TRIGGER IF EXISTS trg_notify_kpi_change ON uniters_kpis;
CREATE TRIGGER trg_notify_kpi_change
AFTER INSERT OR UPDATE OR DELETE ON uniters_kpis
FOR EACH ROW EXECUTE FUNCTION notify_kpi_change();
