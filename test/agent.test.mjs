import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSession, readSession } from '../core/sessions.mjs';
import { runAgent } from '../core/agent.mjs';

const definitions = [
  { name: 'read_file', description: 'Read a test value', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Write a test value', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
];

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function response(content, calls, options = {}) {
  return {
    message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) },
    usage: options.usage ?? { inputTokens: 10, outputTokens: 2 },
    finishReason: options.finishReason ?? (calls ? 'tool_calls' : 'stop'),
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'feather-agent-test-')));
  const sessionDir = path.join(root, 'state');
  const session = await openSession({ workspace: root, sessionDir });
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true }); });
  return { root, sessionDir, session };
}

function toolbox(workspace, execute = async () => ({ text: 'alpha' })) {
  return { workspace, definitions, execute };
}

test('multi-step run preserves tool pairs and persists its verified answer', async (t) => {
  const f = await fixture(t);
  let step = 0;
  const executed = [];
  const events = [];
  const provider = { complete: async ({ messages, tools, signal }) => {
    assert.ok(signal);
    assert.equal(tools.length, definitions.length);
    step++;
    if (step === 1) return response(null, [call('read', 'read_file', { path: 'note.txt' })]);
    if (step === 2) {
      const result = messages.at(-1);
      assert.equal(result.role, 'tool');
      assert.equal(result.tool_call_id, 'read');
      assert.match(result.content, /alpha/);
      return response(null, [call('write', 'write_file', { path: 'summary.txt', content: 'alpha summarized' })]);
    }
    assert.equal(messages.at(-1).tool_call_id, 'write');
    return response('The summary has been written.');
  } };
  const box = toolbox(f.root, async (name, args) => { executed.push({ name, args }); return { text: name === 'read_file' ? 'alpha' : 'saved' }; });
  const result = await runAgent({ task: 'Summarize the note', provider, toolbox: box, session: f.session, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 3);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.answer, 'The summary has been written.');
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 6 });
  assert.deepEqual(executed.map((x) => x.name), ['read_file', 'write_file']);
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => typeof event.type === 'string'));
  const state = await readSession(f.sessionDir, result.sessionId);
  assert.equal(state.status, 'completed');
  const replies = state.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(replies.map((m) => m.tool_call_id), ['read', 'write']);
  for (const reply of replies) assert.doesNotThrow(() => JSON.parse(reply.content));
});

test('tool budget rejects an entire oversized batch without side effects and closes all pairs', async (t) => {
  const f = await fixture(t);
  let executed = 0;
  const provider = { complete: async () => response(null, [
    call('a', 'write_file', { path: 'a', content: 'a' }),
    call('b', 'write_file', { path: 'b', content: 'b' }),
  ]) };
  const result = await runAgent({ task: 'Write files', provider, toolbox: toolbox(f.root, async () => { executed++; }), session: f.session, maxToolCalls: 1 });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(executed, 0);
  const replies = f.session.state.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(replies.map((m) => m.tool_call_id), ['a', 'b']);
  for (const reply of replies) assert.ok(JSON.parse(reply.content).error);
});

