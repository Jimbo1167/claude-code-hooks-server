CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  permission_mode TEXT,
  model TEXT,
  cwd TEXT
);

CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  hook_event_name TEXT,
  tool_name TEXT,
  tool_input TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  decision TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
