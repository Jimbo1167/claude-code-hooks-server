import { getDb } from '../db/database';
import { HookEvent, HookResponse, PermissionRule } from '../types';

function safeRegex(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function matchesRule(rule: PermissionRule, event: HookEvent): boolean {
  // Each pattern field is optional. If set, it must match. If not set, it's a wildcard.
  if (rule.tool_name_pattern) {
    if (!event.tool_name || !safeRegex(rule.tool_name_pattern, event.tool_name)) return false;
  }

  if (rule.command_pattern) {
    const command = event.tool_input?.command;
    if (!command || !safeRegex(rule.command_pattern, String(command))) return false;
  }

  if (rule.file_path_pattern) {
    const filePath = event.tool_input?.file_path;
    if (!filePath || !safeRegex(rule.file_path_pattern, String(filePath))) return false;
  }

  if (rule.session_cwd_pattern) {
    if (!event.cwd || !safeRegex(rule.session_cwd_pattern, event.cwd)) return false;
  }

  return true;
}

export function evaluateRules(event: HookEvent): HookResponse {
  const db = getDb();

  const rules = db.prepare(`
    SELECT * FROM permission_rules
    WHERE enabled = 1
    ORDER BY priority DESC
  `).all() as PermissionRule[];

  for (const rule of rules) {
    if (!matchesRule(rule, event)) continue;

    // Update hit count
    db.prepare(`
      UPDATE permission_rules
      SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(rule.id);

    // Log to audit
    db.prepare(`
      INSERT INTO permission_audit_log (rule_id, rule_name, session_id, tool_name, tool_input, decision, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(rule.id, rule.name, event.session_id, event.tool_name || null,
           JSON.stringify(event.tool_input || null), rule.decision, rule.reason || null);

    // Build response
    const response: HookResponse = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: rule.decision,
        permissionDecisionReason: rule.reason || `Matched rule: ${rule.name}`,
      },
    };

    // Add updatedInput if rule specifies it
    if (rule.updated_input && rule.decision === 'allow') {
      try {
        response.hookSpecificOutput!.updatedInput = JSON.parse(rule.updated_input);
      } catch {}
    }

    // Add updatedPermissions if rule specifies them (e.g. setMode to acceptEdits)
    if (rule.updated_permissions) {
      try {
        response.hookSpecificOutput!.updatedPermissions = JSON.parse(rule.updated_permissions);
      } catch {}
    }

    return response;
  }

  return {}; // no rule matched
}
