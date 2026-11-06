const { existsSync, statSync, readdirSync, mkdirSync, openSync, readSync, closeSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function isLibrary(directory) {
  try {
    if (!statSync(join(directory, 'library')).isDirectory()) return false;
    const handle = openSync(join(directory, 'soriseojae.sqlite'), 'r');
    try { const header = Buffer.alloc(16); readSync(handle, header, 0, 16, 0); if (header.toString() !== 'SQLite format 3\0') return false; }
    finally { closeSync(handle); }
    const db = new DatabaseSync(join(directory, 'soriseojae.sqlite'), { readOnly: true });
    try { db.prepare('SELECT id, title FROM tracks LIMIT 0').all(); db.prepare('SELECT managed_path FROM audio_files LIMIT 0').all(); return true; }
    finally { db.close(); }
  } catch { return false; }
}

// Choosing a new location never turns an arbitrary populated folder into a library.
function createLibraryDirectory(directory, t = message => message) {
  if (existsSync(directory) && readdirSync(directory).some(name => name !== '.DS_Store')) throw Error(t('새 서재에는 빈 폴더를 선택해 주세요. 기존 서재라면 ‘기존 서재 열기’를 선택하세요.'));
  mkdirSync(directory, { recursive: true });
  return resolve(directory);
}

async function chooseLibrary({ settings, legacyDefault, defaultDirectory, override, dialog, t = message => message }) {
  if (override) return resolve(override);
  const previous = settings.dataDirectory || legacyDefault;
  if (previous && isLibrary(resolve(previous))) return resolve(previous);
  let proposed = defaultDirectory;
  for (;;) {
    const choice = await dialog.showMessageBox({
      type: previous ? 'warning' : 'info', title: 'Cove',
      message: previous ? t('기존 서재를 다시 찾아주세요') : t('나의 음악 서재를 시작하세요'),
      detail: (previous ? t('연결했던 서재를 찾을 수 없습니다. 다시 연결하거나 새 서재를 만들 수 있습니다.\n\n') : '') + t('새 서재 위치\n') + proposed + t('\n\n음악과 가사, 기록을 이 폴더에 함께 보관합니다.'),
      buttons: [t('새 서재 시작'), t('보관 위치 변경'), previous ? t('기존 서재 다시 찾기') : t('기존 서재 열기'), t('종료')], defaultId: previous ? 2 : 0, cancelId: 3
    });
    if (choice.response === 3) return null;
    try {
      if (choice.response === 0) return createLibraryDirectory(proposed, t);
      const existing = choice.response === 2;
      const result = await dialog.showOpenDialog({ title: existing ? t('기존 서재 열기') : t('새 서재 보관 위치'), message: existing ? t('soriseojae.sqlite와 library 폴더가 있는 서재를 선택하세요.') : t('음악과 기록을 보관할 빈 폴더를 선택하세요.'), defaultPath: proposed, properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) continue;
      const selected = resolve(result.filePaths[0]);
      if (existing) { if (!isLibrary(selected)) throw Error(t('선택한 폴더에 Cove 서재가 없습니다. soriseojae.sqlite와 library 폴더를 확인하세요.')); return selected; }
      proposed = selected;
    } catch (error) { await dialog.showMessageBox({ type: 'error', message: error.message, buttons: [t('다시 선택')] }); }
  }
}
module.exports = { chooseLibrary, isLibrary, createLibraryDirectory };
