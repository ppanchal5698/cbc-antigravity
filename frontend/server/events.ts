/** Maps raw agy NDJSON into the status feed the UI renders, plus replay buffers. */
import type { AgyRawEvent, StreamFrame } from '../types/events.ts';

function pick(params: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!params) return undefined;
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Pull the underlying MCP tool out of a `call_mcp_tool` invocation.
 * agy names these parameters in PascalCase (`ServerName`, `ToolName`); the
 * snake_case aliases are kept as a cheap hedge against a rename.
 */
function unwrapMcpTool(params: Record<string, unknown> | undefined): string | undefined {
  const tool = pick(params, ['ToolName', 'tool_name', 'toolName']);
  if (!tool) return undefined;
  const server = pick(params, ['ServerName', 'server_name', 'serverName']);
  return server ? `${server}/${tool}` : tool;
}

/** A short, human-meaningful subtitle for a tool step: the path or the query. */
function describeParams(params: Record<string, unknown> | undefined): string | undefined {
  const known = pick(params, [
    'AbsolutePath',
    'DirectoryPath',
    'TargetFile',
    'File',
    'Query',
    'SearchTerm',
    'CommandLine',
    'Command',
    'Url',
  ]);
  const value = known ?? pick(params, Object.keys(params ?? {}));
  if (!value) return undefined;
  return value.length > 200 ? `${value.slice(0, 197)}…` : value;
}

/**
 * One raw event in, zero or more frames out. Token deltas and status ride the
 * same channel so the UI never has to correlate two streams.
 *
 * `sawText` tracks whether the model has begun writing the answer, so the first
 * `agent_response` delta becomes a `crafting_response` status exactly once.
 */
export function toFrames(raw: AgyRawEvent, state: { sawText: boolean }): StreamFrame[] {
  const ts = new Date().toISOString();
  const frames: StreamFrame[] = [];

  if (raw.event === 'init') {
    const conversationId = raw.conversation_id;
    if (conversationId) frames.push({ kind: 'conversation', conversationId });
    frames.push({
      kind: 'status',
      event: {
        ts,
        type: 'starting',
        detail: raw.init?.cwd ? `workspace ${raw.init.cwd}` : undefined,
      },
    });
    return frames;
  }

  if (raw.event === 'result') {
    const status = raw.result?.status ?? 'UNKNOWN';
    if (status !== 'SUCCESS') {
      frames.push({
        kind: 'status',
        event: { ts, type: 'error', detail: `agy result ${status}`, raw: raw.result },
      });
      frames.push({ kind: 'error', message: `Antigravity run ended with status ${status}` });
      return frames;
    }
    frames.push({ kind: 'status', event: { ts, type: 'done' } });
    frames.push({
      kind: 'done',
      response: raw.result?.response ?? '',
      durationSeconds: raw.result?.duration_seconds,
    });
    return frames;
  }

  if (raw.event !== 'step_update' || !raw.step_update) {
    // Unknown top-level event: surface it rather than swallow it.
    frames.push({ kind: 'status', event: { ts, type: 'finalizing', raw } });
    return frames;
  }

  const step = raw.step_update;
  const stepIndex = step.step_index;

  switch (step.step_type) {
    case 'tool': {
      const tool = step.tool_name || step.tool_info?.name;
      const mcpTool =
        tool === 'call_mcp_tool' ? unwrapMcpTool(step.tool_info?.parameters) : undefined;
      if (step.state === 'ACTIVE') {
        frames.push({
          kind: 'status',
          event: {
            ts,
            type: 'tool_use',
            stepIndex,
            tool,
            mcpTool,
            detail: describeParams(step.tool_info?.parameters),
          },
        });
      } else if (step.state === 'ERROR') {
        frames.push({
          kind: 'status',
          event: {
            ts,
            type: 'tool_error',
            stepIndex,
            tool,
            mcpTool,
            detail: step.tool_info?.error?.message,
          },
        });
      } else {
        frames.push({
          kind: 'status',
          event: { ts, type: 'tool_result', stepIndex, tool, mcpTool },
        });
      }
      break;
    }

    case 'agent_response': {
      if (step.text_delta) {
        if (!state.sawText) {
          state.sawText = true;
          frames.push({ kind: 'status', event: { ts, type: 'crafting_response', stepIndex } });
        }
        frames.push({ kind: 'token', text: step.text_delta });
      }
      break;
    }

    case 'checkpoint': {
      frames.push({ kind: 'status', event: { ts, type: 'finalizing', stepIndex } });
      break;
    }

    case 'user_input':
    case 'unknown':
    case undefined:
      break;

    default: {
      // A step type agy grew after this was written still reaches the UI.
      frames.push({
        kind: 'status',
        event: { ts, type: 'finalizing', stepIndex, detail: step.step_type, raw: step },
      });
    }
  }

  return frames;
}

export function sseFrame(id: number, frame: StreamFrame): string {
  return `id: ${id}\nevent: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Per-run replay buffer. A browser that reconnects sends `Last-Event-ID` and
 * gets everything it missed, so a dropped connection resumes instead of
 * restarting the run.
 *
 * ponytail: in-memory, capped at MAX frames per run; move to Postgres if runs
 * need to survive a gateway restart mid-stream.
 */
const MAX_FRAMES = 5000;

export class RunBuffer {
  readonly frames: StreamFrame[] = [];
  private listeners = new Set<(id: number, frame: StreamFrame) => void>();
  finished = false;

  /**
   * SSE id of `frames[0]`, rising as the cap evicts the oldest frames.
   *
   * Ids must be monotonic for the whole run, not positions in the array: deriving the
   * id from `frames.length` after a shift pinned every frame past the cap at id 5000,
   * so a reconnect resumed from the wrong place. A 30-minute estimate streaming tokens
   * passes 5000 frames easily, so that was the normal case.
   */
  firstId = 1;

  get lastId(): number {
    return this.firstId + this.frames.length - 1;
  }

  push(frame: StreamFrame): void {
    this.frames.push(frame);
    if (this.frames.length > MAX_FRAMES) {
      this.frames.shift();
      this.firstId += 1;
    }
    const id = this.lastId;
    if (frame.kind === 'done' || frame.kind === 'error') this.finished = true;
    for (const listener of this.listeners) listener(id, frame);
  }

  /**
   * Everything after `lastEventId`, each with its own id. A client asking for a frame
   * already evicted gets the oldest surviving one rather than silence.
   */
  since(lastEventId: number): { id: number; frame: StreamFrame }[] {
    const from = Math.max(lastEventId + 1, this.firstId);
    const out: { id: number; frame: StreamFrame }[] = [];
    for (let id = from; id <= this.lastId; id += 1) {
      out.push({ id, frame: this.frames[id - this.firstId]! });
    }
    return out;
  }

  subscribe(listener: (id: number, frame: StreamFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const runBuffers = new Map<string, RunBuffer>();

export function getRunBuffer(runId: string): RunBuffer {
  let buffer = runBuffers.get(runId);
  if (!buffer) {
    buffer = new RunBuffer();
    runBuffers.set(runId, buffer);
  }
  return buffer;
}
