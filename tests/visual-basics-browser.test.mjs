import { ensureLyricsEditing, leaveListening, toggleManage, openComments, songMenu, openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('승인 디자인: 공통 조작·사진·메뉴·대화상자·탭·키보드·전체 화면', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-visual-'));
  const out = resolve(process.env.VISUAL_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '20317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk); t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); }); });
  const url = 'http://127.0.0.1:20317', songs = [], originals = [];
  for (const [i, title] of ['초록빛 산책', '다시 꺼내는 노래', '저녁의 기록'].entries()) {
    const bytes = playableFlac({ title, album: i < 2 ? '우리의 계절' : '하루의 끝', frequency: 330 + i * 110, seconds: 12 });
    const file = join(root, `${i}.flac`); await writeFile(file, bytes); originals.push({ file, bytes });
    const stage = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: bytes })).json();
    songs.push(await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: stage.importId, metadata: { lrcText: '[00:00]테스트 전용 가사\n[00:04]다음 줄\n[00:10]마지막 줄', lrcSourceName: 'test.lrc' } }) })).json());
  }
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png'), fullPage: true }).catch(() => {}); });
  const checks = [], check = name => checks.push(name);
  const nav = async route => {
    await leaveListening(page);
    if (route === 'import') { await nav('library'); await page.locator('#collection-add').click(); }
    else if (route === 'queue') { await page.locator('#queue-open').click(); if (!await page.locator('#queue-extras').evaluate(el => el.open)) await page.locator('#queue-extras > summary').click(); }
    else await page.locator(`.nav-button[data-route="${route}"]`).click();
  };
  const manage = () => toggleManage(page);
  const openDetail = async id => { await openCollectionSong(page, id); };
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const shot = name => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  await page.goto(url); await nav('library');
  const first = page.locator('[data-row-play]').first(); const firstId = Number(await first.getAttribute('data-row-play'));
  await first.click(); await expect(first.locator('..')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await openDetail(firstId);
  await expect(page.locator('#detail-content [data-play]')).toHaveCount(0);
  await page.locator('#mini-play').click();
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  await expect(first.locator('..')).toHaveAttribute('aria-current', 'true');
  assert.equal(await page.locator('.detail-actions input[type="range"]').count(), 0);
  // Pausing can retain a fraction of a second; start the skip check at zero.
  await page.locator('#mini-seek').press('Home');
  await expect(page.locator('#mini-seek')).toHaveJSProperty('value', '0');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.locator('[data-lyrics-lines]').press('Home'); await expect(page.locator('[data-lyrics-lines]')).toBeFocused();
  assert.equal(await page.locator('[data-skip], [data-detail-panel="file"]').count(), 0);
  await page.locator('#mini-seek').evaluate(input => { input.value = '10'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#mini-seek')).toHaveJSProperty('value', '10');
  await page.locator('#mini-seek').press('Home');
  check('row-detail-mini-play-pause-two-tabs-and-common-seek');
  await manage(); 
  await page.getByLabel('한국어 번역').fill('디자인 전환 중 유지할 초안');
  await nav('library'); await page.locator('#settings-open').click(); await page.getByLabel('밝기').selectOption('dark'); await page.keyboard.press('Escape');
  await expect(page.locator('#settings-open')).toBeFocused();
  await openDetail(firstId); await expect(page.locator('[data-lyrics-lines]')).toContainText('디자인 전환 중 유지할 초안');
  await manage(); await expect(page.getByLabel('한국어 번역')).toHaveValue('디자인 전환 중 유지할 초안');
  await page.getByRole('button', { name: '가사 저장', exact: true }).click(); await expect(page.locator('[data-detail-draft]')).toBeHidden();
  await nav('library'); await page.locator('#settings-open').click(); await page.getByLabel('밝기').selectOption('light'); await page.keyboard.press('Escape'); await openDetail(firstId);
  check('settings-theme-management-draft-preservation'); await ensureLyricsEditing(page);
  await page.locator('[data-artwork-open]').click(); await expect(page.locator('[data-artwork-save]')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-artwork-open]')).toBeFocused();
  await page.locator('[data-artwork-open]').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.locator('[data-artwork-file]').setInputFiles({ name: 'test-cover.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('[data-artwork-preview] img')).toBeVisible(); await page.locator('[data-artwork-save]').click();
  await expect(page.locator('.artwork-dialog')).not.toBeVisible();
  await expect(page.locator('[data-detail-cover] img')).toBeVisible();
  await expect(page.locator('[data-artwork-open]')).toBeFocused();
  check('artwork-picker-preview-save-cancel-focus');
   await shot('detail-edit-light-1280'); await manage(); await shot('detail-light-1280'); await manage();
  await expect(page.locator('[data-detail-artist]')).toHaveText('테스트 아티스트'); await expect(page.locator('button[data-detail-artist]')).toHaveCount(0);
  await shot('artist-light-1280');
  await nav('library'); await shot('collection-light-1280');
  const oldQueue = await queue();
  await page.locator('#library-grid [data-row-play]').first().press('Shift+F10'); await expect(page.locator('.song-menu:popover-open')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#library-grid [data-row-play]').first()).toBeFocused();
  await page.locator('#library-grid [data-row-play]').first().press('Shift+F10'); await page.locator('.song-menu:popover-open [data-row-next]').click();
  assert.equal((await queue()).ids.length, oldQueue.ids.length + 1);
  await page.locator('#library-grid [data-row-play]').first().press('Shift+F10'); await page.locator('.song-menu:popover-open [data-row-append]').click();
  assert.equal((await queue()).ids.at(-1), firstId);
  check('artist-link-and-next-end-menus-preserve-duplicates');
  await nav('queue'); const previous = await queue();
  await page.locator('[data-queue-down="0"]').click();
  assert.equal((await queue()).index, previous.index + 1); // same playing entry moves, it is not replaced.
  await page.locator('[data-queue-up="1"]').click();
  await expect(page.locator('[data-queue-up="0"]')).toBeDisabled();
  await page.locator('[data-queue-remove]').last().click();
  assert.equal((await queue()).ids.length, previous.ids.length - 1);
  await page.locator('#queue-save-open').click(); await page.getByLabel('대기열 이름').fill('반복 항목과 순서 검증');
  await page.route('**/api/queues', route => route.fulfill({ status: 500, json: { error: '검증용 저장 실패' } }));
  await page.locator('#queue-save-form .primary-button').click();
  await expect(page.locator('#queue-save-error')).toContainText('검증용 저장 실패');
  await expect(page.getByLabel('대기열 이름')).toHaveValue('반복 항목과 순서 검증');
  await page.unroute('**/api/queues'); await page.locator('#queue-save-form .primary-button').click();
  await expect(page.locator('#queue-save-dialog')).not.toBeVisible(); await expect(page.locator('#queue-save-open')).toBeFocused();
  await page.locator('[data-load-queue]').click(); await expect(page.locator('[data-load-queue]')).toBeFocused(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  await page.locator('#queue-save-open').click(); await page.keyboard.press('Escape'); await expect(page.locator('#queue-save-open')).toBeFocused();
  check('queue-identity-move-remove-save-failure-name-load-stopped-cancel'); await shot('queue-light-1280');
  const volume = page.locator('#volume-open'), slider = page.locator('#mini-volume-inline');
  await slider.press('Home'); await expect(slider).toHaveValue('0');
  await expect(volume).toHaveAttribute('aria-label', '음소거 해제');
  await volume.press('Enter'); await expect(slider).toHaveValue('0.8');
  await slider.press('End'); await expect(slider).toHaveValue('1');
  await volume.click(); await expect(volume).toHaveAttribute('aria-pressed', 'true');
  await expect(slider).toHaveValue('0');
  assert.equal(await page.locator('#volume-dialog,#mute-toggle').count(), 0);
  await volume.press('Space'); await expect(volume).toHaveAttribute('aria-pressed', 'false');
  await expect(slider).toHaveValue('1'); await expect(volume).toBeFocused();
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:700});
    await volume.press('Enter'); await expect(volume).toHaveAttribute('aria-label','음소거 해제');
    await volume.press('Space'); await expect(volume).toHaveAttribute('aria-label','음소거');
    await expect(page.locator('dialog[open]')).toHaveCount(0); await expect(volume).toBeFocused();
  }
  await page.setViewportSize({width:1280,height:900});
  check('direct-mute-no-popup-retains-volume-zero-recovery-and-small-screen-keyboard');
  await page.locator('#settings-open').click();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: '기록 내보내기(JSON)' }).click();
  const download = await downloadPromise; assert.match(download.suggestedFilename(), /\.json$/);
  await page.keyboard.press('Escape'); check('export-connected'); await shot('export-light-1280');
  await nav('home'); await shot('today-light-1280'); await nav('import'); await shot('import-light-1280');
  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['home', 'library', 'queue', 'import']) {
      await nav(route); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} ${width}`);
    }
    await nav('library'); await openDetail(Number(await page.locator('#library-grid [data-row-play]').first().getAttribute('data-row-play')));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `detail ${width}`);
    if (width === 390) { await shot('detail-light-390'); await nav('library'); await shot('collection-light-390'); await page.locator('#settings-open').click(); await page.getByLabel('밝기').selectOption('dark'); await page.keyboard.press('Escape'); await shot('collection-dark-390'); await page.locator('#settings-open').click(); await page.getByLabel('밝기').selectOption('light'); await page.keyboard.press('Escape'); }
  }
  check('all-views-reflow-320-390-768-1024-1280');
  // A natural automatic transition redraws metadata; preserve the focused song action.
  await nav('library'); await page.locator('[data-row-play]').first().click();
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  const active = await queue(); await page.locator('#mini-seek').evaluate(input => { input.value = '11'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#library-grid [data-row-play]').last().focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const focusedTitle = await page.locator(':focus').getAttribute('aria-label');
  await expect.poll(async () => (await queue()).index).toBe(active.index + 1);
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', focusedTitle);
  await page.locator('#mini-play').click();
  check('automatic-next-retains-keyboard-focus');
  for (const original of originals) assert.deepEqual(await readFile(original.file), original.bytes);
  for (const song of songs) assert.deepEqual(await readFile(join(root, 'data/library', song.managedPath)), originals[songs.indexOf(song)].bytes);
  const exported = await (await page.request.get(url + '/api/export')).json(); assert.ok(JSON.stringify(exported).includes('디자인 전환 중 유지할 초안'));
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, checks, errors, originalAudioPreserved: true }, null, 2));
  console.log(JSON.stringify({ out, checks, errors }));
});
