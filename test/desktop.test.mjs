import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopService, validateSettings } from '../desktop/service.mjs';

async function fixture(t, storage) {
  const root = await mkdtemp(path.join(tmpdir(), 'feather-desktop-test-'));
  const events = [];
  const service = await createDesktopService({ dataDir: path.join(root, 'data'), credentialStorage: storage, onEvent: (event) => events.push(event) });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, events };
}
test('desktop demo uses real file tools, persists sessions, and never needs credentials', async (t) => {
  const { service, events } = await fixture(t);
  const ready = await service.demo();
  assert.equal(ready.started, true);
  const result = await service.waitIdle();
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.toolCalls, 2);
  assert.match(await readFile(result.reportPath, 'utf8'), /Total: 350/);
  assert.ok(events.some((event) => event.type === 'complete'));
  const state = await service.getState();
  assert.equal(state.settings.hasKey, false);
  assert.equal(state.sessions.length, 1);
  const loaded = await service.inspectSession(ready.sessionId);
  assert.equal(loaded.messages.filter((m) => m.role === 'tool').length, 2);
  assert.equal(state.workspace, loaded.workspace);
});
test('model keys stay in main memory unless encrypted storage is explicitly selected', async (t) => {
  const storage = { encrypt: async () => 'encrypted-test-value', decrypt: async () => 'test-private-key' };
  const { root, service } = await fixture(t, storage);
  const settings = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'test', apiKey: 'test-private-key', rememberKey: true };
  const saved = await service.saveSettings(settings);
  assert.equal(saved.hasKey, true);
  assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  const raw = await readFile(path.join(root, 'data/settings.json'), 'utf8');
  assert.equal(raw.includes('test-private-key'), false);
  assert.match(raw, /encrypted-test-value/);
  const moved = await service.saveSettings({ ...settings, apiKey: '', baseUrl: 'https://other-provider.example/v1' });
  assert.equal(moved.hasKey, false, 'credentials must not move to another endpoint');
});
test('remembering a key requires a secure backend; secrets are not echoed', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.saveSettings({ provider: 'openai', model: 'test', apiKey: 'private', rememberKey: true }), /加密/);
  assert.equal((await service.getState()).settings.hasKey, false);
  const saved = await service.saveSettings({ provider: 'openai', model: '', apiKey: 'private', rememberKey: false });
  assert.equal(saved.hasKey, true);
  const state = await service.getState();
  assert.equal(JSON.stringify(state).includes('private'), false);
});
test('workspace selection is trusted and tasks cannot pass arbitrary paths or overlap', async (t) => {
  const { root, service } = await fixture(t);
  await assert.rejects(service.setWorkspace(root), /具体项目/);
  const project = path.join(root, 'project');
  await mkdir(project);
  await service.setWorkspace(project);
  assert.equal((await service.getState()).workspace, await import('node:fs/promises').then((fs) => fs.realpath(project)));
  assert.throws(() => service.start({ task: 'read', workspace: root }), /无效/);
  const first = service.demo();
  assert.throws(() => service.demo(), /正在执行/);
  await first;
  await service.waitIdle();
  await assert.rejects(service.inspectSession('../invalid'));
});
test('settings validation rejects unsafe destinations and malformed payloads', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com', 'file:///tmp/x', 'https://example.com?key=x']) assert.throws(() => validateSettings({ provider: 'openai', baseUrl, model: '', rememberKey: false }));
  assert.throws(() => validateSettings({ provider: 'unknown', rememberKey: false }));
  assert.throws(() => validateSettings({ provider: 'openai', rememberKey: false, unexpected: true }));
});
