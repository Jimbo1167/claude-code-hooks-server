# Investigation: Permission Management and Cross-Session State Coordination via HTTP Hooks

**Date:** 2026-03-05
**Status:** Research complete, ready for implementation planning

---

## Executive Summary

Claude Code HTTP hooks provide a bidirectional communication channel between Claude Code sessions and our hooks server. The server already receives and stores hook events. The critical next step is to **return meaningful JSON responses** from those endpoints rather than empty `{}`. This unlocks two major capabilities:

1. **Permission management** -- The server can respond to `PreToolUse` and `PermissionRequest` hooks with allow/deny/ask decisions, driven by rules stored in the database.
2. **Cross-session state coordination** -- Because all sessions POST to the same server (and share a SQLite DB), the server can inject context from one session into another via `SessionStart`, `UserPromptSubmit`, and `Stop` hook responses.

---

## Part 1: Permission Management via PreToolUse and PermissionRequest

### 1.1 How PreToolUse Permission Decisions Work

When Claude Code is about to execute a tool, it sends a POST to our `/hooks/pre-tool-use` endpoint. The server currently logs the event and returns `{}`. By returning a JSON body with `hookSpecificOutput`, the server can **allow, deny, or escalate** the tool call.

#### Response format to DENY a dangerous command

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Command 'rm -rf /' matched deny rule: destructive-commands"
  }
}
```

Effect: The tool call is blocked. Claude sees the `permissionDecisionReason` as an error message and tries a different approach.

#### Response format to ALLOW a safe command (bypass permission prompt)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Auto-approved by policy: read-only tools are always allowed"
  }
}
```

Effect: The tool executes immediately without showing a permission dialog to the user. The reason is shown to the user (not Claude) for transparency.

#### Response format to ASK (escalate to user)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "Write to system directory requires manual approval"
  }
}
```

Effect: Claude Code shows the normal permission dialog to the user. The reason appears in the dialog for context.

#### Response format to MODIFY tool input before execution

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Command sanitized: added --dry-run flag",
    "updatedInput": {
      "command": "rm -rf /tmp/build --dry-run"
    }
  }
}
```

Effect: The tool executes with the **modified** input. This is powerful for sanitization (adding flags, rewriting paths, etc.).

#### Injecting context without making a permission decision

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "WARNING: This directory contains production configs. The last session that modified it caused a deployment issue."
  }
}
```

Effect: The context is added to Claude's conversation before the tool runs. No permission decision is made (normal flow continues).

### 1.2 How PermissionRequest Decisions Work

`PermissionRequest` fires later than `PreToolUse` -- specifically when a permission dialog is **about to be shown** to the user. This is the server's chance to auto-approve or auto-deny on the user's behalf.

#### Response format to AUTO-APPROVE a permission request

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

#### Response format to AUTO-APPROVE with "always allow" rule

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        { "type": "toolAlwaysAllow", "tool": "Read" }
      ]
    }
  }
}
```

Effect: Approves this request AND tells Claude Code to always allow the `Read` tool going forward in this session (equivalent to the user clicking "Always allow").

#### Response format to DENY a permission request

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Bash commands writing to /etc are prohibited by org policy"
    }
  }
}
```

#### Response format to DENY and halt Claude

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Critical safety violation detected",
      "interrupt": true
    }
  }
}
```

Effect: Denies the permission AND stops Claude entirely.

### 1.3 Building a Policy Engine

**Concept:** Rules stored in the DB that the server evaluates on every `PreToolUse` and `PermissionRequest` event. The dashboard UI lets users create/edit/delete rules.

#### New DB table: `permission_rules`

```sql
CREATE TABLE IF NOT EXISTS permission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,       -- higher = evaluated first

  -- Matching criteria (all are optional; omit = match all)
  tool_name_pattern TEXT,            -- regex, e.g. "Bash", "Edit|Write", "mcp__.*"
  command_pattern TEXT,              -- regex applied to tool_input.command (Bash only)
  file_path_pattern TEXT,            -- regex applied to tool_input.file_path (Edit/Write/Read)
  session_cwd_pattern TEXT,          -- regex applied to session cwd

  -- Decision
  decision TEXT NOT NULL,            -- "allow", "deny", "ask"
  reason TEXT,                       -- shown to user or Claude depending on decision

  -- Optional: input modification (JSON)
  updated_input TEXT,                -- JSON object to merge into tool_input

  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  hit_count INTEGER DEFAULT 0,
  last_hit_at TIMESTAMP
);
```

