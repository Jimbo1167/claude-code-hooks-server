# Suggested Permission Rules — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface dynamic rule suggestions in the dashboard based on actual hook event usage, with one-click "Add Rule" and "Dismiss" actions.

**Architecture:** Two new DB tables (`hook_event_log` for event aggregation, `dismissed_suggestions` for dismiss tracking). A new suggestion engine module aggregates events and generates suggestions. Two new API endpoints serve suggestions and handle dismissals. The dashboard gets a "Suggested Rules" section above the rules table.

**Tech Stack:** TypeScript, Express, better-sqlite3, vanilla JS (dashboard HTML)

**Design doc:** `docs/plans/2026-03-05-suggested-rules-design.md`

---

### Task 1: Add database tables

**Files:**
- Modify: `src/db/database.ts`

**Step 1: Add the two new tables to the SCHEMA string**

In `src/db/database.ts`, add these two table definitions to the end of the `SCHEMA` template literal (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS hook_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  command TEXT,
  file_path TEXT,
  session_id TEXT,
  session_cwd TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dismissed_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_key TEXT UNIQUE NOT NULL,
  dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  hit_count_at_dismissal INTEGER
);
```

**Step 2: Verify the server starts cleanly**

Run: `cd /Users/jamesschindler/projects/hooks-server && npx tsx src/index.ts`
Expected: "Hooks server running on http://localhost:3003" and "Database initialized" with no errors. Kill with Ctrl+C.

**Step 3: Commit**

```bash
git add src/db/database.ts
git commit -m "feat: add hook_event_log and dismissed_suggestions tables"
```

---

### Task 2: Log hook events on pre-tool-use

**Files:**
- Modify: `src/routes/hooks.ts`

**Step 1: Add event logging to the pre-tool-use handler**

In `src/routes/hooks.ts`, in the `router.post('/pre-tool-use', ...)` handler, add this block **after** the existing `hook_events` insert (line 79) and **before** `const ruleResponse = evaluateRules(event);` (line 81):

```typescript
  // Log to hook_event_log for suggestion aggregation
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
```

**Step 2: Verify the server starts and the pre-tool-use endpoint works**

Run: `cd /Users/jamesschindler/projects/hooks-server && npx tsx src/index.ts &`
Then test with curl:
```bash
curl -s -X POST http://localhost:3003/hooks/pre-tool-use \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"test-123","tool_name":"Bash","tool_input":{"command":"bun test"},"cwd":"/Users/test/project"}'
```
Expected: `{}` (no rule match). The event should be logged in `hook_event_log`.

**Step 3: Commit**

```bash
git add src/routes/hooks.ts
git commit -m "feat: log hook events to hook_event_log for suggestion aggregation"
```

---

### Task 3: Build the suggestion engine

**Files:**
- Create: `src/rules/suggestions.ts`

**Step 1: Create the suggestion engine module**

Create `src/rules/suggestions.ts` with the following content:

```typescript
import { getDb } from '../db/database';

export interface Suggestion {
  key: string;
  description: string;
  hit_count: number;
  proposed_rule: {
    name: string;
    tool_name_pattern: string;
    command_pattern?: string;
    file_path_pattern?: string;
    decision: 'allow';
    reason: string;
  };
}

interface AggregatedEvent {
  tool_name: string;
  pattern: string | null;
  hit_count: number;
}

interface DismissedRow {
  suggestion_key: string;
  hit_count_at_dismissal: number;
}

