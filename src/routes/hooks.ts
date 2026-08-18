import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/database';
import { HookEvent } from '../types';
import { evaluateRules } from '../rules/engine';
import { redactValue, isRedactionEnabled } from '../redact';

// Derive a short, human-friendly session title from the working directory.
function deriveSessionTitle(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const base = cwd.split('/').filter(Boolean).pop();
  return base || null;
}

const MAX_RESPONSE_SIZE = 10 * 1024; // 10KB
const MCP_AUDIT_DIR = process.env.MCP_AUDIT_DIR || path.join(process.env.DATA_DIR || './data', 'mcp-audit');

function truncate(str: string | null, max: number): string | null {
  if (!str) return null;
  return str.length > max ? str.substring(0, max) + '...[truncated]' : str;
}

const router = Router();

router.post('/session-start', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[session-start] ${event.session_id}`);

  const db = getDb();
  const title = deriveSessionTitle(event.cwd);
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, permission_mode, model, cwd, title, transcript_path, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(event.session_id, event.permission_mode || null, event.model || null, event.cwd || null, title,
         event.transcript_path || null, event.effort?.level || null);

  // Resumed sessions already have a row; keep transcript path and effort current.
  db.prepare(`
    UPDATE sessions
    SET transcript_path = COALESCE(?, transcript_path), effort = COALESCE(?, effort)
    WHERE id = ?
  `).run(event.transcript_path || null, event.effort?.level || null, event.session_id);

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

  const hookSpecificOutput: Record<string, unknown> = { hookEventName: 'SessionStart' };
  if (title) hookSpecificOutput.sessionTitle = title;
  if (parts.length > 0) {
    hookSpecificOutput.additionalContext =
      'CROSS-SESSION CONTEXT:\n' + parts.map(p => `- ${p}`).join('\n');
  }

  // Only return structured output if we have something beyond the bare event name.
  if (Object.keys(hookSpecificOutput).length > 1) {
    res.json({ hookSpecificOutput });
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

  // Strip high-confidence secrets out of the tool result before it is persisted
  // or sent back to Claude. When anything is redacted we return updatedToolOutput
  // so the model only ever sees the cleaned version.
  const original = event.tool_response ?? null;
  const { value: redacted, count } = isRedactionEnabled()
    ? redactValue(original)
    : { value: original, count: 0 };

  const rawResponse = JSON.stringify(redacted ?? null);
  const toolResponse = truncate(rawResponse, MAX_RESPONSE_SIZE);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input, tool_response)
    VALUES (?, 'PostToolUse', ?, ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null), toolResponse);

  // Audit MCP tool output: save the (redacted) response to disk
  if (event.tool_name?.startsWith('mcp__')) {
    writeMcpAuditLog(event, rawResponse);
  }

  if (count > 0) {
    console.log(`[post-tool-use] redacted ${count} secret(s) from ${event.tool_name}`);
    res.json({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: redacted },
    });
    return;
  }

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

  // Evaluate rules - but convert to PermissionRequest format.
  // "defer" rules punt to the normal permission flow, so return no decision.
  const ruleResponse = evaluateRules(event);
  if (ruleResponse.hookSpecificOutput?.permissionDecision &&
      ruleResponse.hookSpecificOutput.permissionDecision !== 'defer') {
    const decision = ruleResponse.hookSpecificOutput.permissionDecision;
    const permResponse: Record<string, unknown> = {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: decision === 'ask' ? 'deny' : decision,
        message: ruleResponse.hookSpecificOutput.permissionDecisionReason,
      },
    };

    // Pass through updatedInput if provided
    if (ruleResponse.hookSpecificOutput.updatedInput) {
      permResponse.updatedInput = ruleResponse.hookSpecificOutput.updatedInput;
    }

    // Pass through updatedPermissions (e.g. setMode to acceptEdits for a session)
    if (ruleResponse.hookSpecificOutput.updatedPermissions) {
      (permResponse.decision as Record<string, unknown>).updatedPermissions =
        ruleResponse.hookSpecificOutput.updatedPermissions;
    }

    res.json({ hookSpecificOutput: permResponse });
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
  console.log(`[stop] ${event.session_id}${event.stop_hook_active ? ' (stop_hook_active)' : ''}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, decision, last_assistant_message)
    VALUES (?, 'Stop', ?, ?)
  `).run(event.session_id, event.stop_hook_reason || null, truncate(event.last_assistant_message || null, MAX_RESPONSE_SIZE));

  // Prevent infinite loop: if stop_hook_active is true, this is a re-entry
  // from a previous stop hook that returned "block". Always let it through.
  if (event.stop_hook_active) {
    res.json({});
    return;
  }

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

  const original = event.tool_response ?? null;
  const { value: redacted } = isRedactionEnabled()
    ? redactValue(original)
    : { value: original };

  const rawResponse = JSON.stringify(redacted ?? null);
  const toolResponse = truncate(rawResponse, MAX_RESPONSE_SIZE);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_name, tool_input, tool_response)
    VALUES (?, 'PostToolUseFailure', ?, ?, ?)
  `).run(event.session_id, event.tool_name || null, JSON.stringify(event.tool_input || null), toolResponse);

  // Audit MCP tool failures too
  if (event.tool_name?.startsWith('mcp__')) {
    writeMcpAuditLog(event, rawResponse);
  }

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

  // If a user rule explicitly allows this call, the denial is likely spurious —
  // tell the model it may retry instead of abandoning the tool call.
  const ruleResponse = evaluateRules(event);
  if (ruleResponse.hookSpecificOutput?.permissionDecision === 'allow') {
    console.log(`[permission-denied] allow-rule matched, suggesting retry for ${event.tool_name}`);
    res.json({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } });
    return;
  }

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

