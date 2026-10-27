import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const LIMIT = 8 * 1024 * 1024;
const STATES = new Set(['ready', 'running', 'completed', 'cancelled', 'error', 'budget_exhausted']);

function sessionId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid session ID');
  return value;
}

async function directory(value, create = false) {
  if (typeof value !== 'string' || !value) throw new Error('sessionDir is required');
  const absolute = path.resolve(value);
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(absolute); }
  catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Session directory must not be a symbolic link');
  return realpath(absolute);
}

async function readRegular(file, maximum = LIMIT) {
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximum) throw new Error('Invalid or oversized session file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || info.ino !== before.ino || info.dev !== before.dev) throw new Error('Session file changed');
    const buffer = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== info.size || used > maximum || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Session file changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
  } finally { await handle.close(); }
}

function validate(state, id, workspace) {
  if (!state || state.version !== 1 || state.id !== id || typeof state.workspace !== 'string' || !path.isAbsolute(state.workspace) || (workspace && state.workspace !== workspace) || !STATES.has(state.status) || !Array.isArray(state.messages) || state.messages.length > 10000 || typeof state.title !== 'string') throw new Error('Invalid session format or workspace identity');
  for (const message of state.messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role) || (typeof message.content !== 'string' && !(message.role === 'assistant' && message.content === null))) throw new Error('Invalid session message');
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') throw new Error('Invalid session tool result');
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 64) throw new Error('Invalid session tool batch');
      const ids = new Set();
      for (const call of message.tool_calls) {
        if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new Error('Invalid session tool call');
        ids.add(call.id);
      }
    }
  }
  return state;
}

async function load(file, id, workspace) {
  let value;
  try { value = JSON.parse(await readRegular(file)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Corrupt session JSON'); throw error; }
  return validate(value, id, workspace);
}

export async function readSession(sessionDir, id) {
  sessionId(id);
  const dir = await directory(sessionDir);
  if (!dir) throw new Error('Session does not exist');
  return load(path.join(dir, id + '.json'), id);
}

export async function listSessions(sessionDir) {
  const dir = await directory(sessionDir);
  if (!dir) return [];
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json') && ID.test(file.slice(0, -5))).sort().slice(0, 1000);
  const summaries = [];
  for (const file of files) {
    const id = file.slice(0, -5);
    try {
      const state = await load(path.join(dir, file), id);
      summaries.push({ id, title: state.title, workspace: state.workspace, updatedAt: state.updatedAt, status: state.status });
    } catch { summaries.push({ id, title: 'Unreadable session', status: 'error', workspace: '', updatedAt: '' }); }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function openSession({ workspace, sessionDir, sessionId: requestedId } = {}) {
  if (typeof workspace !== 'string' || !workspace) throw new Error('workspace is required');
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace is not a directory');
  const id = sessionId(requestedId ?? randomUUID());
  const dir = await directory(sessionDir ?? path.join(root, '.feather', 'sessions'), true);
  const file = path.join(dir, id + '.json');
  const lockFile = path.join(dir, id + '.lock');
  const journal = path.join(dir, id + '.jsonl');
  const token = randomUUID();
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Session is locked. Check for an active process before manually removing ' + lockFile);
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await lock.close();
    const current = await readRegular(lockFile, 4096).catch(() => '');
    if (current.includes(token)) await unlink(lockFile);
  };
  try {
    await lock.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
    let state;
    try { state = await load(file, id, root); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const now = new Date().toISOString();
      state = { id, version: 1, workspace: root, messages: [], status: 'ready', title: '', createdAt: now, updatedAt: now };
    }
    const save = async () => {
      if (closed) throw new Error('Session is closed');
      validate(state, id, root);
      state.updatedAt = new Date().toISOString();
      const content = JSON.stringify(state, null, 2);
      if (Buffer.byteLength(content) > LIMIT) throw new Error('Session exceeds storage budget');
      const temporary = path.join(dir, '.' + id + '-' + randomUUID() + '.tmp');
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        await rename(temporary, file);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    };
    const event = async (entry) => {
      if (closed) throw new Error('Session is closed');
      const content = JSON.stringify({ ...entry, sessionId: id, at: new Date().toISOString() }) + '\n';
      if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Journal entry is too large');
      try {
        const info = await lstat(journal);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid journal file');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const handle = await open(journal, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Invalid journal file');
        await handle.writeFile(content);
      } finally { await handle.close(); }
    };
    await save();
    return { state, save, event, close };
  } catch (error) { await close(); throw error; }
}
