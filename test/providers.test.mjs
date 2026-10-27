import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvider, ProviderError } from '../core/providers.mjs';

const input = [{ role: 'system', content: 'Work carefully.' }, { role: 'user', content: 'Read a.txt.' }];
const tool = { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const call = (id = 'call-1', args = '{"path":"a.txt"}') => ({ id, type: 'function', function: { name: 'read_file', arguments: args } });
const openai = (message = { role: 'assistant', content: 'Done.' }, usage = { prompt_tokens: 10, completion_tokens: 3 }) => ({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], ...(usage ? { usage } : {}) });
function json(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      requests.push(request);
      await handler(request, res, requests.length);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

test('OpenAI maps multiple function calls and their results through real local HTTP', async (t) => {
  const f = await fixture(t, (req, res, count) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-only');
    assert.equal(req.body.tools[0].function.name, 'read_file');
    assert.equal(req.body.max_tokens, 2048);
    if (count === 1) json(res, openai({ role: 'assistant', content: null, tool_calls: [call(), call('call-2', '{"path":"b.txt"}')] }));
    else {
      assert.equal(req.body.messages.at(-2).tool_call_id, 'call-1');
      assert.equal(req.body.messages.at(-1).tool_call_id, 'call-2');
      json(res, openai());
    }
  });
  const provider = createProvider({ model: 'mock', baseUrl: f.baseUrl, apiKey: 'test-only' });
  const first = await provider.complete({ messages: input, tools: [tool] });
  assert.equal(first.message.tool_calls.length, 2);
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 3 });
  const last = await provider.complete({ messages: [...input, first.message, { role: 'tool', tool_call_id: 'call-1', content: 'A' }, { role: 'tool', tool_call_id: 'call-2', content: 'B' }], tools: [tool] });
  assert.equal(last.message.content, 'Done.');
  assert.equal(last.finishReason, 'stop');
});

test('Anthropic merges adjacent tool results and preserves tool-error markers', async (t) => {
  const f = await fixture(t, (req, res, count) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers['x-api-key'], 'test-only');
    assert.equal(req.body.system, 'Work carefully.');
    assert.equal(req.body.tools[0].input_schema.type, 'object');
    if (count === 1) json(res, { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'b' } }], stop_reason: 'tool_use', usage: { input_tokens: 6, output_tokens: 2 } });
    else {
      const last = req.body.messages.at(-1);
      assert.equal(last.role, 'user');
      assert.equal(last.content.length, 2);
      assert.equal(last.content[0].tool_use_id, 'tool-1');
      assert.equal(last.content[1].is_error, true);
      json(res, { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }], stop_reason: 'end_turn' });
    }
  });
  const provider = createProvider({ type: 'anthropic', model: 'mock', baseUrl: f.baseUrl, apiKey: 'test-only' });
  const first = await provider.complete({ messages: input, tools: [tool] });
  assert.deepEqual(first.usage, { inputTokens: 6, outputTokens: 2 });
  const last = await provider.complete({ messages: [...input, first.message, { role: 'tool', tool_call_id: 'tool-1', content: '{"ok":true}' }, { role: 'tool', tool_call_id: 'tool-2', content: '{"ok":false}' }], tools: [tool] });
  assert.equal(last.message.content, 'Finished.');
  assert.deepEqual(last.usage, { inputTokens: null, outputTokens: null });
});

test('429 and 503 retry only within the configured budget', async (t) => {
  const f = await fixture(t, (_, res, count) => count < 3 ? json(res, {}, count === 1 ? 429 : 503, { 'retry-after': '0' }) : json(res, openai()));
  assert.equal((await createProvider({ model: 'mock', baseUrl: f.baseUrl }).complete({ messages: input })).message.content, 'Done.');
  assert.equal(f.requests.length, 3);
  const denied = await fixture(t, (_, res) => json(res, { message: 'must-not-leak' }, 401));
  await assert.rejects(createProvider({ model: 'mock', baseUrl: denied.baseUrl, apiKey: 'private-test-key' }).complete({ messages: input }), (e) => e instanceof ProviderError && e.status === 401 && !String(e).includes('private-test-key') && !String(e).includes('must-not-leak'));
  assert.equal(denied.requests.length, 1);
});

