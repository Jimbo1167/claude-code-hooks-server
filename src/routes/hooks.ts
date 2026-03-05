import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { HookEvent } from '../types';

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
    INSERT INTO hook_events (session_id, hook_event_name)
    VALUES (?, 'SessionStart')
  `).run(event.session_id);

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

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input)
    VALUES (?, 'PostToolUse', ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null));

  res.json({});
});

router.post('/stop', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[stop] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, decision)
    VALUES (?, 'Stop', ?)
  `).run(event.session_id, event.stop_hook_reason || null);

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
    INSERT INTO hook_events (session_id, hook_event_name)
    VALUES (?, 'SessionEnd')
  `).run(event.session_id);

  res.json({});
});

function ensureSession(db: ReturnType<typeof getDb>, event: HookEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, permission_mode, model, cwd)
    VALUES (?, ?, ?, ?)
  `).run(event.session_id, event.permission_mode || null, event.model || null, event.cwd || null);
}

export default router;
