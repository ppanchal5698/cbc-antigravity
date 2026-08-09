/**
 * Event-mapping check. Run with `npm run check:events`.
 *
 * The fixture below is real NDJSON captured from `agy --output-format
 * stream-json`, not invented. If agy's shape changes, this fails loudly instead
 * of the status feed quietly going blank.
 */
import assert from 'node:assert/strict';
import { RunBuffer, toFrames } from './events.ts';
import type { AgyRawEvent, StatusEvent, StreamFrame } from '../types/events.ts';

const FIXTURE = [
  '{"event":"init","conversation_id":"bdc3da2c","init":{"cwd":"C:\\\\workspace","tools":["list_dir"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.002}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"C:\\\\workspace\\\\plans"}}}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"ERROR","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","error":{"type":"TOOL_ERROR","message":"Permission denied"}}}}',
  '{"event":"step_update","step_update":{"step_index":6,"state":"DONE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","output":"a/\\nb/"}}}',
  // Captured verbatim: agy names these parameters in PascalCase.
  '{"event":"step_update","step_update":{"step_index":7,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"product_category":"custom_built"},"ServerName":"cbc-estimating-engine","ToolName":"get_margin_band"}}}}',
  '{"event":"step_update","step_update":{"step_index":9,"state":"ACTIVE","step_type":"agent_response","text_delta":"## Result"}}',
  '{"event":"step_update","step_update":{"step_index":9,"state":"DONE","step_type":"agent_response","text_delta":"\\n"}}',
  '{"event":"step_update","step_update":{"step_index":10,"state":"DONE","step_type":"checkpoint","duration_seconds":1.6}}',
  '{"event":"step_update","step_update":{"step_index":11,"state":"ACTIVE","step_type":"brand_new_type_agy_grew_later"}}',
  '{"event":"result","result":{"conversation_id":"bdc3da2c","status":"SUCCESS","response":"## Result\\n","duration_seconds":6.5,"num_turns":1}}',
];

function run(lines: string[]): StreamFrame[] {
  const state = { sawText: false };
  const frames: StreamFrame[] = [];
  for (const line of lines) {
    frames.push(...toFrames(JSON.parse(line) as AgyRawEvent, state));
  }
  return frames;
}

const frames = run(FIXTURE);
const statuses = frames.filter((f): f is { kind: 'status'; event: StatusEvent } => f.kind === 'status');
const types = statuses.map((s) => s.event.type);

assert.deepEqual(types, [
  'starting',
  'tool_use',
  'tool_error',
  'tool_result',
  'tool_use',
  'crafting_response',
  'finalizing', // checkpoint
  'finalizing', // unrecognised step type, passed through not dropped
  'done',
]);

// The conversation id must surface so the next turn can resume it.
assert.equal(
  frames.find((f) => f.kind === 'conversation')?.conversationId,
  'bdc3da2c',
);

// Every status carries a parseable timestamp.
for (const status of statuses) {
  assert.ok(!Number.isNaN(new Date(status.event.ts).getTime()), 'status is missing a timestamp');
}

// The real tool name reaches the UI, and MCP calls are unwrapped to the tool
// actually being invoked rather than the generic `call_mcp_tool`.
assert.equal(statuses[1].event.tool, 'list_dir');
assert.equal(statuses[1].event.detail, 'C:\\workspace\\plans');
assert.equal(statuses[2].event.detail, 'Permission denied');
assert.equal(statuses[4].event.tool, 'call_mcp_tool');
assert.equal(statuses[4].event.mcpTool, 'cbc-estimating-engine/get_margin_band');
// `Arguments` is an object and must not be mistaken for the step's subtitle.
assert.equal(statuses[4].event.detail, 'cbc-estimating-engine');

// `crafting_response` fires once, not per token.
assert.equal(types.filter((t) => t === 'crafting_response').length, 1);

const tokens = frames.filter((f) => f.kind === 'token');
assert.equal(tokens.map((t) => (t.kind === 'token' ? t.text : '')).join(''), '## Result\n');

const done = frames.at(-1);
assert.ok(done?.kind === 'done' && done.response === '## Result\n');

// A failed run yields an error frame, never a silent success.
const failed = run([
  '{"event":"result","result":{"status":"ERROR","response":""}}',
]);
assert.ok(failed.some((f) => f.kind === 'error'), 'non-SUCCESS result did not produce an error');

// Reconnect replay: a subscriber joining late still gets every frame by id.
const buffer = new RunBuffer();
const seen: number[] = [];
buffer.push({ kind: 'token', text: 'a' });
buffer.subscribe((id) => seen.push(id));
buffer.push({ kind: 'done', response: 'a' });
assert.equal(buffer.frames.length, 2);
assert.deepEqual(seen, [2]);
assert.equal(buffer.finished, true);

// `since` is the reconnect contract: Last-Event-ID N returns N+1 onwards.
assert.deepEqual(buffer.since(0).map((f) => f.id), [1, 2]);
assert.deepEqual(buffer.since(1).map((f) => f.id), [2]);
assert.deepEqual(buffer.since(2), []);

// Past the frame cap, ids must keep rising. They used to be read off
// `frames.length` after the shift, which pinned every later frame at id 5000 and
// silently broke reconnect for any run long enough to matter.
const long = new RunBuffer();
const ids: number[] = [];
long.subscribe((id) => ids.push(id));
for (let i = 0; i < 6000; i += 1) long.push({ kind: 'token', text: String(i) });

assert.equal(ids.length, 6000);
assert.deepEqual(ids, ids.map((_, i) => i + 1), 'event ids are not monotonic past the cap');
assert.equal(long.lastId, 6000);
assert.equal(long.firstId, 1001, 'firstId did not track the evicted frames');

// A resume lands on the frame that actually follows the last one the client saw.
const resumed = long.since(5500);
assert.equal(resumed[0]!.id, 5501);
assert.equal(
  resumed[0]!.frame.kind === 'token' ? resumed[0]!.frame.text : null,
  '5500',
  'resume returned the wrong frame',
);
assert.equal(resumed.at(-1)!.id, 6000);

// A client asking for a frame that has already been evicted gets the oldest
// surviving one rather than an empty replay.
assert.equal(long.since(0)[0]!.id, 1001);

console.log('event mapping check passed');
