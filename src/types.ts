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

  // Notification fields
  title?: string;
  message?: string;

  // Subagent fields
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;

  // Compaction fields
  transcript_path?: string;

  // CwdChanged
  new_cwd?: string;

  // ConfigChange (source carries the config source: user_settings, project_settings, ...)
  file_path?: string;

  // Reasoning effort delivered on recent hook events ({ level: 'low' | ... })
  effort?: { level?: string };

  // Stop hook loop prevention
  stop_hook_active?: boolean;

  // Setup (--init / --maintenance runs)
  setup_type?: string;

  // UserPromptExpansion
  command_name?: string;
  original_prompt?: string;

  // PostToolBatch
  tool_calls?: Array<Record<string, unknown>>;
  batch_index?: number;

  // FileChanged (file_path is shared with ConfigChange above)
  change_type?: string;

  // DirectoryAdded
  directory_path?: string;
  add_method?: string;

  // InstructionsLoaded
  load_reason?: string;

  // WorktreeCreate / WorktreeRemove
  worktree_path?: string;
  source_ref?: string;
  reason?: string;

  // Elicitation / ElicitationResult
  mcp_server?: string;
  form_schema?: Record<string, unknown>;
  user_response?: Record<string, unknown>;

  // TeammateIdle
  idle_reason?: string;
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
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: Array<{ type: string; mode?: string; tool?: string; destination?: string }>;
    additionalContext?: string;
    // PostToolUse: rewrite the tool result before Claude sees it
    updatedToolOutput?: unknown;
    // SessionStart: name the session in Claude Code's UI
    sessionTitle?: string;
    // PermissionDenied: tell the model the denied call may be retried
    retry?: boolean;
    // FileChanged: replace the set of watched files going forward
    watchPaths?: string[];
    decision?: {
      behavior: 'allow' | 'deny';
      message?: string;
      updatedPermissions?: Array<{ type: string; mode?: string; tool?: string; destination?: string }>;
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
  decision: 'allow' | 'deny' | 'ask' | 'defer';
  reason: string | null;
  updated_input: string | null;
  updated_permissions: string | null;
  created_at: string;
  hit_count: number;
  last_hit_at: string | null;
}
