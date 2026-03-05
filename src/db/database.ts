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
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  decision TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || './hooks.db';
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    console.log('Database initialized');
  }
  return db;
}
