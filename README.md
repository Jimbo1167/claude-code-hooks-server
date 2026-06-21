# Claude Code Hooks Server

HTTP hooks server that receives and logs Claude Code session events to a SQLite database with a web dashboard.

## Setup

```bash
cd hooks-server
npm install
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The server runs on `http://localhost:3003` by default.

## Configuration

Create a `.env` file (or edit the existing one):

```
PORT=3003
DB_PATH=./hooks.db
DATA_DIR=./data                 # MCP audit logs live under <DATA_DIR>/mcp-audit
REDACT_TOOL_OUTPUT=true         # strip secrets from tool output (default on)
HOOK_AUTH_TOKEN=                # if set, /hooks/* requires Bearer <token>
```

### Secret redaction

By default the server scans tool output for high-confidence secret formats
(GitHub/AWS/OpenAI/Anthropic/Stripe/Slack/Google keys, JWTs, bearer tokens,
private keys) before anything is stored or returned. When a `PostToolUse`
response contains a match, the server returns `updatedToolOutput` with the
secret replaced by `[REDACTED:<type>]`, so the cleaned version is what Claude,
the SQLite log, and the MCP audit files all see. Set `REDACT_TOOL_OUTPUT=false`
to disable.

### Authenticating the hook transport

If `HOOK_AUTH_TOKEN` is set, every `/hooks/*` request must include
`Authorization: Bearer <token>`. Configure the matching header on the client
side (see the HTTP hook example below). Leave it unset for an open server
(backwards compatible).

## Configure Claude Code Hooks

Each hook event maps to one endpoint (see the table below). Add the events you
care about to your `~/.claude/settings.json`. A minimal example:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "http", "url": "http://localhost:3003/hooks/session-start" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "http", "url": "http://localhost:3003/hooks/pre-tool-use" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "http", "url": "http://localhost:3003/hooks/post-tool-use" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "http", "url": "http://localhost:3003/hooks/stop" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "http", "url": "http://localhost:3003/hooks/session-end" }] }
    ]
  }
}
```

### Tips for richer configs

- **Auth header** — when the server runs with `HOOK_AUTH_TOKEN`, send a matching
  bearer token. Only env vars listed in `allowedEnvVars` are interpolated:
  ```json
  {
    "type": "http",
    "url": "http://host:3003/hooks/post-tool-use",
    "headers": { "Authorization": "Bearer $HOOKS_TOKEN" },
    "allowedEnvVars": ["HOOKS_TOKEN"]
  }
  ```
- **Async logging** — for fire-and-forget logging events (`PostToolUse`,
  `Notification`, `SessionEnd`, `CwdChanged`, `ConfigChange`) add `"async": true`
  so Claude doesn't block on the round-trip. Don't use it for `PreToolUse` /
  `PermissionRequest`, which need the response to gate the tool call.
- **Argument filters** — narrow noisy events with `if`, e.g.
  `"if": "Bash(git *)"` or `"if": "Edit(*.ts)"`.

## API Endpoints

### Hook endpoints

| Hook event | Path | Notes |
|------------|------|-------|
| SessionStart | `/hooks/session-start` | Injects cross-session context; returns `sessionTitle` |
| UserPromptSubmit | `/hooks/user-prompt-submit` | Warns about files edited by other active sessions |
| PreToolUse | `/hooks/pre-tool-use` | Evaluates permission rules (allow/deny/ask) |
| PermissionRequest | `/hooks/permission-request` | Rule-based auto allow/deny; feeds rule suggestions |
| PermissionDenied | `/hooks/permission-denied` | Logs auto-mode classifier denials |
| PostToolUse | `/hooks/post-tool-use` | Logs result; redacts secrets via `updatedToolOutput` |
| PostToolUseFailure | `/hooks/post-tool-use-failure` | Logs (redacted) failed tool output |
| Stop / StopFailure | `/hooks/stop`, `/hooks/stop-failure` | Logs turn end / API-error end |
| SubagentStart / SubagentStop | `/hooks/subagent-start`, `/hooks/subagent-stop` | Tracks subagents |
| PreCompact / PostCompact | `/hooks/pre-compact`, `/hooks/post-compact` | PostCompact re-injects cross-session context |
| TaskCreated / TaskCompleted | `/hooks/task-created`, `/hooks/task-completed` | Tracks tasks |
| CwdChanged | `/hooks/cwd-changed` | Updates the session's working directory |
| ConfigChange | `/hooks/config-change` | Logs settings/skills changes |
| Notification | `/hooks/notification` | Logs notifications |
| SessionEnd | `/hooks/session-end` | Marks the session ended |

### Dashboard / data API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | Recent sessions (last 10) |
| GET | `/api/events?session_id=<id>` | Events for a session |
| GET | `/api/stats` | Aggregate stats |
| GET | `/api/projects` | Projects (grouped by cwd) |
| GET | `/api/mcp-audit/files` | List MCP audit log files |
| GET | `/api/mcp-audit/file/:filename` | Read an MCP audit log file |
| GET | `/` | Dashboard |

## Dashboard

Open `http://localhost:3003` in your browser to see the dashboard with session history and tool call details.
