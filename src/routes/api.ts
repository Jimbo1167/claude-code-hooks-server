import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/database';

const MCP_AUDIT_DIR = process.env.MCP_AUDIT_DIR || path.join(process.env.DATA_DIR || './data', 'mcp-audit');

const router = Router();

router.get('/projects', (_req: Request, res: Response) => {
  const db = getDb();
  const projects = db.prepare(`
    SELECT cwd, COUNT(*) as session_count
    FROM sessions
    WHERE cwd IS NOT NULL AND cwd != ''
    GROUP BY cwd
    ORDER BY session_count DESC
  `).all() as { cwd: string; session_count: number }[];

  res.json(projects.map(p => ({
    cwd: p.cwd,
    basename: p.cwd.split('/').pop() || p.cwd,
    session_count: p.session_count,
  })));
});

router.get('/sessions', (req: Request, res: Response) => {
  const cwd = req.query.cwd as string | undefined;
  const db = getDb();

  const cwdFilter = cwd ? 'WHERE s.cwd = ?' : '';
  const params = cwd ? [cwd] : [];

  const sessions = db.prepare(`
    SELECT s.*, COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN hook_events e ON s.id = e.session_id AND e.hook_event_name IN ('PreToolUse', 'PostToolUse', 'PostToolUseFailure')
    ${cwdFilter}
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 10
  `).all(...params);

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

router.get('/stats', (req: Request, res: Response) => {
  const cwd = req.query.cwd as string | undefined;
  const db = getDb();

  const today = new Date().toISOString().split('T')[0];

  const cwdFilter = cwd ? 'AND s.cwd = ?' : '';
  const cwdJoin = cwd ? 'JOIN sessions s ON e.session_id = s.id' : '';
  const cwdJoinSessions = cwd ? 'AND cwd = ?' : '';
  const cwdParams = cwd ? [cwd] : [];

  const sessionsToday = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE date(started_at) = ? ${cwdJoinSessions}
  `).get(today, ...cwdParams) as { count: number };

  const sessionsAllTime = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE 1=1 ${cwdJoinSessions}
  `).get(...cwdParams) as { count: number };

  const toolsToday = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PreToolUse' AND date(e.timestamp) = ? ${cwdFilter}
  `).get(today, ...cwdParams) as { count: number };

  const toolsAllTime = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PreToolUse' ${cwdFilter}
  `).get(...cwdParams) as { count: number };

  const activeSessions = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE ended_at IS NULL ${cwdJoinSessions}
  `).get(...cwdParams) as { count: number };

  const topTools = db.prepare(`
    SELECT e.tool_name, COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PreToolUse' AND e.tool_name IS NOT NULL ${cwdFilter}
    GROUP BY e.tool_name
    ORDER BY count DESC
    LIMIT 3
  `).all(...cwdParams);

  const failuresToday = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name IN ('PostToolUseFailure', 'StopFailure') AND date(e.timestamp) = ? ${cwdFilter}
  `).get(today, ...cwdParams) as { count: number };

  const failuresAllTime = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name IN ('PostToolUseFailure', 'StopFailure') ${cwdFilter}
  `).get(...cwdParams) as { count: number };

  const permissionDenials = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PermissionDenied' ${cwdFilter}
  `).get(...cwdParams) as { count: number };

  const subagentsToday = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'SubagentStart' AND date(e.timestamp) = ? ${cwdFilter}
  `).get(today, ...cwdParams) as { count: number };

  res.json({
    sessions_today: sessionsToday.count,
    sessions_all_time: sessionsAllTime.count,
    tools_today: toolsToday.count,
    tools_all_time: toolsAllTime.count,
    active_sessions: activeSessions.count,
    top_tools: topTools,
    failures_today: failuresToday.count,
    failures_all_time: failuresAllTime.count,
    permission_denials: permissionDenials.count,
    subagents_today: subagentsToday.count,
  });
});

// MCP audit log endpoints
router.get('/mcp-audit/files', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(MCP_AUDIT_DIR)) {
      res.json([]);
      return;
    }
    const files = fs.readdirSync(MCP_AUDIT_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();

    res.json(files.map(f => {
      const stats = fs.statSync(path.join(MCP_AUDIT_DIR, f));
      const parts = f.replace('.jsonl', '').split('_');
      const date = parts.pop();
      const server = parts.join('_');
      return { filename: f, server, date, size_bytes: stats.size };
    }));
  } catch (e) {
    res.status(500).json({ error: 'Failed to list audit files' });
  }
});

router.get('/mcp-audit/file/:filename', (req: Request, res: Response) => {
  try {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(MCP_AUDIT_DIR, filename);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const entries = lines
      .slice(offset, offset + limit)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    res.json({ total: lines.length, offset, limit, entries });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read audit file' });
  }
});

export default router;
