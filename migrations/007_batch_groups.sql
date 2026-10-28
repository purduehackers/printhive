-- Group batch-submitted prints automatically and persist custom operator group names.
ALTER TABLE jobs ADD COLUMN batch_id TEXT
  CHECK(batch_id IS NULL OR (typeof(batch_id) = 'text' AND length(batch_id) BETWEEN 1 AND 64));
ALTER TABLE jobs ADD COLUMN batch_title TEXT
  CHECK(batch_title IS NULL OR (typeof(batch_title) = 'text' AND length(batch_title) BETWEEN 1 AND 200));
ALTER TABLE jobs ADD COLUMN group_name TEXT
  CHECK(group_name IS NULL OR (typeof(group_name) = 'text' AND length(group_name) BETWEEN 1 AND 200));
CREATE INDEX jobs_batch ON jobs(batch_id);
CREATE INDEX jobs_group ON jobs(group_name);
