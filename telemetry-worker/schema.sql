-- Telemetry D1 schema
-- Apply with: wrangler d1 execute stalagmight-telemetry --file=schema.sql

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  duration_secs INTEGER NOT NULL,
  ip_hash TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  event_name TEXT NOT NULL,
  count INTEGER NOT NULL,
  project_seq INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_ip_hash_received ON events(ip_hash, received_at);
CREATE INDEX IF NOT EXISTS idx_sessions_received ON sessions(received_at);
CREATE INDEX IF NOT EXISTS idx_sessions_ip_hash ON sessions(ip_hash);
