import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';

const router = Router();

// List flags (default: unresolved)
router.get('/flags', (req: Request, res: Response) => {
  const cwd = req.query.cwd as string | undefined;
  const resolved = req.query.resolved === '1' ? 1 : 0;

  const db = getDb();
  let query = 'SELECT * FROM session_flags WHERE resolved = ?';
  const params: (string | number)[] = [resolved];

  if (cwd) {
    query += ' AND (project_cwd = ? OR project_cwd IS NULL)';
    params.push(cwd);
  }

  query += ' ORDER BY created_at DESC LIMIT 50';

  const flags = db.prepare(query).all(...params);
  res.json(flags);
});

// Create a flag
router.post('/flags', (req: Request, res: Response) => {
  const { session_id, project_cwd, flag_type, message, file_path } = req.body;

  if (!flag_type || !message) {
    res.status(400).json({ error: 'flag_type and message are required' });
    return;
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO session_flags (session_id, project_cwd, flag_type, message, file_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(session_id || 'manual', project_cwd || null, flag_type, message, file_path || null);

  const flag = db.prepare('SELECT * FROM session_flags WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(flag);
});

// Resolve a flag
router.put('/flags/:id/resolve', (req: Request, res: Response) => {
  const { id } = req.params;
  const { resolved_by_session } = req.body || {};

  const db = getDb();
  const result = db.prepare(`
    UPDATE session_flags
    SET resolved = 1, resolved_at = CURRENT_TIMESTAMP, resolved_by_session = ?
    WHERE id = ?
  `).run(resolved_by_session || null, id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Flag not found' });
    return;
  }

  const flag = db.prepare('SELECT * FROM session_flags WHERE id = ?').get(id);
  res.json(flag);
});

// Delete a flag
router.delete('/flags/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();
  const result = db.prepare('DELETE FROM session_flags WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Flag not found' });
    return;
  }
  res.json({ deleted: true });
});

export default router;
