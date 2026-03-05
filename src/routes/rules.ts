import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { generateSuggestions, dismissSuggestion } from '../rules/suggestions';

const router = Router();

// List all rules
router.get('/rules', (_req: Request, res: Response) => {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM permission_rules ORDER BY priority DESC').all();
  res.json(rules);
});

// Recent audit log (all rules) - must be before :id routes
router.get('/rules/audit-log', (_req: Request, res: Response) => {
  const db = getDb();
  const entries = db.prepare(`
    SELECT * FROM permission_audit_log
    ORDER BY timestamp DESC
    LIMIT 50
  `).all();
  res.json(entries);
});

// Get rule suggestions
router.get('/rules/suggestions', (_req: Request, res: Response) => {
  const suggestions = generateSuggestions();
  res.json(suggestions);
});

// Dismiss a suggestion
router.post('/rules/suggestions/:key/dismiss', (req: Request, res: Response) => {
  const { key } = req.params;
  const { hit_count } = req.body;
  dismissSuggestion(decodeURIComponent(key), hit_count || 0);
  res.json({ dismissed: true });
});

// Create a rule
router.post('/rules', (req: Request, res: Response) => {
  const { name, description, enabled, priority, tool_name_pattern, command_pattern,
          file_path_pattern, session_cwd_pattern, decision, reason, updated_input } = req.body;

  if (!name || !decision) {
    res.status(400).json({ error: 'name and decision are required' });
    return;
  }
  if (!['allow', 'deny', 'ask'].includes(decision)) {
    res.status(400).json({ error: 'decision must be allow, deny, or ask' });
    return;
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO permission_rules (name, description, enabled, priority, tool_name_pattern,
      command_pattern, file_path_pattern, session_cwd_pattern, decision, reason, updated_input)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, description || null, enabled ?? 1, priority ?? 0,
    tool_name_pattern || null, command_pattern || null,
    file_path_pattern || null, session_cwd_pattern || null,
    decision, reason || null, updated_input || null
  );

  const rule = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rule);
});

// Update a rule
router.put('/rules/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, enabled, priority, tool_name_pattern, command_pattern,
          file_path_pattern, session_cwd_pattern, decision, reason, updated_input } = req.body;

  if (decision && !['allow', 'deny', 'ask'].includes(decision)) {
    res.status(400).json({ error: 'decision must be allow, deny, or ask' });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  db.prepare(`
    UPDATE permission_rules SET
      name = COALESCE(?, name),
      description = ?,
      enabled = COALESCE(?, enabled),
      priority = COALESCE(?, priority),
      tool_name_pattern = ?,
      command_pattern = ?,
      file_path_pattern = ?,
      session_cwd_pattern = ?,
      decision = COALESCE(?, decision),
      reason = ?,
      updated_input = ?
    WHERE id = ?
  `).run(
    name || null, description ?? null, enabled ?? null, priority ?? null,
    tool_name_pattern ?? null, command_pattern ?? null,
    file_path_pattern ?? null, session_cwd_pattern ?? null,
    decision || null, reason ?? null, updated_input ?? null, id
  );

  const updated = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(id);
  res.json(updated);
});

// Delete a rule
router.delete('/rules/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();
  const result = db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ deleted: true });
});

// Audit log for a specific rule
router.get('/rules/:id/audit-log', (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();
  const entries = db.prepare(`
    SELECT * FROM permission_audit_log
    WHERE rule_id = ?
    ORDER BY timestamp DESC
    LIMIT 50
  `).all(id);
  res.json(entries);
});

export default router;
