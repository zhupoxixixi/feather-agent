import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createToolbox } from '../core/tools.mjs';

const sha = (content) => createHash('sha256').update(content).digest('hex');
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feather-desktop-tools-'));
  const workspace = path.join(directory, 'work');
  await mkdir(workspace);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace, toolbox: await createToolbox({ workspace, ...options }) };
}

test('default tools are read-only, schemas are strict, and execution rechecks permission', async (t) => {
  const { toolbox } = await fixture(t);
  assert.deepEqual(toolbox.definitions.map((d) => d.name), ['list_files', 'read_file', 'search_files']);
  for (const tool of toolbox.definitions) assert.equal(tool.parameters.additionalProperties, false);
  await assert.rejects(toolbox.execute('write_file', { path: 'x.txt', content: 'x' }), /disabled/);
  await assert.rejects(toolbox.execute('run_command', { command: 'node' }), /disabled/);
  await assert.rejects(createToolbox({ workspace: toolbox.workspace, allowWrite: 'yes' }), /boolean/);
});

test('portable paths reject traversal, protected names, absolute paths and Windows aliases', async (t) => {
  const { toolbox, directory } = await fixture(t, { allowWrite: true });
  await writeFile(path.join(directory, 'outside.txt'), 'keep');
  const paths = ['../outside.txt', 'docs/../outside.txt', '/etc/passwd', 'C:/outside.txt', 'C:outside.txt', 'file.txt:secret', 'CON.txt', 'aux', 'folder./file', 'folder /file', '.git/config', '.GIT/config', '.feather/state', 'node_modules/a', '.env', '.ENV.local', 'a\\b'];
  for (const filename of paths) {
    await assert.rejects(toolbox.execute('read_file', { path: filename }));
    await assert.rejects(toolbox.execute('write_file', { path: filename, content: 'no' }));
  }
  assert.equal(await readFile(path.join(directory, 'outside.txt'), 'utf8'), 'keep');
});

test('symlink files and parent directories cannot escape the workspace', async (t) => {
  const { toolbox, directory, workspace } = await fixture(t, { allowWrite: true });
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, 'outside needle');
  try {
    await symlink(outside, path.join(workspace, 'linked'));
    await symlink(directory, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows runner does not grant symlink creation'); return; }
    throw error;
  }
  for (const filename of ['linked', 'escape/outside.txt']) {
    await assert.rejects(toolbox.execute('read_file', { path: filename }), /Symbolic/);
    await assert.rejects(toolbox.execute('write_file', { path: filename, content: 'no' }), /Symbolic/);
  }
  const result = await toolbox.execute('search_files', { query: 'outside needle' });
  assert.equal(result.matches.length, 0);
  assert.equal(await readFile(outside, 'utf8'), 'outside needle');
});

test('UTF-8 read returns a full-file hash, line range and explicit partial coverage', async (t) => {
  const { toolbox, workspace } = await fixture(t);
  const content = 'alpha\n中文\ngamma\n';
  await writeFile(path.join(workspace, 'note.txt'), content);
  const result = await toolbox.execute('read_file', { path: 'note.txt', start_line: 2, max_lines: 1 });
  assert.equal(result.content, '中文\n');
  assert.equal(result.sha256, sha(content));
  assert.equal(result.start_line, 2);
  assert.equal(result.end_line, 2);
  assert.equal(result.total_lines, 3);
  assert.equal(result.truncated, true);
  await writeFile(path.join(workspace, 'empty.txt'), '');
  const empty = await toolbox.execute('read_file', { path: 'empty.txt' });
  assert.equal(empty.content, '');
  assert.equal(empty.total_lines, 0);
  assert.equal(empty.sha256, sha(''));
});

test('read rejects oversized, binary and invalid UTF-8 files', async (t) => {
  const { toolbox, workspace } = await fixture(t, { maxFileBytes: 50 });
  await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(51));
  await writeFile(path.join(workspace, 'binary'), Buffer.from([0, 10]));
  await writeFile(path.join(workspace, 'invalid'), Buffer.from([255]));
  await assert.rejects(toolbox.execute('read_file', { path: 'large.txt' }), /limit/);
  await assert.rejects(toolbox.execute('read_file', { path: 'binary' }), /Binary/);
  await assert.rejects(toolbox.execute('read_file', { path: 'invalid' }), /UTF-8/);
});

test('serialized read output remains bounded even with escaped text', async (t) => {
  const { toolbox, workspace } = await fixture(t, { maxOutputChars: 512 });
  const content = '\\"\n'.repeat(1000);
  await writeFile(path.join(workspace, 'escaped.txt'), content);
  const result = await toolbox.execute('read_file', { path: 'escaped.txt', max_lines: 500 });
  assert.ok(JSON.stringify(result).length <= 512);
  assert.equal(result.truncated, true);
  assert.equal(result.sha256, sha(content));
});

