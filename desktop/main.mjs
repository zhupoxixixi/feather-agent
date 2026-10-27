import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createDesktopService } from './service.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const index = pathToFileURL(path.join(directory, 'index.html')).href;
const smoke = process.argv.includes('--smoke-test');
let window;
let service;
let quitting = false;
let smokeStage = 'loading-main';
const smokeDeadline = smoke ? setTimeout(() => {
  console.error('GUI_SMOKE_TIMEOUT ' + smokeStage);
  app.exit(1);
}, 60000) : null;
function traceSmoke(stage) { smokeStage = stage; if (smoke) console.log('GUI_SMOKE_STAGE ' + stage); }
process.on('uncaughtException', (error) => {
  console.error('MAIN_UNCAUGHT ' + String(error?.stack || error));
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('MAIN_REJECTED ' + String(error?.stack || error));
  app.exit(1);
});
async function encryptionAvailable() {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  return typeof safeStorage.isAsyncEncryptionAvailable === 'function' ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
}
async function decryptCredential(buffer) {
  if (typeof safeStorage.decryptStringAsync !== 'function') return safeStorage.decryptString(buffer);
  let decoded = await safeStorage.decryptStringAsync(buffer);
  if (decoded.shouldReEncrypt) decoded = await safeStorage.decryptStringAsync(buffer);
  if (typeof decoded.result !== 'string') throw new Error('无法解密已保存的密钥');
  return decoded.result;
}
async function bootstrap() {
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  traceSmoke('waiting-for-app-ready');
  await app.whenReady();
  traceSmoke('app-ready');
  const dataDir = smoke ? await mkdtemp(path.join(tmpdir(), 'feather-ui-smoke-')) : app.getPath('userData');
  traceSmoke('opening-service');
  service = await createDesktopService({
    dataDir,
    onEvent: (value) => { if (window && !window.isDestroyed()) window.webContents.send('feather:event', value); },
    credentialStorage: {
      async encrypt(value) {
        if (!await encryptionAvailable()) throw new Error('系统加密存储不可用，请仅在本次运行中使用密钥。');
        const encrypted = typeof safeStorage.encryptStringAsync === 'function' ? await safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value);
        return encrypted.toString('base64');
      },
      async decrypt(value) {
        if (!await encryptionAvailable()) throw new Error('无法解密已保存的密钥');
        const buffer = Buffer.from(value, 'base64');
        return decryptCredential(buffer);
      },
    },
  });
  function sender(event) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== index) throw new Error('不受信任的页面请求');
  }
  function handle(name, action) {
    ipcMain.handle('feather:' + name, async (event, input) => { sender(event); try { return await action(input); } catch (error) { throw new Error(String(error?.message || '操作失败').slice(0, 2000)); } });
  }
  handle('state', () => service.getState());
  handle('workspace', async () => {
    const current = await service.getState();
    if (current.running) throw new Error('任务运行期间不能切换目录');
    const selection = await dialog.showOpenDialog(window, { title: '选择 Feather 工作目录', properties: ['openDirectory'] });
    if (selection.canceled || !selection.filePaths.length) return null;
    return service.setWorkspace(selection.filePaths[0]);
  });
  handle('settings', (value) => service.saveSettings(value));
  handle('start', (value) => service.start(value));
  handle('cancel', () => service.cancel());
  handle('session', (id) => service.inspectSession(id));
  handle('demo', () => service.demo());
  traceSmoke('creating-window');
  window = new BrowserWindow({
    width: 1180, height: 800, minWidth: 860, minHeight: 640, show: !smoke, title: 'Feather',
    backgroundColor: '#f5f8f7', autoHideMenuBar: true,
    webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== index) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void service.close().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  traceSmoke('loading-window');
  await window.loadFile(path.join(directory, 'index.html'));
  traceSmoke('window-loaded');
  if (smoke) {
    try {
      traceSmoke('credential-roundtrip');
      let secureStorageVerified = false;
      if (await encryptionAvailable()) {
        const cipher = typeof safeStorage.encryptStringAsync === 'function' ? await safeStorage.encryptStringAsync('feather-ci-roundtrip') : safeStorage.encryptString('feather-ci-roundtrip');
        if (await decryptCredential(cipher) !== 'feather-ci-roundtrip') throw new Error('Credential encryption roundtrip failed');
        secureStorageVerified = true;
      }
      traceSmoke('renderer-check');
      const initial = await window.webContents.executeJavaScript('({ready: Boolean(window.feather), noNode: typeof require === "undefined", title: document.title, hasTask: Boolean(document.getElementById("task-input")), hasDemo: Boolean(document.getElementById("demo-button"))})');
      if (!initial.ready || !initial.noNode || !initial.hasTask || !initial.hasDemo) throw new Error('GUI or preload did not load');
      await window.webContents.executeJavaScript('new Promise((resolve,reject) => { const started=Date.now(); const timer=setInterval(() => { const button=document.getElementById("demo-button"); if(button && !button.disabled) {clearInterval(timer);resolve(true);} else if(Date.now()-started>10000) {clearInterval(timer);reject(new Error("GUI not ready"));} },25); })');
      traceSmoke('click-demo');
      await window.webContents.executeJavaScript('document.getElementById("demo-button").click()');
      const started = Date.now();
      let result;
      while (Date.now() - started < 30000) {
        const state = await service.getState();
        if (state.sessions.length && !state.running) { result = await service.waitIdle(); break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!result || result.status !== 'completed' || !result.verified || !result.demo) throw new Error('GUI demo did not complete through IPC');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const rendered = await window.webContents.executeJavaScript('({answer: document.getElementById("answer-output").textContent, status: document.getElementById("status-label").textContent})');
      if (!rendered.answer.includes('350')) throw new Error('GUI did not render the final answer');
      const artifactDir = process.env.FEATHER_SMOKE_ARTIFACTS || path.resolve('smoke-artifacts');
      await mkdir(artifactDir, { recursive: true });
      traceSmoke('capture-window');
      const screenshot = await window.webContents.capturePage();
      await writeFile(path.join(artifactDir, 'feather-desktop.png'), screenshot.toPNG());
      await writeFile(path.join(artifactDir, 'gui-smoke.json'), JSON.stringify({ passed: true, isolatedRenderer: initial.noNode, secureStorageVerified, simulatedModel: true, result, rendered }, null, 2));
      console.log('GUI_SMOKE_PASS ' + JSON.stringify({ sessionId: result.sessionId, verified: result.verified }));
      clearTimeout(smokeDeadline);
      await service.close();
      app.exit(0);
    } catch (error) {
      clearTimeout(smokeDeadline);
      console.error('GUI_SMOKE_FAIL ' + String(error?.message || error));
      await service.close().catch(() => {});
      app.exit(1);
    }
  }
}

}
void bootstrap().catch((error) => {
  console.error('MAIN_STARTUP_FAILED ' + String(error?.stack || error));
  app.exit(1);
});