router.post('/cwd-changed', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  const newCwd = event.new_cwd || event.cwd || null;
  console.log(`[cwd-changed] ${event.session_id} -> ${newCwd}`);

  const db = getDb();
  ensureSession(db, event);

  // Keep the session's working directory current so dashboard project grouping
  // doesn't go stale when Claude cd's mid-session.
  if (newCwd) {
    db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(newCwd, event.session_id);
  }

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, message)
    VALUES (?, 'CwdChanged', ?)
  `).run(event.session_id, newCwd);

  res.json({});
});

router.post('/config-change', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[config-change] ${event.session_id} - ${event.source || 'unknown'} ${event.file_path || ''}`);

  const db = getDb();
  ensureSession(db, event);

  // source carries the config source (user_settings, project_settings, ...).
  // file_path is stashed in the message column for visibility on the dashboard.
  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'ConfigChange', ?, ?)
  `).run(event.session_id, event.source || null, event.file_path || null);

  res.json({});
});

// --- August 2026 hook endpoints ---

// Setup: fires on `claude --init` / `--maintenance` runs.
router.post('/setup', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[setup] ${event.session_id} - ${event.setup_type || event.source || 'unknown'}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source)
    VALUES (?, 'Setup', ?)
  `).run(event.session_id, event.setup_type || event.source || null);

  res.json({});
});

// UserPromptExpansion: a typed command is expanding into a prompt.
router.post('/user-prompt-expansion', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[user-prompt-expansion] ${event.session_id} - ${event.command_name || 'unknown'}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_input, message)
    VALUES (?, 'UserPromptExpansion', ?, ?)
  `).run(
    event.session_id,
    JSON.stringify({ original_prompt: truncate(event.original_prompt || null, 2048) }),
    event.command_name || null
  );

  res.json({});
});

// PostToolBatch: a parallel tool batch resolved. Log a summary only —
// individual results are already captured per-tool by PostToolUse.
router.post('/post-tool-batch', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  const toolNames = (event.tool_calls || [])
    .map(c => (c && typeof c === 'object' ? String((c as Record<string, unknown>).tool_name ?? (c as Record<string, unknown>).name ?? '?') : '?'));
  console.log(`[post-tool-batch] ${event.session_id} - ${toolNames.length} tool(s)`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, tool_input)
    VALUES (?, 'PostToolBatch', ?)
  `).run(event.session_id, JSON.stringify({
    batch_index: event.batch_index ?? null,
    tool_count: toolNames.length,
    tools: toolNames,
  }));

  res.json({});
});

// FileChanged: a watched file changed on disk. Log it and tell Claude, since
// an external edit can invalidate what it read earlier in the session.
router.post('/file-changed', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  const change = event.change_type || 'changed';
  console.log(`[file-changed] ${event.session_id} - ${change}: ${event.file_path || 'unknown'}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'FileChanged', ?, ?)
  `).run(event.session_id, change, event.file_path || null);

  if (event.file_path) {
    res.json({
      hookSpecificOutput: {
        hookEventName: 'FileChanged',
        additionalContext: `Watched file ${change} externally: ${event.file_path}. Re-read it before relying on earlier contents.`,
      },
    });
    return;
  }

  res.json({});
});

