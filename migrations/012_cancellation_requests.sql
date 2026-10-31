CREATE TABLE cancellation_requests (
  id TEXT PRIMARY KEY,
  items TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX cancellation_requests_expiry ON cancellation_requests(expires_at);
