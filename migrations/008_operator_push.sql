CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_operator ON push_subscriptions(operator_id);
CREATE TABLE push_events (
  id TEXT PRIMARY KEY,
  print_count INTEGER NOT NULL CHECK (print_count > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE push_event_jobs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE
);
CREATE TABLE push_deliveries (
  event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  failed_at INTEGER,
  PRIMARY KEY (event_id, subscription_id)
);
CREATE INDEX push_deliveries_due ON push_deliveries(next_attempt_at) WHERE sent_at IS NULL AND failed_at IS NULL;
