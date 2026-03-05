import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { HookEvent } from '../types';
import { evaluateRules } from '../rules/engine';

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

  // Build cross-session context
  const parts: string[] = [];

  // Active sessions on same project
  if (event.cwd) {
    const activeSessions = db.prepare(`
      SELECT id FROM sessions
      WHERE cwd = ? AND ended_at IS NULL AND id != ?
    `).all(event.cwd, event.session_id) as { id: string }[];

    if (activeSessions.length > 0) {
      parts.push(`${activeSessions.length} other active session(s) on this project`);
    }

    // Unresolved flags for this project
    const flags = db.prepare(`
      SELECT flag_type, message, file_path, created_at FROM session_flags
      WHERE (project_cwd = ? OR project_cwd IS NULL) AND resolved = 0
      ORDER BY created_at DESC LIMIT 10
    `).all(event.cwd) as { flag_type: string; message: string; file_path: string | null; created_at: string }[];

    for (const flag of flags) {
      const filePart = flag.file_path ? ` (${flag.file_path})` : '';
      parts.push(`[${flag.flag_type}] ${flag.message}${filePart}`);
    }
  }

  if (parts.length > 0) {
    res.json({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'CROSS-SESSION CONTEXT:\n' + parts.map(p => `- ${p}`).join('\n'),
      },
    });
  } else {
    res.json({});
  }
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

  const ruleResponse = evaluateRules(event);
  res.json(ruleResponse);
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

router.post('/permission-request', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[permission-request] ${event.session_id} - ${event.tool_name}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input)
    VALUES (?, 'PermissionRequest', ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null));

  // Evaluate rules - but convert to PermissionRequest format
  const ruleResponse = evaluateRules(event);
  if (ruleResponse.hookSpecificOutput?.permissionDecision) {
    const decision = ruleResponse.hookSpecificOutput.permissionDecision;
    res.json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: decision === 'ask' ? 'deny' : decision,
          message: ruleResponse.hookSpecificOutput.permissionDecisionReason,
        },
      },
    });
    return;
  }

  res.json({});
});

router.post('/user-prompt-submit', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[user-prompt-submit] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  // Check for active flags on this project
  const sessionRow = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(event.session_id) as { cwd: string | null } | undefined;
  const cwd = sessionRow?.cwd || event.cwd;

  if (!cwd) {
    res.json({});
    return;
  }

  // Find files recently modified by other active sessions
  const recentEdits = db.prepare(`
    SELECT DISTINCT json_extract(e.tool_input, '$.file_path') as file_path, e.session_id
    FROM hook_events e
    JOIN sessions s ON e.session_id = s.id
    WHERE e.hook_event_name = 'PostToolUse'
      AND e.tool_name IN ('Write', 'Edit')
      AND s.cwd = ?
      AND s.ended_at IS NULL
      AND e.session_id != ?
      AND e.timestamp > datetime('now', '-30 minutes')
  `).all(cwd, event.session_id) as { file_path: string; session_id: string }[];

  if (recentEdits.length > 0) {
    const files = recentEdits.map(e => e.file_path).filter(Boolean).join(', ');
    if (files) {
      res.json({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `WARNING: Files recently modified by other active sessions on this project: ${files}`,
        },
      });
      return;
    }
  }

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