#### Example rules

| name | tool_name_pattern | command_pattern | decision | reason |
|------|-------------------|-----------------|----------|--------|
| allow-read-tools | `Read\|Glob\|Grep` | (null) | allow | Read-only tools are safe |
| deny-rm-rf | `Bash` | `rm\s+(-[a-zA-Z]*f[a-zA-Z]*\|--force)` | deny | Forced deletion blocked by policy |
| deny-etc-writes | `Write\|Edit` | (null, file_path_pattern: `^/etc/`) | deny | System directory writes prohibited |
| ask-npm-install | `Bash` | `npm\s+install` | ask | Package installation requires approval |
| deny-git-force-push | `Bash` | `git\s+push.*--force` | deny | Force push blocked |

#### Server-side evaluation logic (pseudocode)

```typescript
function evaluateRules(event: HookEvent): HookResponse {
  const rules = db.prepare(`
    SELECT * FROM permission_rules
    WHERE enabled = 1
    ORDER BY priority DESC
  `).all();

  for (const rule of rules) {
    if (!matchesRule(rule, event)) continue;

    // Update hit count
    db.prepare(`
      UPDATE permission_rules
      SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(rule.id);

    // Log the decision
    db.prepare(`
      INSERT INTO permission_audit_log (rule_id, session_id, tool_name, tool_input, decision)
      VALUES (?, ?, ?, ?, ?)
    `).run(rule.id, event.session_id, event.tool_name, JSON.stringify(event.tool_input), rule.decision);

    return buildResponse(rule, event);
  }

  return {}; // no rule matched, default behavior
}
```

#### What we need to build

| Component | Description | Priority |
|-----------|-------------|----------|
| `permission_rules` table + migration | Store rules in SQLite | HIGH |
| `permission_audit_log` table | Record every rule evaluation for the audit trail | HIGH |
| Rule evaluation engine in `/hooks/pre-tool-use` | Match incoming events against rules, return decision JSON | HIGH |
| Rule evaluation engine in `/hooks/permission-request` | Same logic but using PermissionRequest response format | HIGH |
| `POST /api/rules` | Create a new rule | HIGH |
| `GET /api/rules` | List all rules | HIGH |
| `PUT /api/rules/:id` | Update a rule | HIGH |
| `DELETE /api/rules/:id` | Delete a rule | MEDIUM |
| `GET /api/rules/:id/audit-log` | View hit history for a rule | MEDIUM |
| Dashboard UI: Rules management page | Table of rules with create/edit/delete | HIGH |
| Dashboard UI: Real-time audit log | Show recent permission decisions with rule that triggered | MEDIUM |

**Priority: HIGH** -- This is the single most impactful feature. It converts the server from a passive observer to an active policy enforcement point.

### 1.4 Interactive Permission Management (Browser-Based Approve/Deny)

A more advanced scenario: when a rule says `"ask"`, instead of delegating to Claude Code's built-in dialog, the server could hold the HTTP request open (or use a webhook/polling pattern) and wait for the user to approve via the dashboard.

**How it would work:**

1. `PreToolUse` fires. Rule evaluates to "needs human review."
2. Server stores a pending approval in the DB and returns `"permissionDecision": "ask"` (or holds the request up to the timeout).
3. Dashboard shows a pending approval notification with tool details.
4. User clicks Approve or Deny in the browser.
5. The next `PermissionRequest` hook for the same tool call checks the DB and returns the user's decision.

**Limitation:** HTTP hooks have a configurable timeout (default 30s for HTTP). The server must respond within this window. For longer review cycles, the `PermissionRequest` hook (which fires when the dialog appears) is the better interception point, since the user can take their time in the dashboard instead of the terminal.

**Priority: MEDIUM** -- Valuable for team/enterprise scenarios but requires more complex state management (pending approvals, timeouts, WebSocket notifications to dashboard).

---

## Part 2: Cross-Session State Coordination

### 2.1 The Architecture

All Claude Code sessions POST to the same hooks server. The server has a shared SQLite database. This means:

- Session A's `PostToolUse` events are visible to Session B's `SessionStart` hook response.
- Session A's `Stop` hook can record findings that Session B's `SessionStart` or `UserPromptSubmit` hook injects as context.
- The server is the single source of truth for cross-session state.

### 2.2 SessionStart: Injecting Shared State into New Sessions

When a new session starts, Claude Code POSTs to `/hooks/session-start`. The server can respond with `additionalContext` that gets injected into Claude's initial context.

#### Response format

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "CROSS-SESSION CONTEXT:\n- Session abc123 (2 hours ago) discovered a bug in auth.ts:42 -- null pointer when user.email is undefined.\n- Session def456 is currently working on the payment module. Avoid conflicting changes to src/payments/.\n- Known failing test: test/integration/checkout.test.ts (flaky, tracked in issue #234)."
  }
}
```

