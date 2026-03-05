# Suggested Permission Rules — Design Doc

**Date:** 2026-03-05
**Goal:** Surface dynamic rule suggestions in the dashboard based on actual tool usage, so users can add common permission rules with one click instead of manually creating each one.

## Overview

Analyze hook event traffic to identify frequently-used tool+pattern combinations that don't yet have a covering permission rule. Present these as suggestions in the dashboard UI with "Add Rule" and "Dismiss" actions.

## Data Layer

### New Table: `hook_event_log`

Captures every `/hooks/pre-tool-use` call for aggregation.

| Column      | Type      | Notes                              |
|-------------|-----------|------------------------------------|
| id          | INTEGER   | PRIMARY KEY AUTOINCREMENT          |
| tool_name   | TEXT      | NOT NULL, e.g. "Bash", "Read"      |
| command     | TEXT      | Extracted from tool_input.command   |
| file_path   | TEXT      | Extracted from tool_input.file_path |
| session_id  | TEXT      |                                    |
| session_cwd | TEXT      |                                    |
| timestamp   | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP          |

- Populated on every `/hooks/pre-tool-use` call, before rule evaluation.
- Key fields extracted and normalized (not raw JSON) for fast aggregation.
- **Retention:** Auto-prune entries older than 7 days.

### New Table: `dismissed_suggestions`

Tracks dismissed suggestions with resurface logic.

| Column                 | Type      | Notes                                    |
|------------------------|-----------|------------------------------------------|
| id                     | INTEGER   | PRIMARY KEY AUTOINCREMENT                |
| suggestion_key         | TEXT      | UNIQUE NOT NULL, e.g. "Bash:bun test"    |
| dismissed_at           | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP                |
| hit_count_at_dismissal | INTEGER   | Count when dismissed; resurface at 2x    |

- **Resurface threshold:** If current hit count reaches 2x `hit_count_at_dismissal`, the suggestion reappears.
- **Cleanup:** Dismissed entries older than 30 days are pruned.

## Suggestion Generation Logic

**Endpoint:** `GET /api/rules/suggestions`

1. Query `hook_event_log` for the last 7 days, grouped by `tool_name` + normalized pattern:
   - **Bash:** Group by command (e.g., `bun test`, `npm run build`)
   - **Read/Write/Edit:** Group by directory prefix from `file_path`
   - **Other tools:** Group by `tool_name` alone
2. Filter out groups already covered by an existing `permission_rules` entry (pattern match check).
3. Filter out dismissed suggestions — unless current hit count >= 2x count at dismissal.
4. Return top 10 suggestions sorted by frequency.

### Suggestion Shape

```json
{
  "key": "Bash:bun test",
  "description": "Allow 'bun test' in Bash (seen 23 times)",
  "hit_count": 23,
  "proposed_rule": {
    "name": "Allow bun test",
    "tool_name_pattern": "^Bash$",
    "command_pattern": "^bun test",
    "decision": "allow",
    "reason": "Auto-suggested from usage patterns"
  }
}
```

The `proposed_rule` object matches the existing rule schema — "Add Rule" is just `POST /api/rules` with that payload.

## API Endpoints

| Method | Path                                  | Description              |
|--------|---------------------------------------|--------------------------|
| GET    | `/api/rules/suggestions`              | Get current suggestions  |
| POST   | `/api/rules/suggestions/:key/dismiss` | Dismiss a suggestion     |

## Dashboard UI

- **"Suggested Rules" section** appears above the existing rules table, only when suggestions exist.
- Header: "Suggested Rules" with a count badge.
- Each suggestion is a card/row showing:
  - Description text (e.g., "Allow `bun test` in Bash — seen 23 times")
  - Decision badge (green "allow")
  - **"Add Rule"** button — `POST /api/rules` with `proposed_rule`, removes from list
  - **"Dismiss"** button (subtle/secondary) — `POST /api/rules/suggestions/:key/dismiss`
- Section hidden entirely when no suggestions exist.
- Suggestions reload on Rules tab switch and after add/dismiss actions.

## Retention & Performance

- **Event log:** 7-day retention, pruned on insert.
- **Suggestion generation:** On-demand per API call, no caching. Aggregation over 7 days is trivially fast on SQLite.
- **Max suggestions:** 10 returned per call.
- **Dismissed suggestions:** Pruned after 30 days.