test('tool failures become model-visible structured errors rather than fabricated success', async (t) => {
  const f = await fixture(t);
  let step = 0;
  const provider = { complete: async ({ messages }) => {
    if (!step++) return response(null, [call('denied', 'write_file', { path: 'x', content: 'x' })]);
    const reply = JSON.parse(messages.at(-1).content);
    assert.ok(reply.error);
    assert.match(JSON.stringify(reply), /disabled/);
    return response('Writing is disabled.');
  } };
  const result = await runAgent({
    task: 'Write a file', provider, session: f.session,
    toolbox: toolbox(f.root, async () => { throw new Error('Writes are disabled'); }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'Writing is disabled.');
});

test('resume marks unfinished mutations interrupted and does not replay them', async (t) => {
  const f = await fixture(t);
  f.session.state.messages.push(
    { role: 'system', content: 'Test system instruction' },
    { role: 'user', content: 'An old task' },
    { role: 'assistant', content: null, tool_calls: [
      call('finished', 'read_file', { path: 'a' }),
      call('pending', 'write_file', { path: 'a', content: 'replace' }),
    ] },
    { role: 'tool', tool_call_id: 'finished', content: '{"ok":true,"result":"old"}' },
  );
  f.session.state.status = 'running';
  await f.session.save();
  let executed = 0;
  const provider = { complete: async ({ messages }) => {
    const interrupted = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'pending');
    assert.ok(interrupted);
    assert.match(interrupted.content, /interrupt/i);
    assert.ok(JSON.parse(interrupted.content).error);
    assert.equal(messages.at(-1).role, 'user');
    assert.match(messages.at(-1).content, /new task/);
    return response('The pending write was not replayed.');
  } };
  const result = await runAgent({ task: 'A new task', provider, toolbox: toolbox(f.root, async () => { executed++; }), session: f.session });
  assert.equal(result.status, 'completed');
  assert.equal(executed, 0);
  assert.equal(f.session.state.messages.filter((m) => m.role === 'tool' && m.tool_call_id === 'finished').length, 1);
});

test('input budget prevents a model call when the current transcript is too large', async (t) => {
  const f = await fixture(t);
  let called = false;
  const provider = { complete: async () => { called = true; return response('unexpected'); } };
  const result = await runAgent({ task: 'Task text'.repeat(20), provider, toolbox: toolbox(f.root), session: f.session, maxChars: 10 });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(called, false);
});

test('step and repetition limits stop an endless sequence of tool calls', async (t) => {
  const f = await fixture(t);
  let sequence = 0;
  let executed = 0;
  const provider = { complete: async () => response(null, [call('loop-' + (++sequence), 'read_file', { path: 'same.txt' })]) };
  const result = await runAgent({ task: 'Keep reading', provider, toolbox: toolbox(f.root, async () => { executed++; return 'same'; }), session: f.session, maxSteps: 20 });
  assert.equal(result.status, 'budget_exhausted');
  assert.ok(result.steps < 20, 'consecutive repeated requests should stop before the overall step limit');
  assert.ok(executed <= 4, 'repeated tools must not be executed indefinitely');
  const g = await fixture(t);
  const limited = await runAgent({ task: 'Only one step', provider, toolbox: toolbox(g.root), session: g.session, maxSteps: 1 });
  assert.equal(limited.status, 'budget_exhausted');
  assert.equal(limited.steps, 1);
});

function waitingProvider() {
  return { complete: ({ signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
}

test('external cancellation reaches the in-flight model and persists a cancelled status', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    const result = await runAgent({ task: 'Wait', provider: waitingProvider(), toolbox: toolbox(f.root), session: f.session, signal: controller.signal });
    assert.equal(result.status, 'cancelled');
    assert.equal((await readSession(f.sessionDir, result.sessionId)).status, 'cancelled');
  } finally { clearTimeout(timer); }
});

test('task deadline aborts an in-flight model request', async (t) => {
  const f = await fixture(t);
  const result = await runAgent({ task: 'Wait', provider: waitingProvider(), toolbox: toolbox(f.root), session: f.session, timeoutMs: 30 });
  assert.equal(result.status, 'budget_exhausted');
});

test('missing model usage stays unknown rather than being reported as zero', async (t) => {
  const f = await fixture(t);
  const provider = { complete: async () => response('Done', null, { usage: { inputTokens: null, outputTokens: null } }) };
  const result = await runAgent({ task: 'Answer', provider, toolbox: toolbox(f.root), session: f.session });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
});

for (const finishReason of ['length', 'max_tokens']) {
  test('truncated model answer is not marked complete: ' + finishReason, async (t) => {
    const f = await fixture(t);
    const provider = { complete: async () => response('Partial answer', null, { finishReason }) };
    const result = await runAgent({ task: 'Answer fully', provider, toolbox: toolbox(f.root), session: f.session });
    assert.equal(result.status, 'budget_exhausted');
  });
}

test('invalid duplicate tool-call IDs fail before executing a tool', async (t) => {
  const f = await fixture(t);
  let executed = 0;
  const provider = { complete: async () => response(null, [
    call('same-id', 'read_file', { path: 'a' }),
    call('same-id', 'read_file', { path: 'b' }),
  ]) };
  const result = await runAgent({ task: 'Read', provider, toolbox: toolbox(f.root, async () => { executed++; }), session: f.session });
  assert.equal(result.status, 'error');
  assert.equal(executed, 0);
});