test('deadline covers response-body stalls and external cancellation interrupts retry delay', async (t) => {
  const f = await fixture(t, (_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await assert.rejects(createProvider({ model: 'mock', baseUrl: f.baseUrl, timeoutMs: 150, maxRetries: 0 }).complete({ messages: input }), (e) => e.code === 'TIMEOUT');
  const retry = await fixture(t, (_, res) => json(res, {}, 429, { 'retry-after': '5' }));
  const abort = new AbortController();
  const work = createProvider({ model: 'mock', baseUrl: retry.baseUrl }).complete({ messages: input, signal: abort.signal });
  const timer = setTimeout(() => abort.abort(), 40);
  await assert.rejects(work, (e) => e.code === 'ABORTED');
  clearTimeout(timer);
  assert.ok(retry.requests.length <= 1);
  const before = AbortSignal.abort();
  await assert.rejects(createProvider({ model: 'mock', baseUrl: retry.baseUrl }).complete({ messages: input, signal: before }), (e) => e.code === 'ABORTED');
});

test('streaming response byte limit applies without Content-Length', async (t) => {
  const f = await fixture(t, (_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('x'.repeat(600)); res.end(); });
  await assert.rejects(createProvider({ model: 'mock', baseUrl: f.baseUrl, maxResponseBytes: 512 }).complete({ messages: input }), (e) => e.code === 'RESPONSE_TOO_LARGE');
});

test('malformed JSON, nonobject arguments and duplicate tool IDs are rejected without retry', async (t) => {
  const responses = [
    '{',
    JSON.stringify(openai({ role: 'assistant', content: null, tool_calls: [call('bad', '[]')] })),
    JSON.stringify(openai({ role: 'assistant', content: null, tool_calls: [call('same'), call('same')] })),
  ];
  const f = await fixture(t, (_, res, count) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(responses[count - 1]); });
  const provider = createProvider({ model: 'mock', baseUrl: f.baseUrl });
  for (let i = 0; i < responses.length; i++) await assert.rejects(provider.complete({ messages: input }), (e) => e.code === 'INVALID_RESPONSE');
  assert.equal(f.requests.length, 3);
});

test('redirects do not forward credentials and configuration rejects insecure URLs', async (t) => {
  const target = await fixture(t, (_, res) => json(res, openai()));
  const redirect = await fixture(t, (_, res) => { res.writeHead(302, { location: target.baseUrl + '/chat/completions' }); res.end(); });
  await assert.rejects(createProvider({ model: 'mock', apiKey: 'not-forwarded', baseUrl: redirect.baseUrl, maxRetries: 0 }).complete({ messages: input }), (e) => e.code === 'NETWORK_ERROR');
  assert.equal(target.requests.length, 0);
  for (const baseUrl of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?token=secret', 'file:///tmp/api']) assert.throws(() => createProvider({ model: 'mock', baseUrl }), /URL/);
  assert.throws(() => createProvider({ type: 'unknown', model: 'mock' }));
  assert.throws(() => createProvider({ model: 'mock', apiKey: 'bad\nkey' }));
});

test('unknown usage stays null and invalid tool schemas fail before HTTP', async (t) => {
  const f = await fixture(t, (_, res) => json(res, openai(undefined, null)));
  const provider = createProvider({ model: 'mock', baseUrl: f.baseUrl });
  const result = await provider.complete({ messages: input });
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
  await assert.rejects(provider.complete({ messages: input, tools: [{ name: 'bad.tool', description: '', parameters: {} }] }), (e) => e.code === 'INVALID_REQUEST');
  assert.equal(f.requests.length, 1);
});
