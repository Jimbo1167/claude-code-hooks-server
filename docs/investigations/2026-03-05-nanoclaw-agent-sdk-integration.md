# NanoClaw Agent SDK Integration with Hooks Server

**Date:** 2026-03-05

## NanoClaw Architecture Summary

NanoClaw is a personal AI assistant framework that runs Claude agents in isolated Docker containers. Key architecture:

- **Host process** (Node.js orchestrator) manages message queues, channels (Telegram), IPC, and container lifecycle
- **Containers** each run an **agent-runner** that calls `query()` from `@anthropic-ai/claude-agent-sdk`
- Communication between host and container is via stdin/stdout JSON + filesystem-based IPC
- Per-group isolated sessions with SQLite persistence on the host side

### How NanoClaw Uses the Agent SDK

The agent-runner at `container/agent-runner/src/index.ts` calls:

```typescript
for await (const message of query({
  prompt: stream,  // AsyncIterable for multi-turn
  options: {
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook()] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
    },
    mcpServers: { nanoclaw: { ... } },
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    // ...
  }
}))
```

The SDK already supports **the same hook events as Claude Code**: `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, etc. NanoClaw currently only uses `PreCompact` and `PreToolUse` (for env sanitization).

## Integration Approaches

### Approach 1: Add HTTP Hooks in NanoClaw's Agent SDK Config (Recommended)

The Claude Agent SDK `query()` accepts `hooks` in the options. These hooks use the **same format as Claude Code hooks**. We can add HTTP hooks pointing to our server.

**What to change in `container/agent-runner/src/index.ts`:**

```typescript
const HOOKS_SERVER = process.env.HOOKS_SERVER_URL || 'http://host.docker.internal:3003';

// Add to the hooks config passed to query():
hooks: {
  PreCompact: [{ hooks: [createPreCompactHook()] }],
  PreToolUse: [
    { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
    { hooks: [{ type: 'http', url: `${HOOKS_SERVER}/hooks/pre-tool-use`, timeout: 5 }] },
  ],
  PostToolUse: [
    { hooks: [{ type: 'http', url: `${HOOKS_SERVER}/hooks/post-tool-use`, timeout: 5 }] },
  ],
  SessionStart: [
    { hooks: [{ type: 'http', url: `${HOOKS_SERVER}/hooks/session-start`, timeout: 5 }] },
  ],
  Stop: [
    { hooks: [{ type: 'http', url: `${HOOKS_SERVER}/hooks/stop`, timeout: 5 }] },
  ],
  SessionEnd: [
    { hooks: [{ type: 'http', url: `${HOOKS_SERVER}/hooks/session-end`, timeout: 5 }] },
  ],
}
```

**Pros:**
- Zero changes to hooks-server — NanoClaw sends the exact same event format as Claude Code
- Dashboard immediately shows NanoClaw agent activity alongside CC sessions
- Minimal changes to NanoClaw (just add HTTP hooks to the existing hooks config)
- Uses `host.docker.internal` to reach host from container

**Cons:**
- Container needs network access to host (already the case for Telegram API)
- No way to distinguish NanoClaw sessions from CC sessions in the dashboard (yet)

**Networking note:** NanoClaw containers already have host network access. The hooks server on `localhost:3003` is reachable via `host.docker.internal:3003` from Docker containers.

### Approach 2: Instrument the Agent Runner Directly

Instead of SDK hooks, intercept the `query()` message stream and POST events ourselves.

```typescript
for await (const message of query({ prompt: stream, options })) {
  // Intercept lifecycle events
  if (message.type === 'system' && message.subtype === 'init') {
    fetch(`${HOOKS_SERVER}/hooks/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: message.session_id,
        hook_event_name: 'SessionStart',
        model: message.model,
        cwd: '/workspace/group',
        source: 'nanoclaw',
        // NanoClaw-specific metadata
        group_folder: containerInput.groupFolder,
        channel: containerInput.channel,
      }),
    }).catch(() => {});
  }
  // ... handle other message types
}
```

**Pros:**
- Full control over what data is sent
- Can add NanoClaw-specific metadata (group name, channel, trigger message)
- Can send events even if SDK hook format changes

**Cons:**
- More code to maintain
- Duplicates hook logic the SDK already provides
- Need to handle all message types manually

### Approach 3: Host-Level Instrumentation

Instrument `container-runner.ts` on the host side to send events when containers start/stop.

**Pros:** No container changes needed
**Cons:** Can't see tool-level events (only container lifecycle)

## Recommended Approach

**Use Approach 1 (SDK HTTP hooks) + a small addition for NanoClaw metadata.**

The key insight: the Agent SDK hooks send the **exact same JSON format** as Claude Code hooks. Our server already handles it. The only gap is distinguishing NanoClaw sessions from CC sessions.

### Distinguishing NanoClaw vs Claude Code Sessions

Add a `source` column to the `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code';
```

NanoClaw can pass extra context via environment variables that the SDK includes:

```typescript
env: {
  ...sdkEnv,
  NANOCLAW_GROUP: containerInput.groupFolder,
  NANOCLAW_CHANNEL: containerInput.channel || 'unknown',
}
```

Then add a new hook endpoint or extend `session-start` to accept a `source` field. Alternatively, we can identify NanoClaw sessions by their `cwd` (always `/workspace/group`).

### Dashboard Changes

Add a source filter (alongside the project filter) to toggle between:
- All activity
- Claude Code sessions only
- NanoClaw agents only

Show NanoClaw-specific info when available:
- Group/channel name instead of cwd
- Container lifecycle info

## Implementation Plan

### Phase 1: Basic Integration (minimal changes)

1. **NanoClaw:** Add HTTP hooks to the `query()` options in `agent-runner/src/index.ts`
2. **NanoClaw:** Pass `HOOKS_SERVER_URL` as env var to containers
3. **Hooks server:** Add `source` column to sessions table (detect by cwd pattern `/workspace/`)
4. **Dashboard:** Add source badge to session cards

### Phase 2: Rich Metadata

1. **Hooks server:** New endpoint `POST /hooks/nanoclaw/session-start` that accepts group/channel metadata
2. **NanoClaw:** Send enriched session-start with group/channel info
3. **Dashboard:** Show group name, channel icon for NanoClaw sessions

### Phase 3: Cross-Platform Coordination

1. Use the shared DB to coordinate between CC and NanoClaw agents
2. NanoClaw agents could query hooks-server for recent CC activity on the same project
3. CC sessions could see what NanoClaw agents are doing

## Effort Estimate

- Phase 1: ~30 minutes (add hooks config + source detection)
- Phase 2: ~1-2 hours (new endpoints + dashboard UI)
- Phase 3: Depends on scope of coordination features
