-- Rebuild the jobs table to support materials and dynamic colors
CREATE TEMP TABLE saved_job_events AS SELECT * FROM job_events;
DROP TABLE job_events;
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 5000),
  infill INTEGER NOT NULL CHECK(infill IN (15,20,30,50)),
  material TEXT NOT NULL DEFAULT 'PLA' CHECK(length(material) BETWEEN 1 AND 50),
  color TEXT NOT NULL CHECK(length(color) BETWEEN 1 AND 50),
  layer_height REAL NOT NULL CHECK(layer_height IN (0.12,0.16,0.2,0.28)),
  supports TEXT NOT NULL CHECK(supports IN ('none','operator','tree')),
  copies INTEGER NOT NULL CHECK(copies BETWEEN 1 AND 5),
  mirror INTEGER NOT NULL CHECK(mirror IN (0,1)),
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 524288000),
  upload_state TEXT NOT NULL CHECK(upload_state IN ('reserved','uploading','uploaded','ready')),
  status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK(status IN ('pending_confirmation','queued','printing','completed','canceled','failed','rejected')),
  pending_expires_at INTEGER NOT NULL,
  upload_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  queued_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO jobs_new (id, email, title, notes, infill, material, color, layer_height, supports, copies, mirror, original_filename, storage_key, file_size, upload_state, status, pending_expires_at, upload_expires_at, created_at, confirmed_at, queued_at, version)
SELECT id, email, title, notes, infill, 'PLA', color, layer_height, supports, copies, mirror, original_filename, storage_key, file_size, upload_state, status, pending_expires_at, upload_expires_at, created_at, confirmed_at, queued_at, version FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_queue ON jobs(status, queued_at, id);
CREATE INDEX jobs_expiry ON jobs(status, pending_expires_at);
CREATE INDEX jobs_email ON jobs(email, status);
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  operator_id INTEGER REFERENCES operators(id),
  created_at INTEGER NOT NULL,
  feedback TEXT NOT NULL DEFAULT '' CHECK(length(feedback) <= 5000)
);
CREATE INDEX job_events_job ON job_events(job_id, id);
INSERT INTO job_events (id, job_id, previous_status, next_status, operator_id, created_at, feedback)
SELECT id, job_id, previous_status, next_status, operator_id, created_at, feedback FROM saved_job_events;
DROP TABLE saved_job_events;

CREATE TABLE materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 50),
  created_at INTEGER NOT NULL
);
CREATE TABLE material_colors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 50),
  code TEXT NOT NULL DEFAULT '' CHECK(length(code) <= 50),
  created_at INTEGER NOT NULL,
  UNIQUE(material_id, name)
);
CREATE INDEX material_colors_material ON material_colors(material_id);

INSERT INTO materials (id, name, created_at) VALUES (1, 'PLA', 1700000000000);
INSERT INTO material_colors (material_id, name, code, created_at) VALUES
  (1, 'black', '#353832', 1700000000000),
  (1, 'white', '#ffffff', 1700000000000),
  (1, 'yellow', '#edc54d', 1700000000000),
  (1, 'red', '#c9493b', 1700000000000);