Effect: Claude sees this context at the start of the session, giving it awareness of what other sessions have discovered or are currently doing.

#### What the server would query to build this context

```typescript
function buildSessionStartContext(event: HookEvent): string {
  const db = getDb();
  const parts: string[] = [];

  // 1. Active sessions working on the same project
  const activeSessions = db.prepare(`
    SELECT id, started_at FROM sessions
    WHERE cwd = ? AND ended_at IS NULL AND id != ?
  `).all(event.cwd, event.session_id);

  if (activeSessions.length > 0) {
    parts.push(`Active concurrent sessions on this project: ${activeSessions.length}`);
  }

  // 2. Recent discoveries/flags from other sessions
  const flags = db.prepare(`
    SELECT * FROM session_flags
    WHERE project_cwd = ? AND resolved = 0
    ORDER BY created_at DESC LIMIT 10
  `).all(event.cwd);

  for (const flag of flags) {
    parts.push(`[${flag.flag_type}] ${flag.message} (from session ${flag.session_id}, ${flag.created_at})`);
  }

  // 3. Shared knowledge base entries
  const knowledge = db.prepare(`
    SELECT * FROM shared_knowledge
    WHERE project_cwd = ? OR project_cwd IS NULL
    ORDER BY created_at DESC LIMIT 5
  `).all(event.cwd);

  for (const entry of knowledge) {
    parts.push(`[knowledge] ${entry.content}`);
  }

  return parts.length > 0
    ? "CROSS-SESSION CONTEXT:\n" + parts.map(p => `- ${p}`).join("\n")
    : "";
}
```

### 2.3 UserPromptSubmit: Enriching Prompts with Cross-Session Context

When a user submits a prompt, the server can add context from other sessions before Claude processes it.

