export interface HookEvent {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  permission_mode?: string;
  cwd?: string;
  model?: string;
  stop_hook_reason?: string;
  source?: string;
  last_assistant_message?: string;
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
  tool_response: string | null;
  timestamp: string;
  decision: string | null;
  source: string | null;
  last_assistant_message: string | null;
}
