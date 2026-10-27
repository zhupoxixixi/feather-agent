import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSession, readSession, listSessions } from '../core/sessions.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'feather-session-test-')));
  const workspace = path.join(root, 'workspace');
  const sessionDir = path.join(root, 'state');
  await mkdir(workspace);
  const opened = [];
  t.after(async () => {
    for (const session of opened) await session.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, workspace, sessionDir,
    open: async (options = {}) => {
      const session = await openSession({ workspace, sessionDir, ...options });
      opened.push(session);
      return session;
    },
  };
}

test('session persists messages, journal, and summaries and can be reopened', async (t) => {
  const f = await fixture(t);
  const session = await f.open();
  session.state.messages.push({ role: 'user', content: 'A real task' });
  session.state.title = 'A real task';
  session.state.status = 'completed';
  await session.save();
  await session.event({ type: 'test_event', message: 'verified' });
  const id = session.state.id;
  const file = path.join(f.sessionDir, id + '.json');
  const journalFile = path.join(f.sessionDir, id + '.jsonl');
  assert.equal((await readSession(f.sessionDir, id)).messages[0].content, 'A real task');
  const files = await readdir(f.sessionDir);
  assert.equal(files.some((name) => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(f.sessionDir)).mode & 0o777, 0o700);
  }
  await session.close();
  const reopened = await f.open({ sessionId: id });
  assert.equal(reopened.state.id, id);
  assert.equal(reopened.state.status, 'completed');
  const event = JSON.parse((await readFile(journalFile, 'utf8')).trim());
  assert.equal(event.type, 'test_event');
  const summaries = await listSessions(f.sessionDir);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, id);
  assert.equal(summaries[0].workspace, await realpath(f.workspace));
  assert.equal(summaries[0].title, 'A real task');
  assert.equal(summaries[0].status, 'completed');
});

test('a session lock prevents concurrent writers until its owner closes it', async (t) => {
  const f = await fixture(t);
  const first = await f.open({ sessionId: 'same-session' });
  await assert.rejects(f.open({ sessionId: 'same-session' }), /lock|busy|in use/i);
  await first.close();
  const next = await f.open({ sessionId: 'same-session' });
  assert.equal(next.state.id, 'same-session');
  await next.close();
  await assert.rejects(next.save(), /closed/i);
});

test('invalid IDs cannot traverse the session directory', async (t) => {
  const f = await fixture(t);
  for (const id of ['../outside', '/absolute', 'a/b', 'a\\b', '.', '', 'x'.repeat(200)]) {
    await assert.rejects(f.open({ sessionId: id }), /id|session|invalid/i);
    await assert.rejects(readSession(f.sessionDir, id), /id|session|invalid/i);
  }
});

test('opening an existing session refuses a different canonical workspace', async (t) => {
  const f = await fixture(t);
  const first = await f.open({ sessionId: 'bound' });
  await first.close();
  const otherWorkspace = path.join(f.root, 'other-workspace');
  await mkdir(otherWorkspace);
  await assert.rejects(f.open({ sessionId: 'bound', workspace: otherWorkspace }), /workspace|identity|match/i);
});

test('corrupt JSON and malformed session structures are refused, and a failed open releases its lock', async (t) => {
  const f = await fixture(t);
  const first = await f.open({ sessionId: 'corrupt' });
  await first.close();
  const file = path.join(f.sessionDir, 'corrupt.json');
  const valid = await readFile(file, 'utf8');
  await writeFile(file, '{');
  await assert.rejects(f.open({ sessionId: 'corrupt' }), /json|corrupt|invalid|format/i);
  await writeFile(file, valid);
  const restored = await f.open({ sessionId: 'corrupt' });
  await restored.close();
  const malformed = JSON.parse(valid);
  malformed.messages = 'not an array';
  await writeFile(file, JSON.stringify(malformed));
  await assert.rejects(readSession(f.sessionDir, 'corrupt'), /message|invalid|format/i);
});

test('unknown stale locks are not deleted automatically', async (t) => {
  const f = await fixture(t);
  const first = await f.open({ sessionId: 'stale' });
  await first.close();
  const lock = path.join(f.sessionDir, 'stale.lock');
  await writeFile(lock, JSON.stringify({ pid: 99999999, token: 'unknown-owner' }));
  await assert.rejects(f.open({ sessionId: 'stale' }), /lock|busy|in use/i);
  assert.match(await readFile(lock, 'utf8'), /unknown-owner/);
});

test('session directories and session files do not follow symbolic links', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  try { await symlink(outside, f.sessionDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) { t.skip('Host does not allow test symlinks'); return; }
    throw error;
  }
  await assert.rejects(f.open(), /symlink|symbolic|director|path/i);
  await rm(f.sessionDir);
  const first = await f.open({ sessionId: 'linked' });
  await first.close();
  const target = path.join(f.sessionDir, 'linked.json');
  const outsideFile = path.join(outside, 'session.json');
  await writeFile(outsideFile, await readFile(target));
  await rm(target);
  try { await symlink(outsideFile, target); }
  catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) { t.skip('Host does not allow test file symlinks'); return; }
    throw error;
  }
  await assert.rejects(readSession(f.sessionDir, 'linked'));
});
