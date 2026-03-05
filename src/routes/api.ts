import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';

const router = Router();

router.get('/sessions', (_req: Request, res: Response) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT s.*, COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN hook_events e ON s.id = e.session_id AND e.hook_event_name IN ('PreToolUse', 'PostToolUse')
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 10
  `).all();

  res.json(sessions);
});

router.get('/events', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string;
  if (!sessionId) {
    res.status(400).json({ error: 'session_id query parameter required' });
    return;
  }

  const db = getDb();
  const events = db.prepare(`
    SELECT * FROM hook_events
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId);

  res.json(events);
});

export default router;
