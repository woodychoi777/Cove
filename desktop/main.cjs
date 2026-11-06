const { app, BrowserWindow, Menu, dialog, shell, utilityProcess, nativeTheme, ipcMain, powerMonitor, powerSaveBlocker } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, appendFileSync, statSync, renameSync } = require('node:fs');
const { join, resolve } = require('node:path');
const http = require('node:http');
const { AlarmScheduler, validate: validateAlarm } = require('./alarm.cjs');
const { WakeSchedule } = require('./wake.cjs');
const { chooseLibrary } = require('./library-location.cjs');
const { setupMediaControls } = require('./media-controls.cjs');
let systemMedia;

app.setName(require('../package.json').productName || 'Cove');
if (process.env.COVE_PROFILE_DIR) app.setPath('userData', resolve(process.env.COVE_PROFILE_DIR));
const root = resolve(__dirname, '..');
let window, service, address, dataDirectory, settings, settingsFile;
let stopping = false, sessionConfigured = false;
let recovery = null;
let alarm, wake, alarmTimer, alarmPower, alarmReady = false, alarmSaving = false, quitting = false, heldAlarmKey = null;
const recoveryTimes = [];
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
async function openAutoImportFolder() {
  const config = readJSON(join(dataDirectory, 'auto-import.json'));
  if (typeof config.directory !== 'string' || !config.directory) throw Error('자동 추가 폴더가 설정되지 않았습니다.');
  if (!existsSync(config.directory) || !statSync(config.directory).isDirectory()) throw Error('지정 폴더를 찾지 못했습니다. 폴더 위치를 확인해 주세요.');
  const error = await shell.openPath(config.directory);
  if (error) throw Error('지정 폴더를 열지 못했습니다. 폴더 접근 권한을 확인해 주세요.');
}
function saveSettings() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsFile + '.tmp', JSON.stringify(settings, null, 2));
  renameSync(settingsFile + '.tmp', settingsFile);
}
function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function requestJSON(port, path) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 1200 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 8_000_000) req.destroy(); });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
async function existingService(port) {
  const health = await requestJSON(port, '/api/health');
  if (health?.app === 'cove' && typeof health.libraryRoot === 'string') return health;
  // Compatibility with the already-running login service, before /api/health existed.
  const state = await requestJSON(port, '/api/state');
  return Array.isArray(state?.tracks) && Array.isArray(state?.playlists) && typeof state.libraryRoot === 'string' ? state : null;
}
function serviceLog(message) {
  try {
    const path = join(dataDirectory, 'service.log');
    if (existsSync(path) && statSync(path).size > 1024 * 1024) renameSync(path, path + '.previous');
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  } catch { /* Logging must not terminate the app, including on a full disk. */ }
}
async function recoverService(code, diagnostic) {
  if (stopping || recovery) return;
  const now = Date.now();
  while (recoveryTimes.length && recoveryTimes[0] < now - 60000) recoveryTimes.shift();
  if (recoveryTimes.length >= 2) {
    await dialog.showMessageBox(window, { type: 'error', message: '음악 서재 연결을 복구하지 못했습니다.', detail: `잠시 후 앱을 다시 열어 주세요. 음악과 기록은 보관되어 있습니다.\n오류 기록: ${join(dataDirectory, 'service.log')}` });
    return;
  }
  recoveryTimes.push(now);
  recovery = (async () => {
    await new Promise(ok => setTimeout(ok, 1000));
    if (stopping) return;
    try {
      // Keep the same origin and existing renderer so unsaved drafts survive.
      await startService(settings.port);
      serviceLog('Library service reconnected');
      await window?.webContents.executeJavaScript("window.dispatchEvent(new Event('cove-service-reconnected'))");
    } catch (error) {
      serviceLog(`Library recovery failed: ${error.stack || error.message}`);
      if (!stopping) await dialog.showMessageBox(window, { type: 'error', message: '음악 서재 연결을 복구하지 못했습니다.', detail: `앱을 종료한 뒤 다시 열어 주세요. 음악과 기록은 보관되어 있습니다.\n오류 기록: ${join(dataDirectory, 'service.log')}` });
    }
  })().finally(() => { recovery = null; });
  await recovery;
}
async function startService(onlyPort) {
  const candidatePorts = onlyPort ? [onlyPort] : [...new Set([settings.port || 4317, ...Array.from({ length: 10 }, (_, i) => 43517 + i)])];
  for (const port of candidatePorts) {
    const active = await existingService(port);
    if (active && canonical(active.libraryRoot) === canonical(join(dataDirectory, 'library'))) {
      settings.port = port;
      saveSettings();
      return `http://127.0.0.1:${port}`;
    }
    if (active) continue;
    try {
      await new Promise((ok, no) => {
        const child = utilityProcess.fork(join(root, 'src/server.mjs'), [], {
          cwd: root,
          env: { ...process.env, PORT: String(port), SORISEOJAE_DATA_DIR: dataDirectory },
          stdio: 'pipe', serviceName: 'Cove Music Library'
        });
        let settled = false, diagnostic = '';
        const timer = setTimeout(() => { child.kill(); no(Error('서재 준비 시간이 초과되었습니다.')); }, 15000);
        child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); serviceLog(String(chunk).trim()); });
        child.stdout?.on('data', chunk => serviceLog(String(chunk).trim()));
        child.on('message', message => {
          if (message?.type !== 'ready' || settled) return;
          settled = true; clearTimeout(timer); service = child; ok();
        });
        child.on('exit', code => {
          clearTimeout(timer);
          if (!settled) no(Error(diagnostic || `서재를 시작하지 못했습니다 (${code}).`));
          else if (!stopping && service === child) {
            service = null;
            serviceLog(`Library service exited (${code})\n${diagnostic}`);
            void recoverService(code, diagnostic);
          }
        });
      });
      settings.port = port; saveSettings();
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (!/EADDRINUSE/.test(error.message)) throw error;
    }
  }
  throw Error('음악 서재가 사용할 로컬 연결을 확보하지 못했습니다. 앱을 다시 열어 주세요.');
}
function allowedNavigation(url) {
  try { return new URL(url).origin === address; } catch { return false; }
}
function openExternal(url) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}
function showWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); return;
  }
  const bounds = settings.bounds || {};
  window = new BrowserWindow({
    title: app.getName(), width: bounds.width || 1360, height: bounds.height || 900,
    minWidth: 680, minHeight: 540, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#fafafa',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: join(__dirname, 'preload.cjs'), autoplayPolicy: 'no-user-gesture-required' }
  });
  const openedWindow = window;
  if (app.getName() === 'Cove Preview') window.on('page-title-updated', event => { event.preventDefault(); window.setTitle('Cove Preview'); });
  alarmReady = false;
  window.webContents.on('did-start-loading', () => { alarmReady = false; systemMedia?.reset(); });
  window.webContents.on('before-input-event', (event, input) => {
    if (heldAlarmKey) {
      event.preventDefault();
      if (input.type === 'keyUp' && (input.code || input.key) === heldAlarmKey) heldAlarmKey = null;
      return;
    }
    if (alarm?.active && (input.type === 'keyDown' || input.type === 'rawKeyDown')) {
      event.preventDefault(); heldAlarmKey = input.code || input.key;
      sendAlarm({ type: 'dismiss', token: alarm.active.token });
    }
  });
  window.on('blur', () => { heldAlarmKey = null; });
  let closing = false;
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowedNavigation(url)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', message: '저장하지 않은 내용이 있습니다.',
      detail: '기록을 저장하거나 진행 중인 음원 추가를 마친 뒤 닫아 주세요.',
      buttons: ['계속 사용', '저장하지 않고 닫기'], defaultId: 0, cancelId: 0
    });
    if (choice === 1) event.preventDefault();
    else { closing = false; quitting = false; }
  });
  if (!sessionConfigured) {
    sessionConfigured = true;
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.on('will-download', (_event, item) => {
      if (!allowedNavigation(item.getURL())) { item.cancel(); return; }
      item.setSaveDialogOptions({ title: '내보내기 저장', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
    });
  }
  window.on('close', event => {
    if (alarm?.config.enabled && !quitting) { event.preventDefault(); window.hide(); return; }
    closing = true;
    if (!window.isMaximized() && !window.isFullScreen()) {
      const { width, height } = window.getBounds(); settings.bounds = { width, height }; saveSettings();
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.loadURL(address).catch(error => {
    if (!closing && !openedWindow.isDestroyed()) dialog.showErrorBox('Cove를 열지 못했습니다', error.message);
  });
}
function sendAlarm(message) {
  if (alarmReady && window && !window.isDestroyed()) window.webContents.send('alarm:event', message);
}
function releaseAlarmPower() {
  if (alarmPower !== undefined && powerSaveBlocker.isStarted(alarmPower)) powerSaveBlocker.stop(alarmPower);
  alarmPower = undefined;
}
function setupAlarm() {
  settings.alarm ||= {}; settings.alarmWake ||= {};
  wake = new WakeSchedule({ helper: join(__dirname, 'wake-authorize'), state: settings.alarmWake, persist: saveSettings });
  alarm = new AlarmScheduler({ state: settings.alarm, persist: saveSettings,
    fire: active => { alarmPower = powerSaveBlocker.start('prevent-app-suspension'); showWindow(); sendAlarm({ type: 'start', ...active }); },
    cancel: token => { releaseAlarmPower(); sendAlarm({ type: 'cancel', token }); }
  });
  const trusted = event => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowedNavigation(event.senderFrame.url)) throw Error('허용되지 않은 알람 요청입니다.');
  };
  const handle = (name, fn) => ipcMain.handle(name, async (event, value) => {
    trusted(event);
    try { return { ok: true, value: await fn(value) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  const available = async config => {
    const data = await requestJSON(settings.port, '/api/state');
    if (!data?.tracks) throw Error('소장곡을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    const ids = new Set(data.tracks.map(track => track.id));
    if ([...config.tracks, config.classicId].some(id => !ids.has(id))) throw Error('선택한 곡이 소장 목록에 없습니다. 다시 선택해 주세요.');
  };
  handle('alarm:get', async () => ({ config: alarm.config, wake: await wake.status(alarm.config), active: alarm.active }));
  handle('auto-import:open-folder', openAutoImportFolder);
  handle('auto-import:choose-folder', async () => {
    const result = await dialog.showOpenDialog(window, { title: '자동 추가할 음악 폴더', message: '이 폴더와 하위 폴더의 음악을 확인합니다.', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? { canceled: true } : { directory: result.filePaths[0] };
  });
  handle('library:open-folder', async () => { const error = await shell.openPath(dataDirectory); if (error) throw Error(error); });
  handle('alarm:ready', () => { alarmReady = true; return alarm.active; });
  handle('alarm:save', async value => {
    if (alarmSaving) throw Error('깨우기 예약을 설정하는 중입니다.');
    const config = validateAlarm(value); if (config.enabled) await available(config);
    alarmSaving = true;
    try {
      // Disabling audio is immediate even if canceling the OS wake needs consent.
      if (!config.enabled) alarm.save(config);
      await wake.configure(config);
      if (config.enabled) alarm.save(config);
      return { config: alarm.config, wake: await wake.status(alarm.config) };
    } finally { alarmSaving = false; }
  });
  handle('alarm:preview', async value => {
    if (alarm.active) throw Error('알람을 먼저 종료해 주세요.');
    if (!value || !Number.isSafeInteger(value.trackId) || value.trackId < 1 || !Number.isFinite(value.volume) || value.volume < .01 || value.volume > 1 || typeof value.fade !== 'boolean') throw Error('미리 들을 곡과 음량을 확인해 주세요.');
    await available({ tracks: [value.trackId], classicId: value.trackId });
    return { trackId: value.trackId, volume: value.volume, fade: value.fade };
  });
  handle('alarm:stop', token => { if (typeof token !== 'string') return false; const stopped = alarm.finish(token); if (stopped) releaseAlarmPower(); return stopped; });
  alarmTimer = setInterval(() => { if (alarmReady && !alarmSaving) alarm.tick(); }, 1000);
  powerMonitor.on('resume', () => { if (alarmReady && !alarmSaving) alarm.tick(); });
  powerMonitor.on('unlock-screen', () => { if (alarm.active) showWindow(); });
}
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Cove', submenu: [{ role: 'about', label: 'Cove 정보' }, { type: 'separator' }, { role: 'hide', label: 'Cove 가리기' }, { role: 'hideOthers', label: '다른 앱 가리기' }, { role: 'unhide', label: '모두 보기' }, { type: 'separator' }, { role: 'quit', label: 'Cove 종료' }] }] : []),
    { label: '파일', submenu: [
      { label: '음원 추가', accelerator: 'CmdOrCtrl+O', click: () => { showWindow(); window.webContents.executeJavaScript("document.querySelector('#collection-add')?.click()"); } },
      { label: '기록 내보내기…', click: () => { showWindow(); window.webContents.downloadURL(`${address}/api/export`); } },
      { label: '음악 보관 폴더 열기', click: () => shell.openPath(dataDirectory) },
      { label: '자동 추가 폴더 열기', click: async () => {
        try { await openAutoImportFolder(); }
        catch (error) { await dialog.showMessageBox(window, { message: error.message }); }
      } },
      { type: 'separator' }, { role: 'close', label: '창 닫기' }, ...(process.platform === 'darwin' ? [] : [{ role: 'quit', label: 'Cove 종료' }])
    ] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '오려두기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '전체 선택' }] },
    { label: '보기', submenu: [{ role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }] },
    { label: '윈도우', submenu: [{ role: 'minimize', label: '최소화' }, { role: 'zoom', label: '확대/축소' }, { type: 'separator' }, { role: 'front', label: '모두 앞으로 가져오기' }] }
  ]));
}
async function stopService() {
  if (!service) return;
  stopping = true;
  const child = service; service = null;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.postMessage({ type: 'shutdown' }); } catch { clearTimeout(timer); resolve(); }
  });
}
app.on('second-instance', () => { if (address) showWindow(); });
app.on('activate', () => { if (address) showWindow(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', event => {
  systemMedia?.close();
  clearInterval(alarmTimer); releaseAlarmPower();
  stopping = true;
  if (!service) return;
  event.preventDefault();
  stopService().finally(() => app.quit());
});

if (ownsLock) app.whenReady().then(async () => {
  const dockIcon = join(process.resourcesPath, 'CoveDock.png');
  if (app.isPackaged && existsSync(dockIcon)) app.dock?.setIcon(dockIcon);
  settingsFile = join(app.getPath('userData'), 'library.json');
  settings = readJSON(settingsFile);
  const initial = readJSON(join(root, 'desktop/library-default.json'));
  dataDirectory = await chooseLibrary({ settings, legacyDefault: initial.dataDirectory,
    defaultDirectory: join(app.getPath('music'), app.getName()), override: process.env.COVE_DATA_DIR, dialog });
  if (!dataDirectory) { app.quit(); return; }
  settings.dataDirectory = dataDirectory;
  address = await startService();
  setupAlarm(); if (process.platform === 'darwin') systemMedia = setupMediaControls({ getWindow: () => window, origin: () => address, alarmActive: () => !!alarm?.active, log: serviceLog }); createMenu(); showWindow();
}).catch(async error => {
  dialog.showErrorBox('Cove를 시작하지 못했습니다', error.message);
  await stopService(); app.quit();
});
