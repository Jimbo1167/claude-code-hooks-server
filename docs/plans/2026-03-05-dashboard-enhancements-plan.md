# Dashboard Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add stats bar, live indicators, expandable events, tool breakdowns, and project filtering to the hooks dashboard.

**Architecture:** All new backend queries go in `src/routes/api.ts`. All frontend changes are in `public/dashboard.html` (single-file vanilla JS). Each task is independently deployable — the dashboard works after every commit.

**Tech Stack:** Express + better-sqlite3 (backend), vanilla HTML/CSS/JS (frontend)

---

### Task 1: Backend — Add `/api/stats` endpoint

**Files:**
- Modify: `src/routes/api.ts`

**Step 1: Add the stats endpoint**

Add this route to `src/routes/api.ts` before the `export default router` line:

```typescript
router.get('/stats', (req: Request, res: Response) => {
  const cwd = req.query.cwd as string | undefined;
  const db = getDb();

  const today = new Date().toISOString().split('T')[0];

  const cwdFilter = cwd ? 'AND s.cwd = ?' : '';
  const cwdJoin = cwd ? 'JOIN sessions s ON e.session_id = s.id' : '';
  const cwdJoinSessions = cwd ? 'AND cwd = ?' : '';
  const cwdParams = cwd ? [cwd] : [];

  const sessionsToday = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE date(started_at) = ? ${cwdJoinSessions}
  `).get(today, ...cwdParams) as { count: number };

  const sessionsAllTime = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE 1=1 ${cwdJoinSessions}
  `).get(...cwdParams) as { count: number };

  const toolsToday = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PreToolUse' AND date(e.timestamp) = ? ${cwdFilter}
  `).get(today, ...cwdParams) as { count: number };

  const toolsAllTime = db.prepare(`
    SELECT COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PreToolUse' ${cwdFilter}
  `).get(...cwdParams) as { count: number };

  const activeSessions = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE ended_at IS NULL ${cwdJoinSessions}
  `).get(...cwdParams) as { count: number };

  const topTools = db.prepare(`
    SELECT e.tool_name, COUNT(*) as count FROM hook_events e
    ${cwdJoin}
    WHERE e.hook_event_name = 'PreToolUse' AND e.tool_name IS NOT NULL ${cwdFilter}
    GROUP BY e.tool_name
    ORDER BY count DESC
    LIMIT 3
  `).all(...cwdParams);

  res.json({
    sessions_today: sessionsToday.count,
    sessions_all_time: sessionsAllTime.count,
    tools_today: toolsToday.count,
    tools_all_time: toolsAllTime.count,
    active_sessions: activeSessions.count,
    top_tools: topTools,
  });
});
```

**Step 2: Verify it works**

Run: `npm run dev`
Then: `curl -s http://localhost:3003/api/stats | python3 -m json.tool`
Expected: JSON with all six fields, counts may be 0.

**Step 3: Commit**

```bash
git add src/routes/api.ts
git commit -m "feat: add /api/stats endpoint with today/all-time counts and top tools"
```

---

### Task 2: Backend — Add `/api/projects` endpoint and cwd filter on `/api/sessions`

**Files:**
- Modify: `src/routes/api.ts`

**Step 1: Add the projects endpoint**

Add this route to `src/routes/api.ts`:

```typescript
router.get('/projects', (_req: Request, res: Response) => {
  const db = getDb();
  const projects = db.prepare(`
    SELECT cwd, COUNT(*) as session_count
    FROM sessions
    WHERE cwd IS NOT NULL AND cwd != ''
    GROUP BY cwd
    ORDER BY session_count DESC
  `).all() as { cwd: string; session_count: number }[];

  res.json(projects.map(p => ({
    cwd: p.cwd,
    basename: p.cwd.split('/').pop() || p.cwd,
    session_count: p.session_count,
  })));
});
```

**Step 2: Add cwd filter to existing sessions endpoint**

Replace the existing `/sessions` route handler with:

```typescript
router.get('/sessions', (req: Request, res: Response) => {
  const cwd = req.query.cwd as string | undefined;
  const db = getDb();

  const cwdFilter = cwd ? 'WHERE s.cwd = ?' : '';
  const params = cwd ? [cwd] : [];

  const sessions = db.prepare(`
    SELECT s.*, COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN hook_events e ON s.id = e.session_id AND e.hook_event_name IN ('PreToolUse', 'PostToolUse')
    ${cwdFilter}
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 10
  `).all(...params);

  res.json(sessions);
});
```

