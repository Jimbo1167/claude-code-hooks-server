# Dashboard Enhancements Design

**Date:** 2026-03-05

## Overview

Enhance the Claude Code hooks dashboard with stats, live indicators, expandable events, tool breakdowns, and project filtering.

## Backend Changes

### New: `GET /api/stats?cwd=<optional>`

Returns aggregated stats in one response:

```json
{
  "sessions_today": 5,
  "sessions_all_time": 42,
  "tools_today": 87,
  "tools_all_time": 1203,
  "active_sessions": 2,
  "top_tools": [
    { "tool_name": "Bash", "count": 420 },
    { "tool_name": "Edit", "count": 280 },
    { "tool_name": "Read", "count": 150 }
  ]
}
```

Optional `cwd` param filters stats to a specific project.

### New: `GET /api/projects`

Returns distinct cwd values:

```json
[
  { "cwd": "/home/user/projects/my-project", "basename": "my-project", "session_count": 5 },
  { "cwd": "/home/user/projects/another-project", "basename": "another-project", "session_count": 12 }
]
```

### Modified: `GET /api/sessions?cwd=<optional>`

Add optional `cwd` query parameter. When provided, filter sessions to matching cwd.

## Frontend Changes

### 1. Stats Bar

4-card grid row below the header:
- **Sessions Today** - today count / all-time count (secondary)
- **Tool Calls Today** - today count / all-time count
- **Active Now** - count of sessions without ended_at
- **Top Tools** - top 3 tools as mini ranked list

Updates when project filter changes.

### 2. Live Activity Pulse

CSS-only pulsing green dot on active session cards. Keyframe animation, no JS.

### 3. Live Session Duration

- Active sessions: "Running for Xm Ys" updated every second via setInterval
- Ended sessions: "Lasted Xm Ys" static, computed from started_at/ended_at
- No backend changes needed; ended_at already returned.

### 4. Expandable Tool Input + Copy

- PreToolUse/PostToolUse rows are clickable with chevron indicator
- Click toggles expanded area with pretty-printed JSON (2-space indent)
- Copy button in top-right copies raw JSON to clipboard
- No backend changes needed.

### 5. Per-Session Tool Breakdown

Horizontal segmented bar above event list when a session is selected. Each tool gets a proportional colored segment + label. Computed client-side from events already fetched.

### 6. Project Filter

Dropdown above sessions list:
- Populated from `GET /api/projects`
- Default: "All Projects"
- Shows basename, full path as tooltip
- Filters sessions list and stats bar

## Implementation Order

1. Backend: `/api/stats` and `/api/projects` endpoints, cwd filter on `/api/sessions`
2. Frontend: Stats bar (depends on /api/stats)
3. Frontend: Live pulse + duration ticker (no backend dependency)
4. Frontend: Expandable events + copy (no backend dependency)
5. Frontend: Per-session tool breakdown (no backend dependency)
6. Frontend: Project filter dropdown (depends on /api/projects, wires to sessions + stats)
