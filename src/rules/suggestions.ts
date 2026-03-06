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
  const dirParts = parts.slice(0, -1);
  if (dirParts.length <= 3) return dirParts.join('/');
  return dirParts.slice(0, 3).join('/');
}

function normalizeCommand(command: string): string {
  const firstLine = command.split('\n')[0].trim();
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
      isFileTool && normalizedPattern ? normalizedPattern + '/' : null,
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