**Step 3: Verify both work**

Run: `curl -s http://localhost:3003/api/projects | python3 -m json.tool`
Expected: Array of objects with cwd, basename, session_count.

Run: `curl -s "http://localhost:3003/api/sessions?cwd=/some/path" | python3 -m json.tool`
Expected: Filtered sessions array (may be empty).

**Step 4: Commit**

```bash
git add src/routes/api.ts
git commit -m "feat: add /api/projects endpoint and cwd filter on /api/sessions"
```

---

### Task 3: Frontend — Stats bar

**Files:**
- Modify: `public/dashboard.html`

**Step 1: Add stats bar CSS**

Add to the `<style>` block:

```css
.stats-bar {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 14px 18px;
}
.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: #e1e4e8;
}
.stat-secondary {
  font-size: 0.75rem;
  color: #484f58;
  margin-left: 6px;
}
.stat-label {
  font-size: 0.75rem;
  color: #8b949e;
  margin-top: 4px;
}
.top-tools-list {
  font-size: 0.78rem;
  color: #8b949e;
  margin-top: 4px;
  font-family: monospace;
}
.top-tools-list span { color: #e1e4e8; }
```

**Step 2: Add stats bar HTML**

Add this between the `status-bar` div and the `<h2>Recent Sessions</h2>`:

```html
<div class="stats-bar" id="stats-bar">
  <div class="stat-card">
    <div><span class="stat-value" id="stat-sessions-today">-</span><span class="stat-secondary" id="stat-sessions-all"></span></div>
    <div class="stat-label">Sessions Today</div>
  </div>
  <div class="stat-card">
    <div><span class="stat-value" id="stat-tools-today">-</span><span class="stat-secondary" id="stat-tools-all"></span></div>
    <div class="stat-label">Tool Calls Today</div>
  </div>
  <div class="stat-card">
    <div><span class="stat-value" id="stat-active">-</span></div>
    <div class="stat-label">Active Now</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Top Tools</div>
    <div class="top-tools-list" id="stat-top-tools">-</div>
  </div>
</div>
```

**Step 3: Add JS to fetch and render stats**

Add this function and wire it into `refresh()`:

```javascript
async function loadStats() {
  try {
    const cwdParam = selectedProject ? `?cwd=${encodeURIComponent(selectedProject)}` : '';
    const res = await fetch(`/api/stats${cwdParam}`);
    const s = await res.json();
    document.getElementById('stat-sessions-today').textContent = s.sessions_today;
    document.getElementById('stat-sessions-all').textContent = `/ ${s.sessions_all_time} all time`;
    document.getElementById('stat-tools-today').textContent = s.tools_today;
    document.getElementById('stat-tools-all').textContent = `/ ${s.tools_all_time} all time`;
    document.getElementById('stat-active').textContent = s.active_sessions;
    document.getElementById('stat-top-tools').innerHTML = s.top_tools.length
      ? s.top_tools.map(t => `<span>${t.tool_name}</span> ${t.count}`).join(' &middot; ')
      : 'No data yet';
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}
```

Add `let selectedProject = null;` at the top of the script.
Add `loadStats()` call inside `refresh()` and the initial load.

**Step 4: Verify**

Open http://localhost:3003 — stats bar should show with values populated.

**Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: add stats bar with today/all-time counts and top tools"
```

---

### Task 4: Frontend — Live pulse + duration ticker

**Files:**
- Modify: `public/dashboard.html`

**Step 1: Add pulse CSS**

Add to `<style>`:

```css
.pulse-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3fb950;
  margin-right: 6px;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.4); }
  50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(63, 185, 80, 0); }
}
.session-duration {
  font-size: 0.78rem;
  color: #8b949e;
  font-family: monospace;
}
```

**Step 2: Update session card rendering**

In the `loadSessions` function, replace the badges section of the session card template. Change:

```javascript
<span class="badge">${s.event_count} tools</span>
<span class="badge">${status}</span>
```

To:

```javascript
<span class="badge">${s.event_count} tools</span>
${!s.ended_at
  ? '<span class="badge"><span class="pulse-dot"></span>active</span>'
  : '<span class="badge">ended</span>'}
```

Also replace the `started` line and add duration to the meta. Change:

```javascript
const started = new Date(s.started_at + 'Z').toLocaleString();
```

To:

```javascript
const started = new Date(s.started_at + 'Z').toLocaleString();
const startMs = new Date(s.started_at + 'Z').getTime();
const endMs = s.ended_at ? new Date(s.ended_at + 'Z').getTime() : null;
```

Add a duration span in the session meta area after the model span:

```html
<span class="session-duration" ${!s.ended_at ? `data-start="${startMs}"` : ''}>
  ${!s.ended_at ? formatDuration(Date.now() - startMs) : formatDuration(endMs - startMs)}
