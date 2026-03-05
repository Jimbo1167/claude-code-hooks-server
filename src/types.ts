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

export interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: {
      behavior: 'allow' | 'deny';
      message?: string;
      updatedPermissions?: Array<{ type: string; tool: string }>;
    };
  };
  decision?: 'block';
  reason?: string;
}

export interface PermissionRule {
  id: number;
  name: string;
  description: string | null;
  enabled: number;
  priority: number;
  tool_name_pattern: string | null;
  command_pattern: string | null;
  file_path_pattern: string | null;
  session_cwd_pattern: string | null;
  decision: 'allow' | 'deny' | 'ask';
  reason: string | null;
  updated_input: string | null;
  created_at: string;
  hit_count: number;
  last_hit_at: string | null;
}