// DirectoryAdded: a working directory joined the session (/add-dir etc.).
router.post('/directory-added', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[directory-added] ${event.session_id} - ${event.directory_path || 'unknown'} (${event.add_method || 'unknown'})`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'DirectoryAdded', ?, ?)
  `).run(event.session_id, event.add_method || null, event.directory_path || null);

  res.json({});
});

// InstructionsLoaded: a CLAUDE.md / rules file entered context. Audit trail
// for exactly which instruction files each session ran under.
router.post('/instructions-loaded', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[instructions-loaded] ${event.session_id} - ${event.file_path || 'unknown'} (${event.load_reason || 'unknown'})`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'InstructionsLoaded', ?, ?)
  `).run(event.session_id, event.load_reason || null, event.file_path || null);

  res.json({});
});

router.post('/worktree-create', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[worktree-create] ${event.session_id} - ${event.worktree_path || 'unknown'}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'WorktreeCreate', ?, ?)
  `).run(event.session_id, event.source_ref || null, event.worktree_path || null);

  res.json({});
});

router.post('/worktree-remove', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[worktree-remove] ${event.session_id} - ${event.worktree_path || 'unknown'} (${event.reason || 'unknown'})`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'WorktreeRemove', ?, ?)
  `).run(event.session_id, event.reason || null, event.worktree_path || null);

  res.json({});
});

// Elicitation: an MCP server asked the user for input.
router.post('/elicitation', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[elicitation] ${event.session_id} - server:${event.mcp_server || 'unknown'}`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, message)
    VALUES (?, 'Elicitation', ?, ?)
  `).run(event.session_id, event.mcp_server || null, truncate(event.message || null, 2048));

  res.json({});
});

// ElicitationResult: the user's answer is about to go back to the MCP server.
// Redact secrets from what we persist, same as tool output.
router.post('/elicitation-result', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[elicitation-result] ${event.session_id} - server:${event.mcp_server || 'unknown'}`);

  const db = getDb();
  ensureSession(db, event);

  const { value: redacted } = isRedactionEnabled()
    ? redactValue(event.user_response ?? null)
    : { value: event.user_response ?? null };

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, source, tool_response)
    VALUES (?, 'ElicitationResult', ?, ?)
  `).run(event.session_id, event.mcp_server || null, truncate(JSON.stringify(redacted ?? null), MAX_RESPONSE_SIZE));

  res.json({});
});

// TeammateIdle: an agent-team teammate is about to go idle.
router.post('/teammate-idle', (req: Request, res: Response) => {
  const event: HookEvent = req.body;
  console.log(`[teammate-idle] ${event.session_id} - agent:${event.agent_id} (${event.idle_reason || 'unknown'})`);

  const db = getDb();
  ensureSession(db, event);

  db.prepare(`
    INSERT INTO hook_events (session_id, hook_event_name, agent_id, agent_type, message)
    VALUES (?, 'TeammateIdle', ?, ?, ?)
  `).run(event.session_id, event.agent_id || null, event.agent_type || null, event.idle_reason || null);

  res.json({});
});

function writeMcpAuditLog(event: HookEvent, rawResponse: string): void {
  try {
    fs.mkdirSync(MCP_AUDIT_DIR, { recursive: true });

    // Parse MCP tool name: mcp__<server>__<tool>
    const parts = (event.tool_name || '').split('__');
    const server = parts[1] || 'unknown';
    const tool = parts.slice(2).join('__') || 'unknown';

    const entry = {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      hook_event: event.hook_event_name,
      server,
      tool,
      tool_name: event.tool_name,
      input: event.tool_input || null,
      response: (() => { try { return JSON.parse(rawResponse); } catch { return rawResponse; } })(),
      cwd: event.cwd || null,
    };

    // One file per server per day: github_2026-04-11.jsonl
    const date = new Date().toISOString().split('T')[0];
    const filename = `${server}_${date}.jsonl`;
    fs.appendFileSync(path.join(MCP_AUDIT_DIR, filename), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[mcp-audit] Failed to write audit log:', e);
  }
}

function ensureSession(db: ReturnType<typeof getDb>, event: HookEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, permission_mode, model, cwd)
    VALUES (?, ?, ?, ?)
  `).run(event.session_id, event.permission_mode || null, event.model || null, event.cwd || null);
}

export default router;