test('writes create directories and require a fresh expected hash for replacement', async (t) => {
  const { toolbox, workspace } = await fixture(t, { allowWrite: true, maxFileBytes: 50 });
  const first = await toolbox.execute('write_file', { path: 'docs/note.txt', content: 'first' });
  assert.equal(first.created, true);
  assert.equal(first.sha256, sha('first'));
  await assert.rejects(toolbox.execute('write_file', { path: 'docs/note.txt', content: 'second' }), /expected_sha256/);
  await assert.rejects(toolbox.execute('write_file', { path: 'docs/note.txt', content: 'second', expected_sha256: 'a'.repeat(64) }), /expected_sha256/);
  assert.equal(await readFile(path.join(workspace, 'docs/note.txt'), 'utf8'), 'first');
  const second = await toolbox.execute('write_file', { path: 'docs/note.txt', content: 'second', expected_sha256: first.sha256.toUpperCase() });
  assert.equal(second.created, false);
  assert.equal(await readFile(path.join(workspace, 'docs/note.txt'), 'utf8'), 'second');
  await assert.rejects(toolbox.execute('write_file', { path: 'missing.txt', content: 'x', expected_sha256: first.sha256 }), /does not exist/);
  await assert.rejects(toolbox.execute('write_file', { path: 'large.txt', content: '中'.repeat(20) }), /byte limit/);
  assert.equal((await readdir(path.join(workspace, 'docs'))).some((name) => name.startsWith('.feather-write-')), false);
});

test('replacement preserves ordinary executable permissions on POSIX', { skip: process.platform === 'win32' }, async (t) => {
  const { toolbox, workspace } = await fixture(t, { allowWrite: true });
  const file = path.join(workspace, 'task.sh');
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o750);
  const current = await toolbox.execute('read_file', { path: 'task.sh' });
  await toolbox.execute('write_file', { path: 'task.sh', content: '#!/bin/sh\nexit 1\n', expected_sha256: current.sha256 });
  assert.equal((await stat(file)).mode & 0o777, 0o750);
});

test('binary existing files cannot be overwritten as text', async (t) => {
  const { toolbox, workspace } = await fixture(t, { allowWrite: true });
  const bytes = Buffer.from([0, 1, 2]);
  await writeFile(path.join(workspace, 'binary'), bytes);
  await assert.rejects(toolbox.execute('write_file', { path: 'binary', content: 'text', expected_sha256: sha(bytes) }), /Binary/);
  assert.deepEqual(await readFile(path.join(workspace, 'binary')), bytes);
});

test('listing and literal search hide internal paths and environment credential files', async (t) => {
  const { toolbox, workspace } = await fixture(t);
  await mkdir(path.join(workspace, 'docs'));
  await mkdir(path.join(workspace, '.git'));
  await mkdir(path.join(workspace, 'node_modules'));
  await writeFile(path.join(workspace, 'docs/a.txt'), 'needle one\nNeedle two\n');
  await writeFile(path.join(workspace, '.env'), 'needle secret');
  await writeFile(path.join(workspace, '.env.local'), 'needle secret');
  await writeFile(path.join(workspace, '.env.example'), 'EXAMPLE=ok');
  await writeFile(path.join(workspace, '.git/config'), 'needle secret');
  await writeFile(path.join(workspace, 'node_modules/code'), 'needle dependency');
  const listing = await toolbox.execute('list_files', { recursive: true });
  assert.ok(listing.entries.some((entry) => entry.path === '.env.example'));
  assert.ok(listing.entries.every((entry) => !['.env', '.env.local', '.git', 'node_modules'].includes(entry.path)));
  const small = await toolbox.execute('list_files', { recursive: true, max_entries: 1 });
  assert.equal(small.entries.length, 1);
  assert.equal(small.truncated, true);
  const result = await toolbox.execute('search_files', { query: 'needle', case_sensitive: false, max_matches: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, 'docs/a.txt');
  assert.equal(result.truncated, true);
  const exact = await toolbox.execute('search_files', { query: 'Needle', path: 'docs/a.txt' });
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0].line, 2);
});

test('listing and search enforce a serialized output limit', async (t) => {
  const { toolbox, workspace } = await fixture(t, { maxOutputChars: 512 });
  for (let index = 0; index < 30; index++) await writeFile(path.join(workspace, String(index).padStart(2, '0') + '-long-file-name.txt'), 'needle ' + 'z'.repeat(400));
  const listing = await toolbox.execute('list_files', { recursive: true, max_entries: 500 });
  const search = await toolbox.execute('search_files', { query: 'needle', max_matches: 200 });
  assert.ok(JSON.stringify(listing).length <= 512);
  assert.ok(JSON.stringify(search).length <= 512);
  assert.ok(search.matches.length > 0, 'a bounded excerpt should keep a matching line visible');
  assert.equal(listing.truncated, true);
  assert.equal(search.truncated, true);
});

test('runtime argument checks and cancellation are enforced', async (t) => {
  const { toolbox } = await fixture(t, { allowWrite: true });
  for (const args of [null, [], { path: 'a', extra: true }, { path: 3 }, { path: 'a', start_line: 0 }, { path: 'a', max_lines: 1.5 }]) await assert.rejects(toolbox.execute('read_file', args));
  await assert.rejects(toolbox.execute('search_files', { query: '' }));
  await assert.rejects(toolbox.execute('list_files', { recursive: 'yes' }));
  await assert.rejects(toolbox.execute('write_file', { path: 'x', content: 'x', expected_sha256: 'invalid' }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(toolbox.execute('list_files', {}, { signal: controller.signal }), /abort|cancel/i);
});
