# Hooks Feature Updates — August 2026

Follow-up gap analysis against the Claude Code hooks reference (Claude Code
~v2.1.224), two months after `2026-06-20-hooks-feature-updates.md`. That doc's
deferred list plus newly shipped upstream events drove this change.

## Shipped in this change

1. **Eleven new hook endpoints.** All remaining documented events now have
   logging endpoints: `Setup`, `UserPromptExpansion`, `PostToolBatch`,
   `FileChanged`, `DirectoryAdded`, `InstructionsLoaded`, `WorktreeCreate`,
   `WorktreeRemove`, `Elicitation`, `ElicitationResult`, `TeammateIdle`.
   Highlights:
   - `FileChanged` returns `additionalContext` telling Claude to re-read the
     externally changed file (complements the existing cross-session edit
     warnings on UserPromptSubmit).
   - `PostToolBatch` stores a compact summary (batch index, tool count, names)
     rather than full outputs, which PostToolUse already captures per-tool.
   - `ElicitationResult` responses pass through the same secret redaction as
     tool output before being persisted.
   - `InstructionsLoaded` gives an audit trail of exactly which CLAUDE.md /
     rules files each session ran under (`load_reason` stored in `source`).

2. **`PermissionDenied` retry.** When the auto-mode classifier denies a call
   that an enabled `allow` rule matches, the server now returns
   `{ retry: true }` so the model retries instead of abandoning the call.
   The rule match is recorded in the permission audit log as usual.

3. **`defer` rule decision.** Rules can now punt (`decision: "defer"`):
   PreToolUse returns `permissionDecision: "defer"` (meaningful in `-p` mode);
   PermissionRequest treats a defer match as "no decision" and falls through
   to the normal permission flow. Validation, dashboard select, and badge
   styling updated.

4. **Session metadata capture.** `sessions.transcript_path` and
   `sessions.effort` (reasoning-effort level) are stored at SessionStart and
   refreshed on resume.

## Deliberately not implemented

- **`MessageDisplay`** — fires per streamed chunk with a 10s timeout;
  logging it would flood SQLite for no analytical value.
- **`watchPaths` response on FileChanged** — the matcher already defines the
  watch list; we have no server-side state that would want to change it
  dynamically yet.
- **Blocking behaviors** (`InstructionsLoaded` load-blocking,
  `UserPromptExpansion` blocking, worktree blocking, `Elicitation`
  `autoRespond`) — several are flagged as sparsely documented upstream; the
  server stays observe-only on these events until there's a concrete use case.

## Candidate next steps

- Dashboard views for the new events (instructions audit per session,
  worktree lifecycle, elicitation history).
- `prompt` / `agent` hook types are now a thing client-side; the server could
  publish recommended settings.json snippets per use case.
- `CLAUDE_ENV_FILE` integration notes for direnv-style setups.

## Notes

- New DB columns are added via the existing idempotent migration list.
- New events appear on the dashboard automatically (event rendering is
  generic by `hook_event_name`).
