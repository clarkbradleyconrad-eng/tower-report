-- Tower Report — Telegram bot audit log
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run)

CREATE TABLE IF NOT EXISTS tg_audit_log (
  id       BIGSERIAL   PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id  TEXT        NOT NULL,
  command  TEXT        NOT NULL,
  params   TEXT,
  outcome  TEXT,
  ok       BOOLEAN     NOT NULL DEFAULT true
);

-- Index for /audit command (last 20 rows by time)
CREATE INDEX IF NOT EXISTS tg_audit_log_ts_idx ON tg_audit_log (ts DESC);

-- Optional: keep the table from growing unbounded (Postgres cron or manual trim)
-- DELETE FROM tg_audit_log WHERE ts < now() - interval '90 days';
