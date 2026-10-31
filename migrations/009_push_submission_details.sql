ALTER TABLE push_events ADD COLUMN submission_title TEXT NOT NULL DEFAULT '';
ALTER TABLE push_events ADD COLUMN submitter_email TEXT NOT NULL DEFAULT '';
UPDATE push_events SET
  submission_title = COALESCE((SELECT COALESCE(NULLIF(j.batch_title, ''), j.title)
    FROM push_event_jobs ej JOIN jobs j ON j.id = ej.job_id
    WHERE ej.event_id = push_events.id ORDER BY j.created_at, j.id LIMIT 1), 'Print submission'),
  submitter_email = COALESCE((SELECT j.email
    FROM push_event_jobs ej JOIN jobs j ON j.id = ej.job_id
    WHERE ej.event_id = push_events.id ORDER BY j.created_at, j.id LIMIT 1), '');