interface PermissionRuleRow {
  tool_name_pattern: string | null;
  command_pattern: string | null;
  file_path_pattern: string | null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDirPrefix(filePath: string): string {
  const parts = filePath.split('/');
  // Use up to the last 3 directory components for grouping
  const dirParts = parts.slice(0, -1);
  if (dirParts.length <= 3) return dirParts.join('/');
  return dirParts.slice(0, 3).join('/');
}

function normalizeCommand(command: string): string {
  // Extract the base command (first line, trim whitespace)
  const firstLine = command.split('\n')[0].trim();
  // For common runners, keep the subcommand too
  const match = firstLine.match(/^(bun|npm|npx|yarn|pnpm|node|python|pip|cargo|go|make|docker|git)\s+\S+/);
  return match ? match[0] : firstLine.split(/\s+/).slice(0, 3).join(' ');
}

function isCoveredByExistingRule(
  toolName: string,
  command: string | null,
  filePath: string | null,
  rules: PermissionRuleRow[]
): boolean {
  for (const rule of rules) {
    try {
      if (rule.tool_name_pattern && !new RegExp(rule.tool_name_pattern).test(toolName)) continue;
      if (rule.command_pattern && command && !new RegExp(rule.command_pattern).test(command)) continue;
      if (rule.command_pattern && !command) continue;
      if (rule.file_path_pattern && filePath && !new RegExp(rule.file_path_pattern).test(filePath)) continue;
      if (rule.file_path_pattern && !filePath) continue;
      // If we get here, the rule covers this pattern
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function generateSuggestions(): Suggestion[] {
  const db = getDb();

  // Prune old dismissed suggestions (30-day cleanup)
  db.prepare(`DELETE FROM dismissed_suggestions WHERE dismissed_at < datetime('now', '-30 days')`).run();

  // Aggregate Bash commands
  const bashAgg = db.prepare(`
    SELECT tool_name, command as pattern, COUNT(*) as hit_count
    FROM hook_event_log
    WHERE tool_name = 'Bash' AND command IS NOT NULL
      AND timestamp > datetime('now', '-7 days')
    GROUP BY tool_name, command
    HAVING COUNT(*) >= 3
    ORDER BY hit_count DESC
  `).all() as AggregatedEvent[];

  // Aggregate file-based tools by directory prefix
  const fileToolEvents = db.prepare(`
    SELECT tool_name, file_path
    FROM hook_event_log
    WHERE tool_name IN ('Read', 'Write', 'Edit') AND file_path IS NOT NULL
      AND timestamp > datetime('now', '-7 days')
  `).all() as { tool_name: string; file_path: string }[];

  // Group by tool_name + directory prefix
  const dirGroups: Record<string, { tool_name: string; pattern: string; hit_count: number }> = {};
  for (const evt of fileToolEvents) {
    const dir = extractDirPrefix(evt.file_path);
    const key = `${evt.tool_name}:${dir}`;
    if (!dirGroups[key]) {
      dirGroups[key] = { tool_name: evt.tool_name, pattern: dir, hit_count: 0 };
    }
    dirGroups[key].hit_count++;
  }
  const fileAgg = Object.values(dirGroups).filter(g => g.hit_count >= 3);

  // Aggregate other tools by tool_name alone
  const otherAgg = db.prepare(`
    SELECT tool_name, NULL as pattern, COUNT(*) as hit_count
    FROM hook_event_log
    WHERE tool_name NOT IN ('Bash', 'Read', 'Write', 'Edit')
      AND timestamp > datetime('now', '-7 days')
    GROUP BY tool_name
    HAVING COUNT(*) >= 3
    ORDER BY hit_count DESC
  `).all() as AggregatedEvent[];

  // Combine all aggregations
  const allAgg: AggregatedEvent[] = [...bashAgg, ...fileAgg, ...otherAgg];

  // Get existing rules for coverage check
  const existingRules = db.prepare(`
    SELECT tool_name_pattern, command_pattern, file_path_pattern
    FROM permission_rules WHERE enabled = 1
  `).all() as PermissionRuleRow[];

  // Get dismissed suggestions
  const dismissed = db.prepare(`
    SELECT suggestion_key, hit_count_at_dismissal FROM dismissed_suggestions
  `).all() as DismissedRow[];
  const dismissedMap = new Map(dismissed.map(d => [d.suggestion_key, d.hit_count_at_dismissal]));

  const suggestions: Suggestion[] = [];

  for (const agg of allAgg) {
    const normalizedPattern = agg.tool_name === 'Bash' && agg.pattern
      ? normalizeCommand(agg.pattern)
      : agg.pattern;

    const key = normalizedPattern
      ? `${agg.tool_name}:${normalizedPattern}`
      : agg.tool_name;

    // Check if dismissed (with resurface logic)
    const dismissedCount = dismissedMap.get(key);
    if (dismissedCount !== undefined && agg.hit_count < dismissedCount * 2) {
      continue;
    }

    // Check if covered by existing rule
    const isBash = agg.tool_name === 'Bash';
    const isFileTool = ['Read', 'Write', 'Edit'].includes(agg.tool_name);
    if (isCoveredByExistingRule(
      agg.tool_name,
      isBash ? normalizedPattern : null,
      isFileTool ? normalizedPattern : null,
      existingRules
    )) {
      continue;
    }

    // Build suggestion
    if (isBash && normalizedPattern) {
      suggestions.push({
        key,
        description: `Allow '${normalizedPattern}' in Bash (seen ${agg.hit_count} times)`,
        hit_count: agg.hit_count,
        proposed_rule: {
          name: `Allow ${normalizedPattern}`,
          tool_name_pattern: '^Bash$',
          command_pattern: `^${escapeRegex(normalizedPattern)}`,
          decision: 'allow',
          reason: 'Auto-suggested from usage patterns',
        },
      });
    } else if (isFileTool && normalizedPattern) {
      suggestions.push({
        key,
        description: `Allow ${agg.tool_name} in ${normalizedPattern}/ (seen ${agg.hit_count} times)`,
        hit_count: agg.hit_count,
        proposed_rule: {
          name: `Allow ${agg.tool_name} in ${normalizedPattern}/`,
          tool_name_pattern: `^${escapeRegex(agg.tool_name)}$`,
          file_path_pattern: `^${escapeRegex(normalizedPattern)}/`,
          decision: 'allow',
          reason: 'Auto-suggested from usage patterns',
        },
      });
    } else {
      suggestions.push({
        key,
        description: `Allow ${agg.tool_name} (seen ${agg.hit_count} times)`,
        hit_count: agg.hit_count,
        proposed_rule: {
          name: `Allow ${agg.tool_name}`,
          tool_name_pattern: `^${escapeRegex(agg.tool_name)}$`,
          decision: 'allow',
          reason: 'Auto-suggested from usage patterns',
        },
      });
    }
  }

  // Sort by hit_count descending, cap at 10
  suggestions.sort((a, b) => b.hit_count - a.hit_count);
  return suggestions.slice(0, 10);
}

export function dismissSuggestion(key: string, hitCount: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO dismissed_suggestions (suggestion_key, hit_count_at_dismissal)
    VALUES (?, ?)
  `).run(key, hitCount);
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/jamesschindler/projects/hooks-server && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/rules/suggestions.ts
git commit -m "feat: add suggestion engine for generating rule suggestions from usage data"
```

---

### Task 4: Add API endpoints for suggestions

**Files:**
- Modify: `src/routes/rules.ts`

**Step 1: Add the suggestions endpoints**

In `src/routes/rules.ts`, add this import at the top:

```typescript
import { generateSuggestions, dismissSuggestion } from '../rules/suggestions';
```

Then add these two routes **after** the existing `router.get('/rules/audit-log', ...)` route (after line 22) and **before** the `router.post('/rules', ...)` route (line 25). This ordering matters because Express matches routes top-to-bottom and `/rules/suggestions` must match before `/rules/:id`:

```typescript
// Get rule suggestions
router.get('/rules/suggestions', (_req: Request, res: Response) => {
  const suggestions = generateSuggestions();
  res.json(suggestions);
});

// Dismiss a suggestion
router.post('/rules/suggestions/:key/dismiss', (req: Request, res: Response) => {
  const { key } = req.params;
  const { hit_count } = req.body;
  dismissSuggestion(decodeURIComponent(key), hit_count || 0);
  res.json({ dismissed: true });
});
```

**Step 2: Verify it compiles and starts**

Run: `cd /Users/jamesschindler/projects/hooks-server && npx tsc --noEmit`
Expected: No errors.

Run: `npx tsx src/index.ts &`
Then: `curl -s http://localhost:3003/api/rules/suggestions | head`
Expected: `[]` (empty array, no events yet).

**Step 3: Commit**

```bash
git add src/routes/rules.ts
git commit -m "feat: add API endpoints for rule suggestions and dismissals"
```

---

### Task 5: Add suggested rules UI to dashboard

**Files:**
- Modify: `public/dashboard.html`

**Step 1: Add CSS for the suggestions section**

In `public/dashboard.html`, add these styles inside the `<style>` block (before the closing `</style>` tag, around line 395):

```css
    /* Suggestions */
    .suggestions-section { margin-bottom: 20px; }
    .suggestions-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .suggestions-header h2 { margin-bottom: 0; }
    .count-badge {
      background: #c9a0ff30;
      color: #c9a0ff;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .suggestion-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .suggestion-card:hover { border-color: #484f58; }
    .suggestion-info { flex: 1; }
    .suggestion-desc {
      font-size: 0.85rem;
      color: #e1e4e8;
    }
    .suggestion-desc code {
      background: #30363d;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8rem;
    }
    .suggestion-meta {
      font-size: 0.75rem;
      color: #8b949e;
      margin-top: 4px;
    }
    .suggestion-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .btn-success {
      background: #3fb950;
      color: #0f1117;
      border: none;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-success:hover { background: #56d364; }
    .btn-ghost {
      background: transparent;
      color: #8b949e;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .btn-ghost:hover { background: #21262d; color: #e1e4e8; }
```

**Step 2: Add the suggestions container to the rules tab HTML**

In `public/dashboard.html`, find the rules tab content (the `<div id="tab-rules">` around line 448). Insert the suggestions container **right after** the opening `<div id="tab-rules" style="display:none">` and **before** the existing header div:

```html
      <div id="suggestions-section" class="suggestions-section" style="display:none;">
        <div class="suggestions-header">
          <h2>Suggested Rules</h2>
          <span class="count-badge" id="suggestions-count">0</span>
        </div>
        <div id="suggestions-list"></div>
      </div>
```

**Step 3: Add the JavaScript functions**

In `public/dashboard.html`, add these functions inside the `<script>` tag, after the existing `loadAuditLog()` function (after line 924) and before the `// Flags` comment:

```javascript
    // Suggestions
    async function loadSuggestions() {
      try {
        const res = await fetch('/api/rules/suggestions');
        const suggestions = await res.json();
        const section = document.getElementById('suggestions-section');
        const container = document.getElementById('suggestions-list');
        const countBadge = document.getElementById('suggestions-count');

        if (suggestions.length === 0) {
          section.style.display = 'none';
          return;
        }

        section.style.display = 'block';
        countBadge.textContent = suggestions.length;

        container.innerHTML = suggestions.map(s => `
          <div class="suggestion-card">
            <div class="suggestion-info">
              <div class="suggestion-desc">${escapeHtml(s.description)}</div>
              <div class="suggestion-meta">
                <span class="decision-badge decision-${s.proposed_rule.decision}">${s.proposed_rule.decision}</span>
                ${s.proposed_rule.tool_name_pattern ? ' &middot; tool: <code>' + escapeHtml(s.proposed_rule.tool_name_pattern) + '</code>' : ''}
                ${s.proposed_rule.command_pattern ? ' &middot; cmd: <code>' + escapeHtml(s.proposed_rule.command_pattern) + '</code>' : ''}
                ${s.proposed_rule.file_path_pattern ? ' &middot; path: <code>' + escapeHtml(s.proposed_rule.file_path_pattern) + '</code>' : ''}
              </div>
            </div>
            <div class="suggestion-actions">
              <button class="btn-success" onclick="addSuggestion('${escapeHtml(s.key)}')">Add Rule</button>
              <button class="btn-ghost" onclick="dismissSuggestion('${escapeHtml(s.key)}', ${s.hit_count})">Dismiss</button>
            </div>
          </div>
        `).join('');
      } catch (e) {
        console.error('Failed to load suggestions:', e);
      }
    }

    let suggestionsCache = [];

    async function loadSuggestions() {
      try {
        const res = await fetch('/api/rules/suggestions');
        suggestionsCache = await res.json();
        const section = document.getElementById('suggestions-section');
        const container = document.getElementById('suggestions-list');
        const countBadge = document.getElementById('suggestions-count');

        if (suggestionsCache.length === 0) {
          section.style.display = 'none';
          return;
        }

        section.style.display = 'block';
        countBadge.textContent = suggestionsCache.length;

        container.innerHTML = suggestionsCache.map((s, i) => `
          <div class="suggestion-card">
            <div class="suggestion-info">
              <div class="suggestion-desc">${escapeHtml(s.description)}</div>
              <div class="suggestion-meta">
                <span class="decision-badge decision-${s.proposed_rule.decision}">${s.proposed_rule.decision}</span>
                ${s.proposed_rule.tool_name_pattern ? ' &middot; tool: <code>' + escapeHtml(s.proposed_rule.tool_name_pattern) + '</code>' : ''}
                ${s.proposed_rule.command_pattern ? ' &middot; cmd: <code>' + escapeHtml(s.proposed_rule.command_pattern) + '</code>' : ''}
                ${s.proposed_rule.file_path_pattern ? ' &middot; path: <code>' + escapeHtml(s.proposed_rule.file_path_pattern) + '</code>' : ''}
              </div>
            </div>
            <div class="suggestion-actions">
              <button class="btn-success" onclick="addSuggestion(${i})">Add Rule</button>
              <button class="btn-ghost" onclick="dismissSuggestionAt(${i})">Dismiss</button>
            </div>
          </div>
        `).join('');
      } catch (e) {
        console.error('Failed to load suggestions:', e);
      }
    }

    async function addSuggestion(index) {
      const s = suggestionsCache[index];
      if (!s) return;
      await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s.proposed_rule),
      });
      loadSuggestions();
      loadRules();
    }

    async function dismissSuggestionAt(index) {
      const s = suggestionsCache[index];
      if (!s) return;
      await fetch(`/api/rules/suggestions/${encodeURIComponent(s.key)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hit_count: s.hit_count }),
      });
      loadSuggestions();
    }
```

**Step 4: Wire suggestions into tab switching**

In `public/dashboard.html`, find the `switchTab` function (around line 583). Update the rules tab branch to also load suggestions:

Change:
```javascript
      if (tab === 'rules') { loadRules(); loadAuditLog(); }
```
To:
```javascript
      if (tab === 'rules') { loadSuggestions(); loadRules(); loadAuditLog(); }
```

**Step 5: Verify the dashboard loads**

Run: `cd /Users/jamesschindler/projects/hooks-server && npx tsx src/index.ts`
Open `http://localhost:3003` in browser. Click "Rules" tab. The suggestions section should be hidden (no events yet). The existing rules table and audit log should still render correctly.

**Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: add suggested rules UI to dashboard"
```

---

### Task 6: End-to-end verification

**Step 1: Start the server**

```bash
cd /Users/jamesschindler/projects/hooks-server && npx tsx src/index.ts
```

**Step 2: Seed some hook events**

Run these curls to simulate repeated tool usage:

```bash
for i in $(seq 1 5); do
  curl -s -X POST http://localhost:3003/hooks/pre-tool-use \
    -H 'Content-Type: application/json' \
    -d '{"session_id":"test-e2e","tool_name":"Bash","tool_input":{"command":"bun test"},"cwd":"/Users/test/project"}'
done

for i in $(seq 1 4); do
  curl -s -X POST http://localhost:3003/hooks/pre-tool-use \
    -H 'Content-Type: application/json' \
    -d '{"session_id":"test-e2e","tool_name":"Read","tool_input":{"file_path":"/Users/test/project/src/index.ts"},"cwd":"/Users/test/project"}'
done
```

**Step 3: Check suggestions API**

```bash
curl -s http://localhost:3003/api/rules/suggestions | python3 -m json.tool
```

Expected: Array with suggestions for "Bash: bun test" (5 hits) and "Read in /Users/test/project/src" (4 hits).

**Step 4: Test dismiss**

```bash
curl -s -X POST "http://localhost:3003/api/rules/suggestions/$(python3 -c 'import urllib.parse; print(urllib.parse.quote("Bash:bun test"))')/dismiss" \
  -H 'Content-Type: application/json' \
  -d '{"hit_count": 5}'
```

Then re-check suggestions — "Bash: bun test" should no longer appear (needs 10 hits to resurface).

**Step 5: Test add rule via suggestion**

Fetch a suggestion's `proposed_rule` and POST it to `/api/rules`:

```bash
curl -s -X POST http://localhost:3003/api/rules \
  -H 'Content-Type: application/json' \
  -d '{"name":"Allow Read in /Users/test/project/src/","tool_name_pattern":"^Read$","file_path_pattern":"^/Users/test/project/src/","decision":"allow","reason":"Auto-suggested from usage patterns"}'
```

Re-check suggestions — the Read suggestion should no longer appear (covered by existing rule).

**Step 6: Open dashboard, verify UI**

Open `http://localhost:3003`, click Rules tab. Verify:
- Suggestions section appears with remaining suggestions
- "Add Rule" button works (creates rule, removes suggestion)
- "Dismiss" button works (hides suggestion)
- The newly added rule appears in the rules table

**Step 7: Clean up test data and commit**

Delete the test DB or test rules as needed. No code changes needed for this step.

```bash
git log --oneline -5
```

Expected: 4 commits from this plan.
