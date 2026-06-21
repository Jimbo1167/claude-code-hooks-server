// Secret redaction for tool output.
//
// PostToolUse hooks can rewrite a tool's result before Claude ever sees it via
// `updatedToolOutput`. We use that to strip high-confidence secret formats out
// of tool output (especially MCP responses) so credentials don't end up in the
// model context, the SQLite event log, or the on-disk MCP audit files.
//
// Patterns are deliberately conservative — each matches a well-known token
// shape, not generic "password=..." assignments — to avoid mangling legitimate
// output with false positives.

interface SecretPattern {
  label: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { label: 'private-key', regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { label: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: 'github-token', regex: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g },
  { label: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  { label: 'stripe-key', regex: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { label: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g },
];

export function isRedactionEnabled(): boolean {
  // On by default; set REDACT_TOOL_OUTPUT=false to disable.
  return (process.env.REDACT_TOOL_OUTPUT || 'true').toLowerCase() !== 'false';
}

function redactString(value: string): { value: string; count: number } {
  let count = 0;
  let out = value;
  for (const { label, regex } of PATTERNS) {
    out = out.replace(regex, () => {
      count++;
      return `[REDACTED:${label}]`;
    });
  }
  return { value: out, count };
}

// Recursively redact every string inside a JSON-like value. Returns a new value
// (the input is not mutated) plus the number of secrets that were replaced.
export function redactValue<T>(value: T): { value: T; count: number } {
  if (typeof value === 'string') {
    const r = redactString(value);
    return { value: r.value as unknown as T, count: r.count };
  }

  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map(item => {
      const r = redactValue(item);
      count += r.count;
      return r.value;
    });
    return { value: out as unknown as T, count };
  }

  if (value && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactValue(v);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out as unknown as T, count };
  }

  return { value, count: 0 };
}
