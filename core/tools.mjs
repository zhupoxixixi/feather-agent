import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const INTERNAL = new Set(['.git', '.feather', 'node_modules']);
const MAX_SCAN = 2000;
const MAX_DEPTH = 12;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const integer = (description, maximum) => ({ type: 'integer', description, minimum: 1, maximum });
const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Operation cancelled', 'AbortError');
}

function hidden(name) {
  const lower = name.toLowerCase();
  return INTERNAL.has(lower) || lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example');
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(name + ' is outside its supported range');
}

function relativePath(value, allowRoot = false) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\0') || value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Use a workspace-relative path with forward slashes');
  const parts = value.split('/').filter((part) => part && part !== '.');
  for (const part of parts) {
    if (part === '..' || hidden(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('Path traversal, protected paths and Windows device names are not allowed');
  }
  if (!parts.length && !allowRoot) throw new Error('A file path is required');
  return parts.join('/');
}

async function checkedPath(root, value, { allowRoot = false, missing = false } = {}) {
  const relative = relativePath(value, allowRoot);
  const parts = relative ? relative.split('/') : [];
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT' && missing) break; throw error; }
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not accessible through task tools');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
  }
  return { absolute: path.join(root, ...parts), relative: relative || '.' };
}

async function readBytes(filename, limit, signal) {
  checkAbort(signal);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Path is not a regular file');
    if (before.size > limit) throw new Error('File exceeds the byte limit');
    const bytes = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let used = 0;
    while (used < bytes.length) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used > limit) throw new Error('File exceeds the byte limit');
    if (after.size !== used || after.mtimeMs !== before.mtimeMs) throw new Error('File changed during reading; read it again');
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

function decode(bytes) {
  if (bytes.includes(0)) throw new Error('Binary files are unsupported');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('File must contain valid UTF-8 text'); }
}

function lineParts(text) { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }

function validate(args, spec) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(spec.properties, name)) throw new TypeError('Unknown argument: ' + name);
    const value = args[name];
    const rule = spec.properties[name];
    if (rule.type === 'string') {
      if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(name + ' must be a string without NUL');
      if (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 1000000)) throw new TypeError(name + ' is outside the string length limit');
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) throw new TypeError(name + ' has an invalid format');
    } else if (rule.type === 'integer') boundedInteger(value, name, rule.minimum, rule.maximum);
    else if (rule.type === 'boolean' && typeof value !== 'boolean') throw new TypeError(name + ' must be boolean');
  }
  for (const name of spec.required) if (!Object.hasOwn(args, name)) throw new TypeError('Missing argument: ' + name);
}

function fits(result, limit) { return JSON.stringify(result).length <= limit; }

function boundedText(result, limit) {
  let content = result.content;
  if (content.length > limit) { content = content.slice(0, limit); result.truncated = true; }
  result.content = content;
  while (!fits(result, limit) && result.content.length) {
    result.content = result.content.slice(0, Math.max(0, result.content.length - Math.max(1, JSON.stringify(result).length - limit)));
    result.truncated = true;
  }
  if (!fits(result, limit)) throw new Error('Output metadata exceeds the configured limit');
  return result;
}

async function scan(root, start, recursive, signal) {
  const pending = [{ relative: start.relative === '.' ? '' : start.relative, depth: 0 }];
  const entries = [];
  let examined = 0;
  let truncated = false;
  while (pending.length && examined < MAX_SCAN) {
    checkAbort(signal);
    const item = pending.shift();
    const directory = await checkedPath(root, item.relative, { allowRoot: true });
    const children = [];
    const handle = await opendir(directory.absolute);
    try {
      for await (const entry of handle) {
        checkAbort(signal);
        if (++examined > MAX_SCAN) { truncated = true; break; }
        if (!hidden(entry.name)) children.push(entry);
      }
    } finally { await handle.close().catch(() => {}); }
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      const relative = item.relative ? item.relative + '/' + child.name : child.name;
      const type = child.isSymbolicLink() ? 'symlink' : child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other';
      entries.push({ path: relative, type });
      if (recursive && type === 'directory') {
        if (item.depth < MAX_DEPTH) pending.push({ relative, depth: item.depth + 1 });
        else truncated = true;
      }
    }
  }
  return { entries, scanned_entries: Math.min(examined, MAX_SCAN), truncated: truncated || pending.length > 0 };
}

