import path from 'node:path';
import { mkdir, readFile, writeFile, realpath, stat, lstat, rename, open, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createProvider } from '../core/providers.mjs';
import { createToolbox } from '../core/tools.mjs';
import { runAgent } from '../core/agent.mjs';
import { openSession, readSession, listSessions } from '../core/sessions.mjs';

const DEFAULTS = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', rememberKey: false };
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function message(error) { return String(error?.message || '操作失败').slice(0, 2000); }
export function validateSettings(value) {
  if (!object(value)) throw new Error('设置格式无效');
  const allowed = new Set(['provider', 'baseUrl', 'model', 'apiKey', 'rememberKey']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('设置包含未知字段');
  const provider = value.provider ?? 'openai';
  const model = value.model ?? '';
  const apiKey = value.apiKey ?? '';
  const baseUrl = value.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : DEFAULTS.baseUrl);
  if (!['openai', 'anthropic'].includes(provider) || typeof model !== 'string' || model.length > 256 || typeof apiKey !== 'string' || apiKey.length > 8192 || typeof baseUrl !== 'string' || baseUrl.length > 2048 || /[\r\n\0]/.test(model + apiKey + baseUrl) || typeof value.rememberKey !== 'boolean') throw new Error('模型设置格式无效');
  createProvider({ type: provider, baseUrl, model: model || 'configuration-check', apiKey });
  return { provider, baseUrl, model: model.trim(), rememberKey: value.rememberKey, apiKey };
}

