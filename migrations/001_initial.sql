CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 5000),
  infill INTEGER NOT NULL CHECK(infill IN (15,20,30,50)),
  color TEXT NOT NULL CHECK(color IN ('black','white','yellow','red')),
  layer_height REAL NOT NULL CHECK(layer_height IN (0.12,0.16,0.2,0.28)),
  supports TEXT NOT NULL CHECK(supports IN ('none','operator','tree')),
  copies INTEGER NOT NULL CHECK(copies BETWEEN 1 AND 5),
  mirror INTEGER NOT NULL CHECK(mirror IN (0,1)),
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 524288000),
  upload_state TEXT NOT NULL CHECK(upload_state IN ('reserved','uploading','uploaded','ready')),
  status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK(status IN ('pending_confirmation','queued','printing','completed','canceled','failed')),
  pending_expires_at INTEGER NOT NULL,
  upload_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  queued_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_queue ON jobs(status, queued_at, id);
CREATE INDEX jobs_expiry ON jobs(status, pending_expires_at);
CREATE INDEX jobs_email ON jobs(email, status);
CREATE TABLE operators (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  operator_id INTEGER REFERENCES operators(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX job_events_job ON job_events(job_id, id);