</span>
```

**Step 3: Add duration formatting + ticker**

Add these functions:

```javascript
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 0) return '0s';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

setInterval(() => {
  document.querySelectorAll('.session-duration[data-start]').forEach(el => {
    const startMs = parseInt(el.getAttribute('data-start'));
    el.textContent = formatDuration(Date.now() - startMs);
  });
}, 1000);
```

**Step 4: Verify**

Open dashboard — active sessions should show pulsing green dot and a live-ticking duration. Ended sessions show static duration.

**Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: add live pulse indicator and ticking duration on sessions"
```

---

### Task 5: Frontend — Expandable tool input + copy button

**Files:**
- Modify: `public/dashboard.html`

**Step 1: Add expandable CSS**

Add to `<style>`:

```css
.event-row.expandable { cursor: pointer; }
.event-row.expandable:hover { background: #1c2230; }
.chevron {
  display: inline-block;
  transition: transform 0.15s;
  margin-right: 4px;
  font-size: 0.7rem;
  color: #484f58;
}
.chevron.open { transform: rotate(90deg); }
.event-expanded {
  background: #0d1117;
  border: 1px solid #21262d;
  border-radius: 6px;
  padding: 12px;
  margin: 4px 0 8px 0;
  position: relative;
  font-family: monospace;
  font-size: 0.78rem;
  color: #8b949e;
  white-space: pre-wrap;
  word-break: break-all;
}
.copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  background: #30363d;
  color: #e1e4e8;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 0.7rem;
  cursor: pointer;
}
.copy-btn:hover { background: #484f58; }
```

**Step 2: Update event row rendering**

Replace the event row rendering in `loadEvents` with:

```javascript
container.innerHTML = events.map((e, i) => {
  const time = new Date(e.timestamp + 'Z').toLocaleTimeString();
  const hasInput = e.tool_input && e.tool_input !== 'null';
  let detail = '';
  if (e.tool_name) detail += e.tool_name;
  if (hasInput) {
    try {
      const input = JSON.parse(e.tool_input);
      if (input && typeof input === 'object') {
        const preview = JSON.stringify(input).substring(0, 200);
        detail += detail ? ': ' + preview : preview;
      }
    } catch {}
  }
  if (e.decision) detail += (detail ? ' | ' : '') + e.decision;

  let expandedHtml = '';
  if (hasInput) {
    try {
      const pretty = JSON.stringify(JSON.parse(e.tool_input), null, 2);
      expandedHtml = `
        <div class="event-expanded" id="expanded-${i}" style="display:none;">
          <button class="copy-btn" onclick="copyJson(event, ${i})">Copy</button>
          <pre style="margin:0;">${escapeHtml(pretty)}</pre>
        </div>`;
    } catch {}
  }

  return `
    <div class="event-row ${hasInput ? 'expandable' : ''}"
         ${hasInput ? `onclick="toggleExpand(${i})"` : ''}>
      <span class="event-time">${hasInput ? '<span class="chevron" id="chev-' + i + '">&#9654;</span>' : ''}${time}</span>
      <span class="event-type ${e.hook_event_name}">${e.hook_event_name}</span>
      <span class="event-detail">${detail || '-'}</span>
    </div>
    ${expandedHtml}
  `;
}).join('');
```

**Step 3: Add toggle and copy functions**

```javascript
function toggleExpand(i) {
  const el = document.getElementById(`expanded-${i}`);
  const chev = document.getElementById(`chev-${i}`);
  if (!el) return;
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  if (chev) chev.classList.toggle('open', !visible);
}

function copyJson(event, i) {
  event.stopPropagation();
  const el = document.getElementById(`expanded-${i}`);
  if (!el) return;
  const pre = el.querySelector('pre');
  navigator.clipboard.writeText(pre.textContent).then(() => {
    const btn = el.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

**Step 4: Verify**

Open dashboard, select a session, click a PreToolUse/PostToolUse event row — should expand to show pretty JSON with a Copy button.

**Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: add expandable tool input with copy button on event rows"
```

---

### Task 6: Frontend — Per-session tool breakdown bar

**Files:**
- Modify: `public/dashboard.html`

**Step 1: Add breakdown CSS**

Add to `<style>`:

