# Hooks Feature Updates — June 2026

Gap analysis against the current Claude Code hooks reference
(`code.claude.com/docs/en/hooks`, ~30 events) and the features added in
response. The server previously handled 17 events but exploited few of the
newer response capabilities.

## Shipped in this change

1. **Secret redaction via `updatedToolOutput` (PostToolUse / PostToolUseFailure).**
   Tool output is scanned for high-confidence secret formats before it is
   persisted or returned. Matches are replaced with `[REDACTED:<type>]` and the
   cleaned value is returned as `updatedToolOutput`, so Claude, the SQLite log,
   and the MCP audit files never see the secret. Toggle with `REDACT_TOOL_OUTPUT`.
   Implementation: `src/redact.ts`.

2. **`sessionTitle` on SessionStart.** Sessions are titled with the project
   (cwd basename), stored in `sessions.title`, returned to Claude (names the
   session in its native UI), and shown on the dashboard.

3. **`CwdChanged` endpoint (`/hooks/cwd-changed`).** Updates `sessions.cwd` when
   Claude changes directory mid-session, fixing stale dashboard project grouping.

4. **`ConfigChange` endpoint (`/hooks/config-change`).** Logs settings/skills
   changes (source + file path) for the audit trail.

5. **Optional bearer-token auth on `/hooks/*`.** Enabled by setting
   `HOOK_AUTH_TOKEN`; backwards compatible when unset. Relevant because the
   runtime server is reachable over Tailscale.

6. **README refresh.** Documents every hook endpoint (was 5 of 17), the new
   config knobs, auth header / async / `if`-filter client tips, and redaction.

## Deferred (candidate next steps)

- **`watchPaths` + `FileChanged`** — register files at SessionStart to receive
  external-edit events; complements the existing cross-session file warnings.
- **`PostToolBatch`, `InstructionsLoaded`** — additional observability events.
- **`permissionDecision: "defer"`** — let a non-matching rule punt instead of
  forcing allow/deny/ask.
- **`PermissionDenied` `retry: true`** — currently denials are logged only.
- **Capture `effort` / `transcript_path`** input fields in the DB/dashboard.
- Lower priority: `Setup`, `UserPromptExpansion`, `WorktreeCreate/Remove`,
  `Elicitation`/`ElicitationResult`, `TeammateIdle`, `MessageDisplay`.

## Notes

- Redaction patterns are deliberately conservative (known token shapes only) to
  avoid false positives; tune in `src/redact.ts`.
- New DB column `sessions.title` is added via the existing migration list.
