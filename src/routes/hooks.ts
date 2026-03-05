import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { HookEvent } from '../types';

const MAX_RESPONSE_SIZE = 10 * 1024; // 10KB

function truncate(str: string | null, max: number): string | null {
  if (!str) return null;
  return str.length > max ? str.substring(0, max) + '...[truncated]' : str;
}

const router = Router();

router.post('/session-start', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[session-start] ${event.session_id}`);

  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, permission_mode, model, cwd)
    VALUES (?, ?, ?, ?)
  `).run(event.session_id, event.permission_mode || null, event.model || null, event.cwd || null);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source)
    VALUES (?, 'SessionStart', ?)
  `).run(event.session_id, event.source || null);

  res.json({});
});

router.post('/pre-tool-use', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[pre-tool-use] ${event.session_id} - ${event.tool_name}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input)
    VALUES (?, 'PreToolUse', ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null));

  res.json({});
});

router.post('/post-tool-use', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[post-tool-use] ${event.session_id} - ${event.tool_name}`);

  const db = getDb();
  ensureSession(db, event);

  const toolResponse = truncate(JSON.stringify(event.tool_response || null), MAX_RESPONSE_SIZE);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input, tool_response)
    VALUES (?, 'PostToolUse', ?, ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null), toolResponse);

  res.json({});
});

router.post('/stop', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[stop] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, decision, last_assistant_message)
    VALUES (?, 'Stop', ?, ?)
  `).run(event.session_id, event.stop_hook_reason || null, truncate(event.last_assistant_message || null, MAX_RESPONSE_SIZE));

  res.json({});
});

router.post('/session-end', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[session-end] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(event.session_id);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source)
    VALUES (?, 'SessionEnd', ?)
  `).run(event.session_id, event.source || null);

  res.json({});
});

function ensureSession(db: ReturnType<typeof getDb>, event: HookEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, permission_mode, model, cwd)
    VALUES (?, ?, ?, ?)
  `).run(event.session_id, event.permission_mode || null, event.model || null, event.cwd || null);
}

export default router;
