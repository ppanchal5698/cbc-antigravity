/**
 * Wire protocol between the Antigravity gateway and the browser.
 *
 * Shapes below were captured from a live `agy --output-format stream-json` run,
 * not guessed. agy emits no timestamps of its own, so the gateway stamps `ts`
 * the moment it reads each NDJSON line.
 */

/** Raw NDJSON line emitted by `agy --output-format stream-json`. */
export type AgyRawEvent = {
  event: 'init' | 'step_update' | 'result' | (string & {});
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    /** ACTIVE | DONE | ERROR */
    state?: string;
    /** user_input | agent_response | tool | checkpoint | unknown | ... */
    step_type?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, unknown>;
      output?: string;
      error?: { type?: string; message?: string };
    };
    duration_seconds?: number;
    usage?: Record<string, number>;
  };
  result?: {
    conversation_id?: string;
    /** SUCCESS | ERROR | ... */
    status?: string;
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: Record<string, number>;
  };
};

export type StatusType =
  | 'starting'
  | 'tool_use'
  | 'tool_result'
  | 'tool_error'
  | 'crafting_response'
  | 'finalizing'
  | 'done'
  | 'error';

export type StatusEvent = {
  /** ISO timestamp, stamped by the gateway when the line was read. */
  ts: string;
  type: StatusType;
  stepIndex?: number;
  /** Real tool name from agy, e.g. `view_file` or `call_mcp_tool`. */
  tool?: string;
  /** Unwrapped MCP server/tool when `tool === 'call_mcp_tool'`. */
  mcpTool?: string;
  detail?: string;
  /** Unrecognised step types pass through here instead of being dropped. */
  raw?: unknown;
};

/** One SSE frame. `token` carries markdown text; everything else is metadata. */
export type StreamFrame =
  | { kind: 'status'; event: StatusEvent }
  | { kind: 'token'; text: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'done'; response: string; durationSeconds?: number }
  | { kind: 'error'; message: string };

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

export type Project = {
  id: string;
  name: string;
  slug: string;
  folder_path: string;
  status: string;
  created_at: string;
};

export type ProjectFile = {
  id: string;
  project_id: string;
  filename: string;
  path: string;
  size_bytes: number;
  mime: string | null;
  uploaded_at: string;
};

export type WorkflowRun = {
  id: string;
  project_id: string;
  file_id: string | null;
  conversation_id: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  output_path: string | null;
  created_at: string;
};
