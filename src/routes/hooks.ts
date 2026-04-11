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

  // Log to hook_event_log for suggestion aggregation
  // Only permission-request events matter — these are the friction points
  // where the user is being asked to approve something manually
  db.prepare(`
    INSERT INTO hook_event_log (tool_name, command, file_path, session_id, session_cwd)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    event.tool_name || null,
    event.tool_input?.command ? String(event.tool_input.command) : null,
    event.tool_input?.file_path ? String(event.tool_input.file_path) : null,
    event.session_id,
    event.cwd || null
  );

  // Prune old event log entries (7-day retention)
  db.prepare(`DELETE FROM hook_event_log WHERE timestamp < datetime('now', '-7 days')`).run();

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

// --- New hook endpoints ---

router.post('/notification', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[notification] ${event.session_id} - ${event.title || event.message || 'no message'}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, message, source)
    VALUES (?, 'Notification', ?, ?)
  `).run(event.session_id, event.message || event.title || null, event.source || null);

  res.json({});
});

router.post('/post-tool-use-failure', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[post-tool-use-failure] ${event.session_id} - ${event.tool_name}`);

  const db = getDb();
  ensureSession(db, event);

  const toolResponse = truncate(JSON.stringify(event.tool_response || null), MAX_RESPONSE_SIZE);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input, tool_response)
    VALUES (?, 'PostToolUseFailure', ?, ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null), toolResponse);

  res.json({});
});

router.post('/stop-failure', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[stop-failure] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, message, last_assistant_message)
    VALUES (?, 'StopFailure', ?, ?)
  `).run(event.session_id, event.message || null, truncate(event.last_assistant_message || null, MAX_RESPONSE_SIZE));

  res.json({});
});

router.post('/permission-denied', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[permission-denied] ${event.session_id} - ${event.tool_name}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input)
    VALUES (?, 'PermissionDenied', ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null));

  // Log to audit as a system denial (no rule_id since it came from Claude's classifier)
  db.prepare(`
    INSERT INTO permission_audit_log (rule_id, rule_name, session_id, tool_name, tool_input, decision, reason)
    VALUES (NULL, '[auto-mode classifier]', ?, ?, ?, 'deny', 'Denied by Claude auto-mode classifier')
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null));

  res.json({});
});

router.post('/subagent-start', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[subagent-start] ${event.session_id} - agent:${event.agent_id} type:${event.agent_type}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, agent_id, agent_type, message)
    VALUES (?, 'SubagentStart', ?, ?, ?)
  `).run(event.session_id, event.agent_id || null, event.agent_type || null, event.agent_transcript_path || null);

  res.json({});
});

router.post('/subagent-stop', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[subagent-stop] ${event.session_id} - agent:${event.agent_id} type:${event.agent_type}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, agent_id, agent_type, message)
    VALUES (?, 'SubagentStop', ?, ?, ?)
  `).run(event.session_id, event.agent_id || null, event.agent_type || null, event.agent_transcript_path || null);

  res.json({});
});

router.post('/pre-compact', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[pre-compact] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name)
    VALUES (?, 'PreCompact')
  `).run(event.session_id);

  res.json({});
});

router.post('/post-compact', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[post-compact] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name)
    VALUES (?, 'PostCompact')
  `).run(event.session_id);

  // Re-inject cross-session context after compaction, same as SessionStart
  const parts: string[] = [];
  const cwd = event.cwd;

  if (cwd) {
    const activeSessions = db.prepare(`
      SELECT id FROM sessions
      WHERE cwd = ? AND ended_at IS NULL AND id != ?
    `).all(cwd, event.session_id) as { id: string }[];

    if (activeSessions.length > 0) {
      parts.push(`${activeSessions.length} other active session(s) on this project`);
    }

    const flags = db.prepare(`
      SELECT flag_type, message, file_path, created_at FROM session_flags
      WHERE (project_cwd = ? OR project_cwd IS NULL) AND resolved = 0
      ORDER BY created_at DESC LIMIT 10
    `).all(cwd) as { flag_type: string; message: string; file_path: string | null; created_at: string }[];

    for (const flag of flags) {
      const filePart = flag.file_path ? ` (${flag.file_path})` : '';
      parts.push(`[${flag.flag_type}] ${flag.message}${filePart}`);
    }
  }

  if (parts.length > 0) {
    res.json({
      hookSpecificOutput: {
        hookEventName: 'PostCompact',
        additionalContext: 'CROSS-SESSION CONTEXT (re-injected after compaction):\n' + parts.map(p => `- ${p}`).join('\n'),
      },
    });
  } else {
    res.json({});
  }
});

router.post('/task-created', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[task-created] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_input)
    VALUES (?, 'TaskCreated', ?)
  `).run(event.session_id, JSON.stringify(event.tool_input || null));

  res.json({});
});

router.post('/task-completed', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[task-completed] ${event.session_id}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_input)
    VALUES (?, 'TaskCompleted', ?)
  `).run(event.session_id, JSON.stringify(event.tool_input || null));

  res.json({});
});

function ensureSession(db: ReturnType<typeof getDb>, event: HookEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, permission_mode, model, cwd)
    VALUES (?, ?, ?, ?)
  `).run(event.session_id, event.permission_mode || null, event.model || null, event.cwd || null);
}

export default router;
