export interface HookEvent {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
  permission_mode?: string;
  cwd?: string;
  model?: string;
  stop_hook_reason?: string;
}

export interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  permission_mode: string | null;
  model: string | null;
  cwd: string | null;
}

export interface StoredHookEvent {
  id: number;
  session_id: string;
  hook_event_name: string;
  tool_name: string | null;
  tool_input: string | null;
  timestamp: string;
  decision: string | null;
}