#### Response format

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "NOTE: Another session is currently modifying src/auth/login.ts. Coordinate changes carefully."
  }
}
```

This is more targeted than SessionStart context because it fires on every prompt, allowing the server to provide **up-to-the-moment** information about what other sessions are doing right now.

#### Use case: Conflict prevention

```typescript
// When a user prompt mentions a file, check if another session is editing it
function checkForConflicts(event: HookEvent): string | null {
  const prompt = event.prompt || "";
  const db = getDb();

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
  `).all(event.cwd, event.session_id);

  if (recentEdits.length > 0) {
    const files = recentEdits.map(e => e.file_path).join(", ");
    return `WARNING: Files recently modified by other active sessions: ${files}`;
  }
  return null;
}
```

### 2.4 Stop Hook: Coordinating Session Outcomes

The `Stop` hook fires when Claude finishes responding. The server can:

1. **Record session findings** for other sessions to see.
2. **Prevent Claude from stopping** if coordination requires it (return `decision: "block"`).

#### Response format to force Claude to continue

```json
{
  "decision": "block",
  "reason": "Another session (def456) just completed changes to the same module. Please review the changes at src/auth/ and verify compatibility before finishing."
}
```

#### Response format to let Claude stop but record context

```json
{}
```

(The server just logs the stop event, extracts `last_assistant_message`, and stores interesting findings in the shared knowledge base.)

### 2.5 New DB Tables for Cross-Session State

#### `session_flags` -- Ephemeral cross-session notifications

```sql
CREATE TABLE IF NOT EXISTS session_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,           -- session that created the flag
  project_cwd TEXT,                   -- project scope (null = global)
  flag_type TEXT NOT NULL,            -- "bug", "warning", "info", "conflict", "task_claim"
  message TEXT NOT NULL,
  file_path TEXT,                     -- optional: specific file this relates to
  resolved INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by_session TEXT
);
```

#### `shared_knowledge` -- Persistent cross-session knowledge base

```sql
CREATE TABLE IF NOT EXISTS shared_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_cwd TEXT,                   -- project scope (null = global)
  category TEXT,                      -- "architecture", "gotcha", "convention", "dependency"
  content TEXT NOT NULL,
  source_session_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP                -- optional TTL
);
```

#### `task_claims` -- Prevent duplicate work across sessions

```sql
CREATE TABLE IF NOT EXISTS task_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_cwd TEXT,
  task_description TEXT NOT NULL,
  file_patterns TEXT,                 -- JSON array of file globs being worked on
  claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  released_at TIMESTAMP
);
```

### 2.6 Scenario Walkthrough: Session A Discovers a Bug

1. **Session A** is working on `src/auth/`. Claude calls `Bash "npm test"` and gets a test failure.
2. The `PostToolUse` hook fires. The server sees `tool_name: "Bash"` with a test failure in `tool_response`. The server (or a future analysis step) inserts a flag:
   ```sql
   INSERT INTO session_flags (session_id, project_cwd, flag_type, message, file_path)
   VALUES ('session-A', '/Users/.../myproject', 'bug', 'Test failure in auth module: null pointer in login.ts:42', 'src/auth/login.ts');
   ```
3. **Session B** starts on the same project. The `SessionStart` hook queries `session_flags` and returns:
   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "SessionStart",
       "additionalContext": "KNOWN ISSUES:\n- Bug: Test failure in auth module: null pointer in login.ts:42 (discovered by session-A, 10 min ago)"
     }
   }
   ```
4. Claude in Session B now knows about the bug before doing any work.

### 2.7 What We Need to Build

| Component | Description | Priority |
|-----------|-------------|----------|
| `session_flags` table | Store cross-session flags/notifications | HIGH |
| `shared_knowledge` table | Persistent knowledge base across sessions | MEDIUM |
| `task_claims` table | Prevent duplicate work | MEDIUM |
| SessionStart context builder | Query flags + knowledge + active sessions, return `additionalContext` | HIGH |
| UserPromptSubmit context enrichment | Check for file conflicts on each prompt | MEDIUM |
| Stop hook: extract and store findings | Parse `last_assistant_message` for bugs/discoveries | MEDIUM |
| `POST /api/flags` | Create a flag manually from dashboard | HIGH |
| `GET /api/flags` | List active flags for a project | HIGH |
| `PUT /api/flags/:id/resolve` | Mark a flag as resolved | HIGH |
| `POST /api/knowledge` | Add shared knowledge entry | MEDIUM |
| Dashboard UI: Active sessions + flags view | Show what each session is doing and outstanding flags | HIGH |
| PostToolUse analysis: auto-flag test failures | Detect test failures in Bash tool_response and auto-create flags | LOW |

---

## Part 3: What the Anthropic Engineer's Quote Unlocks

> "You can build a web app (even on localhost) to view CC's progress, manage its permissions, and more. Then, now that you have a server with your hooks processing logic, you can easily deploy new changes or manage state across your CCs with a DB."

### 3.1 Permission Management Dashboard (we partially have this)

**Current state:** The server logs events and displays them in a dashboard. Purely observational.

**Unlocked capability:** The server becomes an active **policy enforcement point**. The dashboard is the control plane:

- Define rules: "always allow Read", "deny rm -rf", "ask for any Write to /etc"
- View real-time audit log of permission decisions
- See which rules are firing most often (tune policies)
- Toggle rules on/off without restarting any Claude Code sessions
- Rules take effect immediately on the next hook call (no session restart needed)

### 3.2 Shared Knowledge Base Across Sessions

**What it means:** Every Claude Code session on a project starts with accumulated knowledge from all prior sessions. This is like a persistent, programmatically-managed CLAUDE.md but dynamic.

- Session A figures out "the test suite needs NODE_ENV=test" -- stored in shared_knowledge
- Session B starts and immediately knows this without rediscovering it
- Stale knowledge can expire via `expires_at` TTL
- Dashboard UI for curating the knowledge base

### 3.3 Task Coordination Between Concurrent Sessions

**What it means:** Multiple Claude Code sessions working on the same project can avoid stepping on each other:

- Session A claims "working on auth module" via task_claims
- Session B starts, sees the claim via SessionStart context, and works on something else
- If Session B's prompt mentions auth files, UserPromptSubmit warns about the conflict
- When Session A finishes (Stop hook), the claim is released

### 3.4 Audit Trail and Compliance

**What it means:** Every tool call, every permission decision, every session lifecycle event is logged in SQLite with timestamps:

- `hook_events` table already captures all tool calls
- Add `permission_audit_log` to record which rule matched and what decision was made
- Dashboard can show: "In the last 24 hours, 47 Bash commands were auto-approved, 3 were denied, 12 required manual approval"
- Export audit logs for compliance reporting

### 3.5 Deploy New Logic Without Restarting Sessions

**Key insight:** Because hooks are HTTP, the server can be updated and restarted independently of Claude Code sessions. New rules, new logic, new DB tables -- all take effect on the next hook call. No need to:
- Restart Claude Code
- Modify `.claude/settings.json`
- Re-read any configuration

The hook URL stays the same. The server behind it evolves freely.

---

## Implementation Roadmap

### Phase 1: Policy Engine (HIGH priority)

1. Add `permission_rules` and `permission_audit_log` tables
2. Build rule evaluation engine in `evaluateRules()`
3. Update `/hooks/pre-tool-use` to call `evaluateRules()` and return decision JSON
4. Add `/hooks/permission-request` endpoint with PermissionRequest-format responses
5. Add CRUD API endpoints for rules (`/api/rules`)
6. Add rules management UI to dashboard

**Estimated scope:** ~400 lines of server code, ~200 lines of UI

### Phase 2: Cross-Session Context (HIGH priority)

1. Add `session_flags` table
2. Update `/hooks/session-start` to query flags and return `additionalContext`
3. Add `/hooks/user-prompt-submit` endpoint with conflict detection
4. Add CRUD API for flags (`/api/flags`)
5. Add flags view to dashboard

**Estimated scope:** ~300 lines of server code, ~150 lines of UI

### Phase 3: Shared Knowledge + Task Claims (MEDIUM priority)

1. Add `shared_knowledge` and `task_claims` tables
2. Enrich SessionStart context with knowledge and active claims
3. Add Stop hook logic to auto-extract findings from `last_assistant_message`
4. Add knowledge management UI to dashboard
5. Add active sessions + claims view

**Estimated scope:** ~400 lines of server code, ~300 lines of UI

### Phase 4: Interactive Approvals (MEDIUM priority)

1. Add `pending_approvals` table
2. PermissionRequest hook: store pending approval, return deny (with short message)
3. Dashboard: show pending approvals with approve/deny buttons
4. WebSocket or SSE for real-time notification to dashboard
5. On next PreToolUse for same pattern, check if approval was granted

**Estimated scope:** ~500 lines of server code, ~400 lines of UI (includes WebSocket)

---

## Key Technical Notes

1. **HTTP hooks return decisions via 2xx JSON responses.** Non-2xx responses are treated as non-blocking errors and the tool proceeds normally. To block, you MUST return 200 with decision JSON.

2. **The `hookSpecificOutput` format differs between PreToolUse and PermissionRequest.** PreToolUse uses `permissionDecision` / `permissionDecisionReason`. PermissionRequest uses `decision.behavior` / `decision.message`. Do not mix these up.

3. **HTTP hook timeout default is 30 seconds.** The server must respond within this window. For the policy engine, this is more than sufficient. For interactive approvals, consider using PermissionRequest (which fires when the dialog appears and the user is already waiting).

4. **Empty response `{}` means "no opinion."** This is the safe default -- Claude Code proceeds with its normal behavior. Only return decision fields when you want to override.

5. **`updatedInput` is a merge, not a replacement.** You provide only the fields you want to change. Other fields keep their original values.

6. **All matching hooks run in parallel.** If multiple rules match, their responses are combined. Be careful with conflicting decisions -- a deny from any hook overrides allows from others.

7. **HTTP hook errors are non-blocking.** If the server is down or returns 500, Claude Code continues normally. This is a safety feature -- a broken hooks server cannot brick Claude Code.
