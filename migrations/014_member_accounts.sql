CREATE TABLE members (
  id TEXT PRIMARY KEY,
  contact_email TEXT
);
CREATE TABLE member_identities (
  provider TEXT NOT NULL CHECK(provider IN ('hive', 'purduehackers')),
  subject TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  display_name TEXT,
  verified_email TEXT,
  PRIMARY KEY(provider, subject)
);
CREATE INDEX member_identities_member ON member_identities(member_id);
CREATE TABLE member_emails (
  email TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id)
);
CREATE TABLE hive_whitelist (
  email TEXT PRIMARY KEY
);
CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  organizer INTEGER NOT NULL DEFAULT 0 CHECK(organizer IN (0, 1)),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(provider, subject) REFERENCES member_identities(provider, subject)
);
CREATE INDEX member_sessions_expiry ON member_sessions(expires_at);
CREATE TABLE member_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  member_id TEXT REFERENCES members(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX member_links_expiry ON member_links(expires_at);

ALTER TABLE jobs ADD COLUMN member_id TEXT REFERENCES members(id);
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
CREATE INDEX jobs_member ON jobs(member_id, created_at);
UPDATE jobs SET started_at = COALESCE(
  (SELECT MIN(created_at) FROM job_events WHERE job_id = jobs.id AND next_status = 'printing'),
  CASE WHEN status IN ('printing', 'completed') THEN COALESCE(queued_at, created_at) END
);
ALTER TABLE operators ADD COLUMN id_subject TEXT;
CREATE UNIQUE INDEX operators_id_subject ON operators(id_subject);

ALTER TABLE push_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'submission'
  CHECK(kind IN ('submission', 'settings', 'cancellation'));
