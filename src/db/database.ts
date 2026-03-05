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
