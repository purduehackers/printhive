-- Track whether the status notification email for each event was delivered,
-- so operators can see failures in the history and retry them.
-- Existing events default to 'sent': delivery was not recorded before this migration.
ALTER TABLE job_events ADD COLUMN notification_status TEXT NOT NULL DEFAULT 'sent' CHECK (notification_status IN ('sent', 'failed'));