/** Workspace checks are not an OS sandbox against hostile concurrent directory swaps. */
export async function createToolbox({ workspace, allowWrite = false, maxFileBytes = 1048576, maxOutputChars = 12000 } = {}) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
  if (typeof allowWrite !== 'boolean') throw new TypeError('allowWrite must be boolean');
  boundedInteger(maxFileBytes, 'maxFileBytes', 1, 16777216);
  boundedInteger(maxOutputChars, 'maxOutputChars', 512, 1000000);
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  const filePath = string('Workspace-relative path using forward slashes. Protected paths and symlinks are rejected.', { maxLength: 2048 });
  const definitions = [
    { name: 'list_files', description: 'List a bounded workspace directory. Internal directories and environment credential files are hidden; symlinks are never followed.', parameters: objectSchema({ path: filePath, recursive: { type: 'boolean' }, max_entries: integer('Maximum returned entries; default 100.', 500) }) },
    { name: 'read_file', description: 'Read bounded UTF-8 text and return the complete file SHA-256 for checked replacement. start_line is 1-based; default max_lines is 200.', parameters: objectSchema({ path: filePath, start_line: integer('First line.', 1000000), max_lines: integer('Maximum returned lines.', 500) }, ['path']) },
    { name: 'search_files', description: 'Search literal text in bounded UTF-8 workspace files. Skips binary, oversized and protected files; not a regex search.', parameters: objectSchema({ query: string('Literal nonempty search text.', { minLength: 1, maxLength: 400 }), path: filePath, case_sensitive: { type: 'boolean' }, max_matches: integer('Maximum matches; default 30.', 200) }, ['query']) },
  ];
  if (allowWrite) definitions.push({ name: 'write_file', description: 'Create or atomically replace a UTF-8 file. Existing files require expected_sha256 from a recent read_file. Parent directories may be created.', parameters: objectSchema({ path: filePath, content: string('Complete replacement content.', { maxLength: maxFileBytes }), expected_sha256: string('Required for existing files.', { pattern: '^[a-fA-F0-9]{64}$', maxLength: 64 }) }, ['path', 'content']) });
  const registry = new Map(definitions.map((definition) => [definition.name, definition]));

  async function execute(name, args, { signal } = {}) {
    checkAbort(signal);
    const definition = registry.get(name);
    if (!definition) throw new Error('Unknown or disabled tool: ' + name);
    validate(args, definition.parameters);
    if (name === 'list_files') {
      const start = await checkedPath(root, args.path ?? '', { allowRoot: true });
      const all = await scan(root, start, args.recursive ?? false, signal);
      const result = { path: start.relative, entries: [], scanned_entries: all.scanned_entries, truncated: all.truncated };
      for (const entry of all.entries) {
        if (result.entries.length >= (args.max_entries ?? 100)) { result.truncated = true; break; }
        result.entries.push(entry);
        if (!fits(result, maxOutputChars)) { result.entries.pop(); result.truncated = true; break; }
      }
      if (!fits(result, maxOutputChars)) throw new Error('Output metadata exceeds the configured limit');
      return result;
    }
    if (name === 'read_file') {
      const file = await checkedPath(root, args.path);
      const bytes = await readBytes(file.absolute, maxFileBytes, signal);
      const all = lineParts(decode(bytes));
      const start = args.start_line ?? 1;
      const selected = all.slice(start - 1, start - 1 + (args.max_lines ?? 200));
      return boundedText({ path: file.relative, sha256: hash(bytes), bytes: bytes.length, content: selected.join(''), start_line: start, end_line: selected.length ? start + selected.length - 1 : start - 1, total_lines: all.length, truncated: start > 1 || start - 1 + selected.length < all.length }, maxOutputChars);
    }
    if (name === 'search_files') {
      const start = await checkedPath(root, args.path ?? '', { allowRoot: true });
      const info = await lstat(start.absolute);
      const files = info.isDirectory() ? await scan(root, start, true, signal) : { entries: [{ path: start.relative, type: 'file' }], truncated: false };
      const result = { matches: [], scanned_files: 0, skipped_files: 0, truncated: files.truncated };
      const query = args.case_sensitive === false ? args.query.toLowerCase() : args.query;
      let bytesRead = 0;
      outer: for (const entry of files.entries) {
        if (entry.type !== 'file') continue;
        checkAbort(signal);
        if (result.scanned_files >= 500 || bytesRead >= 8 * maxFileBytes) { result.truncated = true; break; }
        let content;
        try {
          const file = await checkedPath(root, entry.path);
          const bytes = await readBytes(file.absolute, maxFileBytes, signal);
          bytesRead += bytes.length;
          content = decode(bytes);
        } catch { checkAbort(signal); result.skipped_files++; continue; }
        result.scanned_files++;
        const rows = lineParts(content);
        for (let index = 0; index < rows.length; index++) {
          const line = rows[index].replace(/\r?\n$/, '');
          const candidate = args.case_sensitive === false ? line.toLowerCase() : line;
          const position = candidate.indexOf(query);
          if (position < 0) continue;
          if (result.matches.length >= (args.max_matches ?? 30)) { result.truncated = true; break outer; }
          const offset = Math.max(0, position - 100);
          const excerpt = line.slice(offset, offset + 500);
          result.matches.push({ path: entry.path, line: index + 1, content: excerpt, truncated: offset > 0 || offset + excerpt.length < line.length });
          if (!fits(result, maxOutputChars)) {
            const match = result.matches.at(-1);
            while (!fits(result, maxOutputChars) && match.content.length) {
              match.content = match.content.slice(0, Math.max(0, match.content.length - Math.max(1, JSON.stringify(result).length - maxOutputChars)));
              match.truncated = true;
            }
            if (!fits(result, maxOutputChars)) result.matches.pop();
            result.truncated = true;
            break outer;
          }
        }
      }
      if (!fits(result, maxOutputChars)) throw new Error('Output metadata exceeds the configured limit');
      return result;
    }
    if (name === 'write_file') {
      if (!allowWrite) throw new Error('Writes are disabled');
      const bytes = Buffer.from(args.content, 'utf8');
      if (bytes.length > maxFileBytes) throw new Error('File exceeds the byte limit');
      const file = await checkedPath(root, args.path, { missing: true });
      let previous;
      try { previous = await readBytes(file.absolute, maxFileBytes, signal); decode(previous); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous !== undefined && (!args.expected_sha256 || hash(previous) !== args.expected_sha256.toLowerCase())) throw new Error('Existing file requires matching expected_sha256 from read_file');
      if (previous === undefined && args.expected_sha256) throw new Error('expected_sha256 was supplied but the file does not exist');
      const mode = previous === undefined ? 0o600 : (await lstat(file.absolute)).mode & 0o777;
      let parent = root;
      for (const part of file.relative.split('/').slice(0, -1)) {
        parent = path.join(parent, part);
        try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Parent directories must be ordinary workspace directories');
      }
      await checkedPath(root, args.path, { missing: true });
      checkAbort(signal);
      const temporary = path.join(parent, '.feather-write-' + randomUUID() + '.tmp');
      let handle;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(bytes);
        await handle.chmod(mode);
        await handle.sync();
        await handle.close(); handle = undefined;
        checkAbort(signal);
        await checkedPath(root, args.path, { missing: true });
        let current;
        try { current = await readBytes(file.absolute, maxFileBytes, signal); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous === undefined ? current !== undefined : current === undefined || hash(current) !== hash(previous)) throw new Error('File changed before replacement; read it again');
        await rename(temporary, file.absolute);
      } finally {
        await handle?.close();
        await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      const result = { path: file.relative, bytes: bytes.length, sha256: hash(bytes), created: previous === undefined };
      if (!fits(result, maxOutputChars)) return { bytes: bytes.length, sha256: hash(bytes), created: previous === undefined, path_omitted: true };
      return result;
    }
    throw new Error('Unknown tool');
  }
  return { workspace: root, definitions, execute };
}
