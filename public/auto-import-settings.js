export function setupAutoImportSettings({ getToken, onStatus }) {
  const $ = id => document.getElementById(id);
  const toggle = $('auto-import-toggle'), help = $('auto-import-setting-help'), error = $('auto-import-setting-error');
  const folder = $('auto-import-folder-open'), choose = $('auto-import-folder-choose'), mode = $('auto-import-mode');
  const preview = $('auto-import-preview'), dialog = $('settings-dialog');
  let status, candidate, busy = false, generation = 0;
  const controls = [toggle, choose, folder, mode, $('auto-import-retry'), $('auto-import-preview-confirm'), $('auto-import-path-check')];
  async function request(path = '', body, method = 'POST') {
    const response = await fetch('/api/auto-import' + path, body === undefined ? undefined : {
      method, headers: { 'Content-Type': 'application/json', 'x-local-token': getToken() }, body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '자동 추가 설정을 확인해 주세요.');
    return value;
  }
  function showError(message = '') { error.textContent = message; error.hidden = !message; }
  function render(value) {
    status = value;
    toggle.checked = Boolean(value.enabled);
    mode.value = value.mode || 'copy';
    choose.textContent = value.configured ? '폴더 변경' : '폴더 지정';
    $('auto-import-directory').textContent = value.configured ? value.directory : '감지 폴더를 지정해 주세요.';
    help.textContent = value.processing ? '추가 중 · ' + value.processing : value.pendingFiles ? value.pendingFiles + '개 파일의 복사가 끝나기를 기다립니다.' : value.enabled ? '하위 폴더도 확인합니다. 파일 복사가 끝나면 ' + (value.mode === 'move' ? '검증 후 원본을 이동합니다.' : '서재에 복사합니다.') : '태그가 없으면 파일명을 곡명으로 사용합니다. 곡 정보는 추가 후 수정할 수 있습니다.';
    $('auto-import-retry').hidden = !value.enabled;
    showError(value.error || '');
    onStatus(value);
  }
  async function run(action) {
    if (busy) return;
    busy = true; generation++; controls.forEach(control => control.disabled = true); showError();
    try { await action(); }
    catch (failure) { showError(failure.message); }
    finally { busy = false; controls.forEach(control => control.disabled = false); toggle.disabled = !status; if (candidate) $('auto-import-preview-confirm').focus(); }
  }
  async function refresh() {
    if (busy || candidate) return;
    const current = ++generation;
    try { const value = await request(); if (current === generation && !busy) render(value); }
    catch { if (current === generation) showError('자동 추가 상태를 확인하지 못했습니다. 다시 설정을 열어 주세요.'); }
    toggle.disabled = !status || busy;
  }
  async function prepare(directory) {
    const selectedMode = mode.value;
    await run(async () => {
      const value = await request('/preview', { directory });
      if (!dialog.open) return;
      candidate = { directory: value.directory, mode: selectedMode, enabled: true };
      $('auto-import-preview-copy').textContent = value.directory + '\n기존 음악 ' + value.fileCount.toLocaleString('ko') + '곡 · ' + (value.totalBytes / 1024 ** 2).toLocaleString('ko', { maximumFractionDigits: 1 }) + ' MB · 하위 폴더 포함';
      $('auto-import-preview-mode').textContent = selectedMode === 'move' ? '이동 · 보관본과 가사를 검증한 뒤 원본 파일을 제거합니다.' : '복사 · 기존 음악도 추가하며 원본 파일은 남깁니다. 같은 파일은 중복 추가하지 않습니다.';
      preview.hidden = false; $('auto-import-preview-confirm').focus();
    });
  }
  async function pick() {
    if (!window.coveFolders?.chooseAutoImport) { $('auto-import-browser-folder').hidden = false; $('auto-import-path').focus(); return; }
    let selection;
    await run(async () => {
      const response = await window.coveFolders.chooseAutoImport();
      if (!response?.ok) throw Error(response?.error || '폴더를 선택하지 못했습니다.');
      selection = response.value;
    });
    if (selection?.directory) await prepare(selection.directory);
  }
  function cancelPreview() {
    candidate = null; preview.hidden = true;
    if (status) { toggle.checked = status.enabled; mode.value = status.mode; }
  }
  choose.addEventListener('click', pick);
  $('auto-import-path-check').addEventListener('click', () => prepare($('auto-import-path').value.trim()));
  mode.addEventListener('change', () => { if (status?.configured) void prepare(status.directory); });
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked; toggle.checked = Boolean(status?.enabled);
    if (enabled) return status?.configured ? prepare(status.directory) : pick();
    void run(async () => { render(await request('', { enabled: false }, 'PUT')); cancelPreview(); });
  });
  $('auto-import-preview-confirm').addEventListener('click', () => {
    if (!candidate) return;
    void run(async () => { const value = await request('', candidate, 'PUT'); cancelPreview(); render(value); });
  });
  $('auto-import-preview-cancel').addEventListener('click', () => { cancelPreview(); choose.focus(); });
  $('auto-import-retry').addEventListener('click', () => run(async () => render(await request('/retry', {}))));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', cancelPreview);
  folder.hidden = !window.coveFolders;
  folder.addEventListener('click', () => run(async () => {
    const response = await window.coveFolders.openAutoImport();
    if (!response?.ok) throw Error(response?.error || '지정 폴더를 열지 못했습니다.');
  }));
  const openLibrary = $('library-folder-open');
  openLibrary.hidden = !window.coveFolders?.openLibrary;
  openLibrary.addEventListener('click', async () => {
    const result = await window.coveFolders.openLibrary();
    $('library-folder-error').textContent = result?.error || '';
    $('library-folder-error').hidden = Boolean(result?.ok);
  });
  $('alarm-settings-section').hidden = !window.coveAlarm;
  const timer = setInterval(() => { if (dialog.open && !document.hidden) void refresh(); }, 5000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  void refresh();
  return { refresh };
}
