import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { playableFlac } from './fixtures.mjs';

test('Mac 앱: 독립 서버·복사 추가·FLAC/가사·우클릭·내보내기·재실행·공유 서버 보호', { skip: !process.env.RUN_DESKTOP_TESTS, timeout: 180000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { _electron } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const temp = await mkdtemp(join(tmpdir(), 'cove-mac-'));
  const profile = join(temp, 'profile'), data = join(temp, 'data');
  const out = resolve(process.env.DESKTOP_ARTIFACT_DIR || join(temp, 'evidence'));
  await mkdir(out, { recursive: true });
  const executablePath = resolve(process.env.COVE_TEST_APP || 'dist/Cove.app/Contents/MacOS/Cove');
  let desktop, page, address;
  const errors = [], checks = [];
  async function launch() {
    desktop = await _electron.launch({ executablePath, env: { ...process.env, COVE_DATA_DIR: data, COVE_PROFILE_DIR: profile } });
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    // Electron's will-prevent-unload handler owns this native confirmation.
    // Avoid Playwright trying to dismiss an already-handled Chromium dialog.
    page.on('dialog', dialog => { if (dialog.type() !== 'beforeunload') dialog.dismiss().catch(() => {}); });
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    address = new URL(page.url()).origin;
  }
  t.after(async () => {
    if (!desktop) return;
    await page?.screenshot({ path: join(out, 'last-state.png') }).catch(() => {});
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    await desktop.close().catch(() => {});
  });
  await launch();
  const state = async () => (await page.request.get(`${address}/api/state`)).json();
  assert.deepEqual((await state()).tracks, []);
  const runtime = await desktop.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, services: app.getAppMetrics().map(item => item.name).filter(Boolean) }));
  assert(runtime.services.includes('Cove Music Library'));
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  checks.push('packaged-app-starts-bundled-node-sqlite-service-and-sandboxed-renderer');

  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__contexts = [];
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__contexts.push(this); }
      createGain() {
        const gain = super.createGain(), connect = gain.connect.bind(gain);
        gain.connect = (...args) => { if (args[0] === this.destination) { this.__meter = this.createAnalyser(); connect(this.__meter); } return connect(...args); };
        return gain;
      }
    };
  });
  await page.reload();
  await page.locator('.nav-button[data-route="library"]').click();
  await page.locator('#collection-add').click();
  const originals = [playableFlac({ title: 'Mac 첫 번째 곡', seconds: 12, frequency: 330 }), playableFlac({ title: 'Mac 두 번째 곡', seconds: 12, frequency: 550 })];
  const files = originals.map((bytes, index) => join(temp, `${index + 1}.flac`));
  for (let i = 0; i < files.length; i++) await writeFile(files[i], originals[i]);
  const lrc = join(temp, '1.lrc'); await writeFile(lrc, '[00:00]첫 번째 가사\n[00:04]다음 가사');
  await page.locator('#file-input').setInputFiles([...files, lrc]);
  await expect(page.locator('#batch-form')).toBeVisible();
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-complete')).toBeVisible();
  const imported = await state(); assert.equal(imported.tracks.length, 2);
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(await readFile(files[i]), originals[i]);
    const track = imported.tracks.find(row => row.title.includes(i === 0 ? '첫 번째' : '두 번째'));
    const detail = await (await page.request.get(`${address}/api/tracks/${track.id}`)).json();
    assert.deepEqual(await readFile(join(data, 'library', detail.managedPath)), originals[i]);
  }
  checks.push('native-file-input-copy-import-two-flac-and-lrc-originals-unchanged');
  await page.locator('#open-imported').click();
  const rows = page.locator('#library-grid [data-row-play]');
  const first = Number(await rows.nth(0).getAttribute('data-row-play'));
  const second = Number(await rows.nth(1).getAttribute('data-row-play'));
  await rows.nth(0).click();
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await expect.poll(() => page.evaluate(() => {
    const context = window.__contexts?.[0], analyser = context?.__meter;
    if (!analyser) return 0;
    const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
    return Math.max(...samples.map(Math.abs));
  })).toBeGreaterThan(.01);
  await page.locator('#mini-next').click();
  await expect.poll(() => page.evaluate(() => { const q = JSON.parse(localStorage.getItem('soriseojae.queue')); return q.ids[q.index]; })).toBe(second);
  await page.locator('#mini-prev').click();
  await expect.poll(() => page.evaluate(() => { const q = JSON.parse(localStorage.getItem('soriseojae.queue')); return q.ids[q.index]; })).toBe(first);
  await page.locator('#mini-play').click();
  await page.locator('#mini-track').click();
  await expect(page.locator('#detail-content.lyrics-listening')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.screenshot({ path: join(out, 'native-lyrics.png') });
  await page.locator('#detail-content [data-edit-info]').click();
  const info = page.locator('#track-info-form');
  await expect(info.locator('[name="title"]')).toBeEnabled();
  await info.locator('[name="artist"]').fill('Mac 편집 가수');
  await info.locator('[name="lyricsOriginal"]').fill('[00:00]Mac 편집 가사\n[00:04]다음 줄');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  await expect(info.locator('.primary-button')).toBeInViewport();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(out, 'native-info-200.png') });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await info.locator('.primary-button').click(); await expect(page.locator('#track-info-dialog')).toBeHidden();
  await expect(page.locator('[data-detail-artist]')).toHaveText('Mac 편집 가수');
  checks.push('native-unified-info-modal-artist-and-lyrics-save-actual-200-percent-fixed-actions');
  await page.locator('#detail-content [data-comments]').click();
  await page.locator('#comments-form textarea').fill('Mac 앱에서도 보존할 기록');
  await desktop.evaluate(({ BrowserWindow, dialog }) => {
    global.__originalMessageBox = dialog.showMessageBoxSync; global.__blockedClose = 0;
    dialog.showMessageBoxSync = () => { global.__blockedClose++; return 0; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect.poll(() => desktop.evaluate(() => global.__blockedClose)).toBe(1);
  await expect(page.locator('#comments-form textarea')).toHaveValue('Mac 앱에서도 보존할 기록');
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = global.__originalMessageBox; });
  await page.locator('#comments-form .primary-button').click();
  await expect(page.locator('#comments-draft')).toBeHidden();
  await page.keyboard.press('Escape');
  checks.push('native-close-cancel-protects-unsaved-comment-and-save-persists');
  await page.locator('[data-detail-back]').click();
  await rows.nth(0).click({ button: 'right' });
  await expect(page.locator('.song-menu:popover-open')).toBeVisible(); await page.keyboard.press('Escape');
  checks.push('audible-decoded-flac-single-click-next-previous-full-window-lyrics-native-right-click');

  const queueBeforeMenus = await page.evaluate(() => localStorage.getItem('soriseojae.queue'));
  await expect(page.locator('[data-view="library"] #collection-add, #playlist-actions')).toHaveCount(0);
  await expect(page.locator('.sidebar #collection-add')).toBeVisible();
  await page.screenshot({ path: join(out, 'native-settings-import.png') });
  await page.locator('#playlist-create').click(); await page.locator('#playlist-name-form input').fill('느긋한 오후'); await page.locator('#playlist-name-form .primary-button').click();
  await expect(page.locator('#playlist-name-dialog')).toBeHidden();
  const playlistId = await page.locator('#playlist-tabs [aria-selected="true"]').getAttribute('data-playlist-id');
  await page.locator('#empty-playlist-add').click(); await page.locator('#playlist-add-list input').first().check(); await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-dialog')).toBeHidden();
  await expect(page.locator('#playlist-add')).toHaveAccessibleName('플레이리스트에 곡 추가');
  assert.equal((await page.locator('#playlist-add').innerText()).trim(), '곡 담기');
  const playlistTab = page.locator(`#playlist-tabs [data-playlist-id="${playlistId}"]`);
  await playlistTab.click({ button: 'right' }); await expect(page.locator('#playlist-menu')).toBeVisible();
  await expect(page.locator('#playlist-menu button')).toHaveText(['이름 변경', '순서 편집', '플레이리스트 삭제']);
  assert.equal(await page.evaluate(() => localStorage.getItem('soriseojae.queue')), queueBeforeMenus);
  await page.screenshot({ path: join(out, 'native-playlist-context.png') });
  await page.keyboard.press('Escape'); await expect(playlistTab).toBeFocused();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  await playlistTab.press('Shift+F10');
  const menuGeometry = () => page.evaluate(() => {
    const menu = document.querySelector('#playlist-menu').getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect(), focus = document.activeElement.getBoundingClientRect();
    return { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, menu: menu.toJSON(), main: main.toJSON(), focus: focus.toJSON(), fits: menu.top >= main.top + 7 && menu.bottom <= main.bottom - 7 && focus.top >= menu.top && focus.bottom <= menu.bottom };
  });
  await expect.poll(async () => (await menuGeometry()).fits).toBe(true);
  await writeFile(join(out, 'native-200-measurements.json'), JSON.stringify(await menuGeometry(), null, 2));
  const nativeCapture = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(join(out, 'native-playlist-context-200.png'), Buffer.from(nativeCapture, 'base64')); await page.keyboard.press('Escape');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  checks.push('native-settings-import-tab-context-menu-keyboard-200-percent-compact-add-and-queue-preserved');

  const downloadPath = join(temp, 'Cove-export.json');
  await desktop.evaluate(({ BrowserWindow }, path) => {
    global.__exportState = 'waiting';
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(path); item.once('done', (_event, state) => { global.__exportState = state; });
    });
  }, downloadPath);
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '파일').submenu.items.find(item => item.label === '기록 내보내기…').click());
  await expect.poll(() => desktop.evaluate(() => global.__exportState)).toBe('completed');
  const exported = JSON.parse(await readFile(downloadPath, 'utf8')); assert.equal(exported.tracks.length, 2);
  await page.evaluate(() => { localStorage.setItem('soriseojae.theme', 'light'); });
  const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  await page.screenshot({ path: join(out, 'native-collection.png') });
  const originalAddress = address;
  await desktop.close(); desktop = null;
  await expect.poll(async () => { try { await fetch(`${originalAddress}/api/health`, { signal: AbortSignal.timeout(600) }); return true; } catch { return false; } }).toBe(false);
  await launch();
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  assert.equal((await state()).tracks.length, 2);
  assert.equal((await (await page.request.get(`${address}/api/tracks/${first}`)).json()).memory, 'Mac 앱에서도 보존할 기록');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue'))), queue);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(address, originalAddress);
  checks.push('native-menu-download-json-owned-service-stops-relaunch-restores-library-queue-theme-without-autoplay');
  await desktop.close(); desktop = null;

  // A previously running service is borrowed and must survive application quit.
  const port = 44517;
  const shared = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: String(port), SORISEOJAE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => shared.kill('SIGTERM'));
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error('공유 서버 준비 실패')), 10000);
    shared.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); ok(); } });
    shared.on('exit', code => { clearTimeout(timer); no(Error(`공유 서버 종료 ${code}`)); });
  });
  const settings = JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')); settings.port = port;
  await writeFile(join(profile, 'library.json'), JSON.stringify(settings));
  await launch();
  assert.equal(address, `http://127.0.0.1:${port}`);
  assert(!(await desktop.evaluate(({ app }) => app.getAppMetrics().map(item => item.name))).includes('Cove Music Library'));
  await desktop.close(); desktop = null;
  assert.equal((await (await fetch(`${address}/api/health`)).json()).app, 'cove');
  checks.push('matching-shared-server-reused-and-not-stopped-on-app-quit');
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ runtime, checks, errors, temp }, null, 2));
  console.log(JSON.stringify({ out, runtime, checks, errors }));
});