export async function createDesktopService({ dataDir, onEvent = () => {}, credentialStorage } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await realpath(dataDir);
  const sessionDir = path.join(dataDir, 'sessions');
  const configFile = path.join(dataDir, 'settings.json');
  let settings = { ...DEFAULTS };
  let apiKey = '';
  let workspace = null;
  let active = null;
  let closing = false;
  let lastResult = null;
  const emit = (event) => { try { onEvent(event); } catch {} };
  try {
    const info = await lstat(configFile);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 64000) throw new Error('设置文件无效');
    const stored = JSON.parse(await readFile(configFile, 'utf8'));
    const checked = validateSettings({ provider: stored.provider, baseUrl: stored.baseUrl, model: stored.model, rememberKey: Boolean(stored.rememberKey) });
    settings = { provider: checked.provider, baseUrl: checked.baseUrl, model: checked.model, rememberKey: checked.rememberKey };
    if (settings.rememberKey && typeof stored.encryptedKey === 'string' && credentialStorage) {
      try { const plain = await credentialStorage.decrypt(stored.encryptedKey); if (typeof plain !== 'string' || plain.length > 8192) throw new Error('Invalid stored credential'); apiKey = plain; } catch { apiKey = ''; settings.rememberKey = false; }
    } else settings.rememberKey = false;
  } catch (error) {
    if (error.code !== 'ENOENT') emit({ type: 'error', message: '已忽略无法读取的设置，请重新配置模型。' });
  }
  const publicSettings = () => ({ ...settings, hasKey: Boolean(apiKey) });
  async function projectDirectory(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('请选择项目目录');
    const canonical = await realpath(value);
    if (!(await stat(canonical)).isDirectory()) throw new Error('工作目录不是文件夹');
    const relative = path.relative(canonical, dataDir);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('请选择具体项目文件夹，避免将应用数据目录包含在工作区中。');
    return canonical;
  }
  async function persist(encryptedKey) {
    const temporary = configFile + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...settings, ...(encryptedKey ? { encryptedKey } : {}) }, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, configFile);
  }
  function launch({ task, sessionId, allowWrite, demo = false }) {
    if (active || closing) throw new Error('已有任务正在执行，请先取消或等待完成。');
    if (typeof task !== 'string' || !task.trim() || task.length > 100000 || typeof allowWrite !== 'boolean' || (sessionId !== null && sessionId !== undefined && (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(sessionId)))) throw new Error('任务参数无效');
    const owner = { controller: new AbortController(), promise: null };
    active = owner;
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    owner.promise = (async () => {
      let session;
      let terminal;
      try {
        let target = workspace;
        if (sessionId) target = (await readSession(sessionDir, sessionId)).workspace;
        if (demo) {
          const parent = path.join(dataDir, 'demos');
          await mkdir(parent, { recursive: true });
          target = await mkdtemp(path.join(parent, 'sample-'));
          await writeFile(path.join(target, 'sales.csv'), 'date,channel,amount\n2026-10-01,web,120\n2026-10-02,store,80\n2026-10-03,web,150\n');
        }
        target = await projectDirectory(target);
        let provider;
        if (demo) provider = demoProvider();
        else {
          if (!settings.model) throw new Error('请先填写支持工具调用的模型名称。');
          const host = new URL(settings.baseUrl).hostname;
          const local = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
          if (!apiKey && !local) throw new Error('请先配置模型 API Key。');
          provider = createProvider({ type: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey });
        }
        const toolbox = await createToolbox({ workspace: target, allowWrite });
        session = await openSession({ workspace: toolbox.workspace, sessionDir, sessionId: sessionId || undefined });
        workspace = toolbox.workspace;
        readyResolve({ sessionId: session.state.id, started: true });
        const result = await runAgent({ task, provider, toolbox, session, signal: owner.controller.signal, onEvent: (event) => emit({ type: 'progress', event }) });
        if (demo && result.status === 'completed') {
          const report = await readFile(path.join(workspace, 'report.md'), 'utf8');
          if (!report.includes('350') || !report.includes('web: 270')) throw new Error('演示文件核验失败');
          result.demo = true;
          result.reportPath = path.join(workspace, 'report.md');
          result.verified = true;
        }
        lastResult = result;
        terminal = { type: 'complete', result };
        return result;
      } catch (error) {
        readyReject(new Error(message(error)));
        lastResult = { status: 'error', answer: message(error), sessionId: session?.state?.id ?? null };
        terminal = { type: 'error', message: message(error) };
        return lastResult;
      } finally {
        try { await session?.close(); } finally { if (active === owner) active = null; if (terminal) emit(terminal); }
      }
    })();
    return ready;
  }
  return {
    async getState() { return { settings: publicSettings(), sessions: await listSessions(sessionDir), workspace, running: Boolean(active) }; },
    async setWorkspace(value) {
      if (active) throw new Error('任务运行期间不能切换目录');
      workspace = await projectDirectory(value);
      return workspace;
    },
    async saveSettings(input) {
      if (active) throw new Error('任务运行期间不能更换模型');
      const next = validateSettings(input);
      const changedOrigin = new URL(next.baseUrl).origin !== new URL(settings.baseUrl).origin || next.provider !== settings.provider;
      const nextKey = next.apiKey || (changedOrigin ? '' : apiKey);
      let encryptedKey;
      if (next.rememberKey && nextKey) {
        if (!credentialStorage) throw new Error('系统加密存储不可用，请关闭“记住密钥”，仅在本次运行中使用。');
        encryptedKey = await credentialStorage.encrypt(nextKey);
        if (typeof encryptedKey !== 'string' || !encryptedKey) throw new Error('无法安全保存密钥');
      }
      const previous = settings;
      settings = { provider: next.provider, baseUrl: next.baseUrl, model: next.model, rememberKey: next.rememberKey && Boolean(nextKey) };
      try { await persist(encryptedKey); apiKey = nextKey; } catch (error) { settings = previous; throw error; }
      return publicSettings();
    },
    async inspectSession(id) {
      if (active) throw new Error('请等待当前任务完成');
      const state = await readSession(sessionDir, id);
      workspace = await projectDirectory(state.workspace);
      return state;
    },
    start(input) {
      if (!object(input) || Object.keys(input).some((key) => !['task', 'sessionId', 'allowWrite'].includes(key))) throw new Error('任务参数无效');
      return launch({ ...input, sessionId: input.sessionId ?? null, allowWrite: input.allowWrite ?? false });
    },
    demo() { return launch({ task: '读取 sales.csv，按渠道汇总金额，写入 report.md。说明这是模拟模型演示。', sessionId: null, allowWrite: true, demo: true }); },
    async cancel() { const cancelled = Boolean(active); active?.controller.abort(new DOMException('用户取消任务', 'AbortError')); return { cancelled }; },
    async waitIdle() { return active ? active.promise : lastResult; },
    async close() { closing = true; await this.cancel(); return this.waitIdle(); },
  };
}

function demoProvider() {
  let calls = 0;
  const tool = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  return { async complete({ messages }) {
    calls++;
    let output;
    if (calls === 1) output = tool('demo-read', 'read_file', { path: 'sales.csv' });
    else if (calls === 2) {
      const read = JSON.parse(messages.at(-1).content);
      if (!read.ok) throw new Error('演示读取失败');
      const totals = new Map();
      for (const line of read.result.content.trim().split('\n').slice(1)) { const [, channel, amount] = line.split(','); totals.set(channel, (totals.get(channel) ?? 0) + Number(amount)); }
      const sum = [...totals.values()].reduce((a, b) => a + b, 0);
      const content = '# Sales summary\n\nTotal: ' + sum + '\n\n' + [...totals].map(([name, amount]) => '- ' + name + ': ' + amount).join('\n') + '\n';
      output = tool('demo-write', 'write_file', { path: 'report.md', content });
    } else {
      if (!JSON.parse(messages.at(-1).content).ok) throw new Error('演示写入失败');
      output = { role: 'assistant', content: '演示完成：读取了 sales.csv，按渠道汇总总额 350，并生成 report.md。\n\nweb: 270\nstore: 80\n\n此演示使用确定性的模拟模型，没有调用外部模型 API。' };
    }
    return { message: output, usage: { inputTokens: null, outputTokens: null }, finishReason: output.tool_calls ? 'tool_calls' : 'stop' };
  } };
}
