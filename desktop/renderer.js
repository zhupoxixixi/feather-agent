'use strict';

(() => {
  const api = window.feather;
  const byId = (id) => document.getElementById(id);
  const el = {
    task: byId('task-input'), run: byId('run-button'), cancel: byId('cancel-button'),
    demo: byId('demo-button'), status: byId('status-label'), pill: byId('status-pill'),
    answer: byId('answer-output'), error: byId('error-banner'), sessions: byId('session-list'),
    newSession: byId('new-session-button'), refresh: byId('refresh-button'),
    choose: byId('choose-workspace-button'), workspace: byId('workspace-path'),
    caption: byId('session-caption'), counter: byId('task-counter'),
    allowWrite: byId('allow-write'), permission: byId('permission-note'),
    settings: byId('model-settings'), settingsForm: byId('settings-form'),
    provider: byId('provider-input'), model: byId('model-input'), baseUrl: byId('base-url-input'),
    key: byId('api-key-input'), remember: byId('remember-key'), keyState: byId('key-state'),
    save: byId('save-settings-button'), settingsMessage: byId('settings-message'),
    configState: byId('config-state'), resultMeta: byId('result-meta'),
    activity: byId('activity-list'), activityCount: byId('activity-count'), activityPanel: byId('activity-panel')
  };
  const defaults = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };
  const statusLabels = {
    ready: '就绪', running: '运行中', completed: '已完成', cancelled: '已停止',
    error: '执行失败', budget_exhausted: '达到执行预算'
  };
  const toolLabels = {
    list_files: '查看文件目录', read_file: '读取文件', search_files: '搜索文件内容', write_file: '写入文件'
  };
  let initialized = false;
  let running = false;
  let pending = false;
  let cancelling = false;
  let dirty = false;
  let selectedSession = null;
  let workspace = null;
  let savedSettings = {};
  let sessions = [];
  let sequence = 0;
  let terminalSequence = -1;
  let unsubscribe;

  function showError(error) {
    el.error.textContent = String(error && error.message ? error.message : error || '操作未能完成，请重试。').slice(0, 3000);
    el.error.hidden = false;
  }
  function clearError() { el.error.textContent = ''; el.error.hidden = true; }
  function setStatus(status, text) {
    el.status.textContent = text || statusLabels[status] || status;
    el.pill.dataset.status = status;
  }
  function updateControls() {
    const blocked = !initialized || running || pending;
    el.run.disabled = blocked;
    el.demo.disabled = blocked;
    el.choose.disabled = blocked;
    el.newSession.disabled = blocked;
    el.refresh.disabled = !initialized || pending;
    el.save.disabled = blocked;
    el.task.disabled = running || pending;
    el.allowWrite.disabled = running || pending;
    for (const input of [el.provider, el.model, el.baseUrl, el.key, el.remember]) input.disabled = blocked;
    for (const button of document.querySelectorAll('.example-task')) button.disabled = blocked;
    for (const button of el.sessions.querySelectorAll('button')) button.disabled = running || pending;
    el.cancel.disabled = !initialized || !running || pending || cancelling;
    el.cancel.textContent = cancelling ? '正在停止…' : '停止任务';
    el.run.textContent = running ? '任务执行中…' : '开始任务';
  }
  function setRunning(value) { running = Boolean(value); updateControls(); }
  function updateWorkspace(value) {
    workspace = value || null;
    el.workspace.textContent = workspace || '尚未选择目录';
    el.workspace.title = workspace || '';
  }
  function updatePermission() {
    el.permission.textContent = el.allowWrite.checked ? '可修改文件' : '只读模式';
    el.permission.classList.toggle('writable', el.allowWrite.checked);
  }
  function updateKeyState() {
    el.keyState.textContent = savedSettings.hasKey ? '已配置 · 留空可保留' : '尚未配置 · 本地服务可留空';
    el.configState.textContent = el.model.value.trim() ? '已选择模型' : '待设置';
  }
  function applySettings(value, force) {
    savedSettings = value || {};
    if (force || !dirty) {
      el.provider.value = savedSettings.provider === 'anthropic' ? 'anthropic' : 'openai';
      el.model.value = savedSettings.model || '';
      el.baseUrl.value = savedSettings.baseUrl || defaults[el.provider.value];
      el.remember.checked = Boolean(savedSettings.rememberKey);
    }
    updateKeyState();
  }
  function dateLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  function renderSessions() {
    el.sessions.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'session-empty';
      const title = document.createElement('strong');
      title.textContent = '还没有会话';
      const subtitle = document.createElement('span');
      subtitle.textContent = '开始任务后，会自动保存在这里。';
      empty.append(title, subtitle);
      el.sessions.append(empty);
      return;
    }
    for (const session of sessions.slice(0, 100)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-item';
      button.classList.toggle('active', session.id === selectedSession);
      button.disabled = running || pending;
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = String(session.title || '未命名会话').slice(0, 160);
      button.title = title.textContent;
      const meta = document.createElement('span');
      meta.className = 'session-meta';
      const date = document.createElement('span');
      date.textContent = dateLabel(session.updatedAt);
      const state = document.createElement('span');
      state.textContent = statusLabels[session.status] || '会话';
      meta.append(date, state);
      button.append(title, meta);
      button.addEventListener('click', () => selectSession(session.id));
      el.sessions.append(button);
    }
  }
  async function refreshState(forceSettings) {
    const state = await api.getState();
    if (!state || typeof state !== 'object') throw new Error('无法读取应用状态。');
    sessions = Array.isArray(state.sessions) ? state.sessions : [];
    updateWorkspace(state.workspace);
    applySettings(state.settings, Boolean(forceSettings));
    renderSessions();
    return state;
  }
  function setAnswer(text, empty) {
    el.answer.textContent = String(text || '').slice(0, 240000);
    el.answer.classList.toggle('empty-answer', Boolean(empty));
  }
  function clearActivity() {
    el.activity.replaceChildren();
    el.activityCount.textContent = '0 条';
  }
  function addActivity(text) {
    if (!text) return;
    const row = document.createElement('li');
    row.className = 'activity-item';
    const timestamp = document.createElement('span');
    timestamp.className = 'activity-time';
    timestamp.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const message = document.createElement('span');
    message.textContent = String(text).slice(0, 1200);
    row.append(timestamp, message);
    el.activity.append(row);
    while (el.activity.children.length > 160) el.activity.firstElementChild.remove();
    el.activityCount.textContent = el.activity.children.length + ' 条';
    el.activity.scrollTop = el.activity.scrollHeight;
  }
  function progressText(event) {
    if (!event || typeof event !== 'object') return '';
    const type = String(event.type || '');
    const name = String(event.name || event.tool || '');
    const tool = toolLabels[name] || (name ? '调用工具 ' + name : '调用工具');
    if (type === 'model' || type === 'model_start') return '正在思考' + (event.step ? ' · 第 ' + event.step + ' 步' : '');
    if (type === 'tool' || type === 'tool_start') return '正在' + tool;
    if (type === 'result' || type === 'tool_result') return (event.ok === false ? '工具未能完成：' : '已完成：') + tool;
    if (type === 'model_result') return event.toolCallCount ? '已规划下一步操作' : '正在整理答复';
    if (type === 'run_start') return '任务已开始';
    if (type === 'recovered_pending_tools') return '已恢复会话；中断的操作不会自动重放';
    if (type === 'run_end' || type === 'done') return '';
    return typeof event.text === 'string' ? event.text : typeof event.message === 'string' ? event.message : '';
  }
  function resultMetadata(result) {
    const parts = [];
    if (Number.isFinite(result.steps)) parts.push(result.steps + ' 步');
    if (Number.isFinite(result.toolCalls)) parts.push(result.toolCalls + ' 次工具调用');
    return parts.join(' · ') || statusLabels[result.status] || '任务结束';
  }
  async function receiveEvent(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'progress') {
      addActivity(progressText(message.event));
      return;
    }
    if (message.type !== 'complete' && message.type !== 'error') return;
    const completedSequence = sequence;
    terminalSequence = completedSequence;
    cancelling = false;
    pending = false;
    setRunning(false);
    if (message.result && typeof message.result === 'object') {
      const result = message.result;
      selectedSession = result.sessionId || selectedSession;
      const status = result.status || (message.type === 'error' ? 'error' : 'completed');
      setStatus(status);
      setAnswer(result.answer || message.message || '任务已结束。', false);
      el.resultMeta.textContent = resultMetadata(result);
      addActivity(statusLabels[status] || '任务结束');
      if (status === 'error') showError(result.answer || message.message || '任务执行失败。');
    } else {
      setStatus('error');
      showError(message.message || '任务未能完成。');
      setAnswer(message.message || '任务执行失败，请查看上方提示。', false);
      el.resultMeta.textContent = '执行失败';
    }
    try {
      await refreshState(false);
      if (completedSequence !== sequence) return;
      const current = sessions.find((session) => session.id === selectedSession);
      el.caption.textContent = current ? String(current.title || '当前会话').slice(0, 60) : '当前会话';
    } catch (error) { showError(error); }
  }
  function settingsInput() {
    return {
      provider: el.provider.value,
      model: el.model.value.trim(),
      baseUrl: el.baseUrl.value.trim() || defaults[el.provider.value],
      apiKey: el.key.value,
      rememberKey: el.remember.checked
    };
  }
  async function saveSettings() {
    const settings = await api.saveSettings(settingsInput());
    el.key.value = '';
    dirty = false;
    applySettings(settings, true);
    el.settingsMessage.textContent = settings.rememberKey ? '设置已保存，密钥由系统加密保管。' : '设置已保存，密钥仅在本次打开期间使用。';
    el.settingsMessage.classList.add('success');
    return settings;
  }
  async function saveFromForm(event) {
    event.preventDefault();
    if (running || pending) return;
    clearError();
    pending = true;
    updateControls();
    try { await saveSettings(); }
    catch (error) { showError(error); }
    finally { pending = false; updateControls(); }
  }
  async function startTask(demo) {
    if (!initialized || running || pending) return;
    clearError();
    const task = el.task.value.trim();
    if (!demo && !task) { showError('先写下你想完成的任务。'); el.task.focus(); return; }
    if (!demo && !el.model.value.trim()) {
      showError('请先在模型设置中填写模型名称。也可以使用无需密钥的演示。');
      el.settings.open = true;
      el.model.focus();
      return;
    }
    if (!demo && !workspace) { showError('请先选择一个工作目录。'); return; }
    const requestSequence = ++sequence;
    pending = true;
    setRunning(true);
    setStatus('running', demo ? '演示运行中' : '运行中');
    setAnswer(demo ? '正在新建示例目录并运行完整演示…' : 'Feather 正在处理任务，执行进度会显示在下方。', true);
    el.resultMeta.textContent = demo ? '模拟模型 · 不调用 API' : '正在处理';
    clearActivity();
    el.activityPanel.open = true;
    addActivity(demo ? '运行模拟模型演示，不调用外部模型 API' : '准备执行任务');
    try {
      let result;
      if (demo) result = await api.demo();
      else {
        await saveSettings();
        result = await api.start({ task, sessionId: selectedSession, allowWrite: el.allowWrite.checked });
      }
      if (requestSequence !== sequence) return;
      selectedSession = result.sessionId || selectedSession;
      el.caption.textContent = demo ? '示例会话' : '当前会话';
      renderSessions();
      if (terminalSequence !== requestSequence) setRunning(true);
    } catch (error) {
      if (requestSequence === sequence) {
        setRunning(false);
        setStatus('error');
        showError(error);
        setAnswer('任务尚未开始，请按上方提示检查配置后重试。', true);
        el.resultMeta.textContent = '未开始';
      }
    } finally {
      if (requestSequence === sequence) { pending = false; updateControls(); }
    }
  }
  async function cancelTask() {
    if (!running || pending || cancelling) return;
    cancelling = true;
    updateControls();
    try {
      const result = await api.cancel();
      if (result.cancelled && running) {
        setStatus('running', '正在停止');
        addActivity('已请求停止，正在结束当前操作');
      } else if (running) {
        const state = await refreshState(false);
        setRunning(Boolean(state.running));
        if (!state.running) setStatus('ready');
      }
    } catch (error) { showError(error); }
    finally { cancelling = false; updateControls(); }
  }
  async function chooseWorkspace() {
    if (running || pending) return;
    clearError();
    pending = true;
    updateControls();
    try {
      const chosen = await api.chooseWorkspace();
      if (chosen) {
        updateWorkspace(chosen);
        selectedSession = null;
        el.caption.textContent = '新会话';
        renderSessions();
      }
    } catch (error) { showError(error); }
    finally { pending = false; updateControls(); }
  }
  async function selectSession(id) {
    if (running || pending) return;
    clearError();
    pending = true;
    updateControls();
    try {
      const session = await api.inspectSession(id);
      selectedSession = session.id;
      el.task.value = '';
      el.counter.textContent = '0 / 20000';
      el.allowWrite.checked = false;
      updatePermission();
      el.caption.textContent = String(session.title || '历史会话').slice(0, 60);
      clearActivity();
      const messages = Array.isArray(session.messages) ? session.messages : [];
      const lastRun = session.lastRun && typeof session.lastRun === 'object' ? session.lastRun : null;
      const hasLastRunAnswer = typeof lastRun?.answer === 'string';
      // Cancelled, failed, or budget-limited runs may have no final assistant message.
      let answer = hasLastRunAnswer ? lastRun.answer : '';
      if (!hasLastRunAnswer) {
        for (let index = messages.length - 1; index >= 0; index--) {
          const message = messages[index];
          if (message.role === 'assistant' && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) && typeof message.content === 'string' && message.content.trim()) { answer = message.content; break; }
        }
      }
      setAnswer(answer || '该会话尚无最终答复。输入新的任务可继续处理。', !answer);
      el.resultMeta.textContent = hasLastRunAnswer ? resultMetadata(lastRun) : '已打开历史会话';
      setStatus(session.status || 'ready');
      for (const message of messages.slice(-50)) {
        if (message.role === 'user') addActivity('用户任务：' + String(message.content || '').slice(0, 220));
        else if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls) addActivity('工具请求：' + (toolLabels[call.function && call.function.name] || (call.function && call.function.name) || '工具'));
        } else if (message.role === 'tool') addActivity('已记录工具结果');
      }
      await refreshState(false);
    } catch (error) { showError(error); }
    finally { pending = false; updateControls(); }
  }
  function newSession() {
    if (running || pending) return;
    sequence++;
    selectedSession = null;
    clearError();
    el.task.value = '';
    el.counter.textContent = '0 / 20000';
    el.caption.textContent = '新会话';
    el.resultMeta.textContent = '等待开始';
    el.allowWrite.checked = false;
    updatePermission();
    setAnswer('完成后的答复会显示在这里。', true);
    clearActivity();
    setStatus('ready');
    renderSessions();
    el.task.focus();
  }
  function bind() {
    el.run.addEventListener('click', () => startTask(false));
    el.demo.addEventListener('click', () => startTask(true));
    el.cancel.addEventListener('click', cancelTask);
    el.choose.addEventListener('click', chooseWorkspace);
    el.newSession.addEventListener('click', newSession);
    el.settingsForm.addEventListener('submit', saveFromForm);
    el.refresh.addEventListener('click', async () => {
      if (pending) return;
      try { await refreshState(false); }
      catch (error) { showError(error); }
    });
    el.task.addEventListener('input', () => { el.counter.textContent = el.task.value.length + ' / 20000'; });
    el.task.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); startTask(false); }
    });
    el.allowWrite.addEventListener('change', updatePermission);
    for (const input of [el.provider, el.model, el.baseUrl, el.key, el.remember]) {
      input.addEventListener('input', () => {
        dirty = true;
        el.settingsMessage.classList.remove('success');
        updateKeyState();
      });
    }
    el.provider.addEventListener('change', () => {
      dirty = true;
      if (!el.baseUrl.value.trim() || Object.values(defaults).includes(el.baseUrl.value.trim())) el.baseUrl.value = defaults[el.provider.value];
      updateKeyState();
    });
    for (const button of document.querySelectorAll('.example-task')) {
      button.addEventListener('click', () => {
        if (running || pending) return;
        el.task.value = button.dataset.example || '';
        el.counter.textContent = el.task.value.length + ' / 20000';
        el.task.focus();
      });
    }
  }
  async function initialize() {
    bind();
    if (!api || typeof api.getState !== 'function' || typeof api.onEvent !== 'function') {
      setStatus('error', '未连接');
      showError('应用服务未能启动。请关闭窗口后重新打开 Feather。');
      return;
    }
    try {
      unsubscribe = api.onEvent((event) => { receiveEvent(event).catch(showError); });
      const state = await refreshState(true);
      initialized = true;
      setRunning(Boolean(state.running));
      setStatus(state.running ? 'running' : 'ready');
      if (!savedSettings.model) el.settings.open = true;
      updateControls();
    } catch (error) { setStatus('error'); showError(error); }
  }
  window.addEventListener('beforeunload', () => { if (typeof unsubscribe === 'function') unsubscribe(); });
  initialize().catch(showError);
})();
