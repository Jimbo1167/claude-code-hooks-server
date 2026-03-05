import Database from 'better-sqlite3';

let db: Database.Database;

const SCHEMA = `
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
  tool_response TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  decision TEXT,
  source TEXT,
  last_assistant_message TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS permission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  tool_name_pattern TEXT,
  command_pattern TEXT,
  file_path_pattern TEXT,
  session_cwd_pattern TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  updated_input TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  hit_count INTEGER DEFAULT 0,
  last_hit_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permission_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER,
  rule_name TEXT,
  session_id TEXT,
  tool_name TEXT,
  tool_input TEXT,
  decision TEXT,
  reason TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rule_id) REFERENCES permission_rules(id)
);

CREATE TABLE IF NOT EXISTS session_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_cwd TEXT,
  flag_type TEXT NOT NULL,
  message TEXT NOT NULL,
  file_path TEXT,
  resolved INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by_session TEXT
);

CREATE TABLE IF NOT EXISTS hook_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  command TEXT,
  file_path TEXT,
  session_id TEXT,
  session_cwd TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dismissed_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_key TEXT UNIQUE NOT NULL,
  dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  hit_count_at_dismissal INTEGER
);
`;

const MIGRATIONS = [
  `ALTER TABLE hook_events ADD COLUMN tool_response TEXT`,
  `ALTER TABLE hook_events ADD COLUMN source TEXT`,
  `ALTER TABLE hook_events ADD COLUMN last_assistant_message TEXT`,
];

function runMigrations(db: Database.Database): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (!msg.includes('duplicate column')) throw e;
    }
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || './hooks.db';
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    runMigrations(db);
    console.log('Database initialized');
  }
  return db;
}