```css
.tool-breakdown {
  display: flex;
  border-radius: 6px;
  overflow: hidden;
  height: 24px;
  margin-bottom: 16px;
  background: #21262d;
}
.tool-segment {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 600;
  color: #0d1117;
  white-space: nowrap;
  overflow: hidden;
  min-width: 0;
}
.breakdown-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 12px;
  font-size: 0.75rem;
  color: #8b949e;
}
.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}
```

**Step 2: Add breakdown rendering**

Add this function:

```javascript
const TOOL_COLORS = {
  Bash: '#ffa657', Edit: '#7ee787', Read: '#79c0ff', Write: '#d2a8ff',
  Grep: '#f778ba', Glob: '#ffd700', Agent: '#ff7b72', WebFetch: '#a5d6ff',
};
const DEFAULT_TOOL_COLOR = '#8b949e';

function renderToolBreakdown(events) {
  const toolCounts = {};
  events.forEach(e => {
    if (e.hook_event_name === 'PreToolUse' && e.tool_name) {
      toolCounts[e.tool_name] = (toolCounts[e.tool_name] || 0) + 1;
    }
  });

  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';

  const total = entries.reduce((s, e) => s + e[1], 0);

  const bar = entries.map(([name, count]) => {
    const pct = (count / total * 100).toFixed(1);
    const color = TOOL_COLORS[name] || DEFAULT_TOOL_COLOR;
    const label = pct > 8 ? `${name} ${count}` : '';
    return `<div class="tool-segment" style="width:${pct}%;background:${color};" title="${name}: ${count}">${label}</div>`;
  }).join('');

  const legend = entries.map(([name, count]) => {
    const color = TOOL_COLORS[name] || DEFAULT_TOOL_COLOR;
    return `<span><span class="legend-dot" style="background:${color};"></span>${name}: ${count}</span>`;
  }).join('');

  return `<div class="tool-breakdown">${bar}</div><div class="breakdown-legend">${legend}</div>`;
}
```

**Step 3: Wire into loadEvents**

At the start of the events rendering (after the empty check), add:

```javascript
const breakdownHtml = renderToolBreakdown(events);
container.innerHTML = breakdownHtml + events.map((e, i) => {
```

(Remove the existing `container.innerHTML = events.map(...)`)

**Step 4: Verify**

Select a session with tool calls — should see a colored bar with tool proportions and a legend.

**Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: add per-session tool breakdown bar with color-coded segments"
```

---

### Task 7: Frontend — Project filter dropdown

**Files:**
- Modify: `public/dashboard.html`

**Step 1: Add filter CSS**

Add to `<style>`:

```css
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.filter-bar label {
  font-size: 0.8rem;
  color: #8b949e;
}
.filter-bar select {
  background: #161b22;
  color: #e1e4e8;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.8rem;
  cursor: pointer;
}
.filter-bar select:focus {
  outline: none;
  border-color: #c9a0ff;
}
```

**Step 2: Add filter HTML**

Add this just before `<h2>Recent Sessions</h2>`:

```html
<div class="filter-bar">
  <label for="project-filter">Project:</label>
  <select id="project-filter" onchange="filterByProject(this.value)">
    <option value="">All Projects</option>
  </select>
</div>
```

**Step 3: Add filter JS**

```javascript
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    const select = document.getElementById('project-filter');
    const current = select.value;
    select.innerHTML = '<option value="">All Projects</option>' +
      projects.map(p =>
        `<option value="${escapeHtml(p.cwd)}" title="${escapeHtml(p.cwd)}" ${p.cwd === current ? 'selected' : ''}>${escapeHtml(p.basename)} (${p.session_count})</option>`
      ).join('');
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
}

function filterByProject(cwd) {
  selectedProject = cwd || null;
  selectedSessionId = null;
  document.getElementById('events-panel').style.display = 'none';
  refresh();
}
```

**Step 4: Wire selectedProject into loadSessions**

Update the fetch URL in `loadSessions`:

```javascript
const cwdParam = selectedProject ? `?cwd=${encodeURIComponent(selectedProject)}` : '';
const res = await fetch(`/api/sessions${cwdParam}`);
```

**Step 5: Add loadProjects to refresh cycle**

Add `loadProjects()` to the initial load and inside `refresh()`.

**Step 6: Verify**

Open dashboard, project dropdown should populate. Selecting a project filters sessions and stats.

**Step 7: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: add project filter dropdown that scopes sessions and stats"
```

---

Plan complete and saved to `docs/plans/2026-03-05-dashboard-enhancements-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?