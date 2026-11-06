import { ensureLyricsEditing, leaveListening, toggleManage, openComments, songMenu, openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

// Opt in: RUN_BROWSER_TESTS=1 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm test
// Every file and DB belongs to a new temp directory; the real library is never opened.
test('기본 감상 1차: 실제 브라우저 추가·연속 재생·초안·오류·밝기·작은 화면', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 180000 }, async t => {
  const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(modulePath);
  const { expect } = await import(modulePath.startsWith('/') ? pathToFileURL(join(modulePath, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-browser-'));
  const source = join(root, 'source'); await mkdir(source);
  const artifacts = resolve(process.env.BROWSER_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(artifacts, { recursive: true });
  const originals = new Map();
  const titles = ['연결 첫 곡', '연결 둘째 곡', '연결 마지막 곡'];
  for (let i = 0; i < titles.length; i++) {
    const path = join(source, `${i + 1}.flac`);
    const bytes = playableFlac({ title: titles[i], album: `서로 다른 앨범 ${i + 1}`, frequency: 330 + i * 110 });
    await writeFile(path, bytes); originals.set(path, bytes);
  }
  const lrc = Buffer.from('\uFEFF[00:00]테스트 전용 가사\r\n[00:03]다음 줄\r\n');
  await writeFile(join(source, '2.lrc'), lrc); originals.set(join(source, '2.lrc'), lrc);
  await writeFile(join(source, 'broken.flac'), 'invalid audio');
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '15317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErrors = '';
  server.stderr.on('data', chunk => serverErrors += chunk);
  t.after(() => { server.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`서버 시작 시간 초과: ${serverErrors}`)), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timeout); resolve(); } });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`서버 종료 ${code}: ${serverErrors}`)); });
    server.on('error', reject);
  });
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  t.after(async () => { await page.screenshot({ path: join(artifacts, 'last-browser-state.png'), fullPage: true }).catch(() => {}); await browser.close(); });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const observations = [];
  const note = value => { observations.push(value); console.log(JSON.stringify(value)); };
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.__audio = { contexts: [], starts: [], ended: 0 };
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.__audio.contexts.push(this); }
      createGain() {
        const gain = super.createGain(); const connect = gain.connect.bind(gain);
        gain.connect = (...args) => {
          if (args[0] === this.destination) { this.__meter = this.createAnalyser(); connect(this.__meter); }
          return connect(...args);
        };
        return gain;
      }
      createBufferSource() {
        const source = super.createBufferSource(); const start = source.start.bind(source);
        source.start = (at, offset) => { window.__audio.starts.push({ at, offset, now: this.currentTime, duration: source.buffer.duration }); return start(at, offset); };
        source.addEventListener('ended', () => window.__audio.ended++);
        return source;
      }
    };
  });
  const url = 'http://127.0.0.1:15317';
  const getState = async () => (await page.request.get(url + '/api/state')).json();
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const nav = async route => {
    await leaveListening(page);
    if (route === 'import') { await page.locator('.nav-button[data-route="library"]').click(); await page.locator('#collection-add').click(); }
    else if (route === 'queue') { await page.locator('#queue-open').click(); if (!await page.locator('#queue-extras').evaluate(el => el.open)) await page.locator('#queue-extras > summary').click(); }
    else await page.locator(`.nav-button[data-route="${route}"]`).click();
  };
  const manage = () => toggleManage(page);
  const openDetail = async id => {
    await openCollectionSong(page, id);
    await expect(page.locator('#notes-form')).toHaveAttribute('data-track-id',String(id));
    await expect(page.locator('[data-view="detail"]')).toBeVisible();
  };
  const openByTitle = async title => { const id = Number(await page.locator('#library-grid [data-row-play]').filter({ hasText: title }).getAttribute('data-row-play')); await openDetail(id); };
  const add = async paths => {
    await nav('import'); await page.locator('#file-input').setInputFiles(paths);
    await expect(page.locator('#batch-form')).toBeVisible();
  };
  await page.goto(url);
  await expect(page.locator('#home-empty')).toBeVisible();
  await expect(page.locator('#manage-toggle')).toHaveCount(0);
  await nav('import');
  await page.locator('#choose-files').focus();
  await expect(page.locator('#choose-files')).toBeFocused();
  const chooserPromise = page.waitForEvent('filechooser'); await page.locator('#choose-files').press('Enter');
  const chooser = await chooserPromise; await chooser.setFiles([]);
  await expect(page.locator('#import-select')).toBeVisible();
  const filePromise = page.waitForEvent('filechooser'); await page.locator('#choose-files').press('Enter');
  await (await filePromise).setFiles([...originals.keys()]);
  await expect(page.locator('#review-summary')).toHaveText('3곡을 추가할 수 있습니다');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  assert.equal((await getState()).tracks.length, 0);
  for (const path of originals.keys()) await access(path);
  // Native directory selection exercises webkitRelativePath and same-directory LRC matching.
  await expect(page.locator('#choose-folder')).toBeVisible();
  const folderPromise = page.waitForEvent('filechooser');
  await page.locator('#choose-folder').press('Enter');
  await (await folderPromise).setFiles(source);
  await expect(page.locator('#review-summary')).toHaveText('3곡을 추가할 수 있습니다');
  await expect(page.locator('#review-detail')).toContainText('분석 실패 1개');
  await page.getByRole('button', { name: '3곡 복사하여 추가', exact: true }).click();
  await expect(page.locator('#import-complete h2')).toHaveText('3곡 추가됨');
  await expect(page.locator('#mini-player')).toBeHidden();
  const listed = (await getState()).tracks;
  const initial = await Promise.all(listed.map(async track => (await page.request.get(`${url}/api/tracks/${track.id}`)).json()));
  assert.equal(new Set(initial.map(track => track.albumId)).size, 3);
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes);
  const second = initial.find(track => track.title === titles[1]);
  assert.deepEqual(await readFile(join(root, 'data/library', second.lyricsFilePath)), lrc);
  for (const track of initial) {
    const original = originals.get(join(source, `${titles.indexOf(track.title) + 1}.flac`));
    assert.deepEqual(await readFile(join(root, 'data/library', track.managedPath)), original);
  }
  note({ check: 'folder-file-copy-cancel-and-original-bytes', tracks: initial.length, pass: true });
  await page.getByRole('button', { name: '추가한 곡 듣기', exact: true }).click();
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', new RegExp('재생 중'));
  assert.deepEqual((await queue()).ids, titles.map(title => initial.find(track => track.title === title).id));
  // Measure actual graph output; this cannot establish human/device audibility.
  await expect.poll(() => page.evaluate(() => {
    const ctx = window.__audio.contexts[0]; if (!ctx?.__meter) return 0;
    const samples = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
  })).toBeGreaterThan(.01);
  note({ check: 'actual-audio-graph', ...(await page.evaluate(() => {
    const ctx = window.__audio.contexts[0]; const values = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(values);
    return { contextState: ctx.state, rms: Math.sqrt(values.reduce((sum, n) => sum + n * n, 0) / values.length), peak: Math.max(...values.map(Math.abs)), starts: window.__audio.starts };
  })) });
  const activeQueue = await queue(); await nav('import');
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  assert.deepEqual((await queue()).ids, activeQueue.ids);
  assert.equal(await page.evaluate(() => window.__audio.contexts.length), 1);
  await page.locator('#mini-play').click();
  await nav('library');
  await page.getByRole('searchbox', { name: '음악 검색' }).fill('연결');
  const displayed = await page.locator('#library-grid [data-row-play]').evaluateAll(buttons => buttons.map(button => Number(button.dataset.rowPlay)));
  await page.locator('#library-grid [data-row-play]').nth(1).click();
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('검색 결과 · 2/3');
  await page.getByRole('searchbox').fill('없는 검색어');
  await expect(page.locator('#play-collection')).toHaveCount(0);
  assert.deepEqual((await queue()).ids, displayed);
  await page.locator('#mini-track').click();
  await manage();
  await page.getByLabel('원문 가사', { exact: false }).fill('[00:00]저장 전 원문');
  await ensureLyricsEditing(page); await page.getByLabel('한국어 번역').fill('저장 전 번역');
  await ensureLyricsEditing(page); await page.getByLabel('한국어 번역').fill('둘째 곡 초안');
  await nav('library'); await page.getByRole('searchbox').fill('');
  await openByTitle(titles[0]);
  
  await expect(page.getByLabel('한국어 번역')).toHaveValue('');
  await ensureLyricsEditing(page); await page.getByLabel('한국어 번역').fill('첫 곡 초안');
  await nav('library'); await openDetail(displayed[1]);
  await ensureLyricsEditing(page);
  await expect(page.getByLabel('한국어 번역')).toHaveValue('둘째 곡 초안');
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('검색 결과 · 3/3');
  await expect(page.locator('#detail-content h1')).toHaveText(titles[1]);
  await expect(page.getByLabel('한국어 번역')).toHaveValue('둘째 곡 초안');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '대기열 재생 완료', { timeout: 15000 });
  await expect(page.locator('#mini-next')).toBeDisabled();
  note({ check: 'cross-album-middle-to-last-natural-playback-and-drafts', queue: await queue(), pass: true });
  await page.route('**/api/tracks/*/notes', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '테스트 저장 실패' }) }));
  await ensureLyricsEditing(page); await page.getByRole('button', { name: '가사 저장', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('테스트 저장 실패');
  await expect(page.getByLabel('한국어 번역')).toHaveValue('둘째 곡 초안');
  await page.unroute('**/api/tracks/*/notes');
  let releaseSave, holdingSave = false;
  await page.route('**/api/tracks/*/notes', async route => {
    const response = await route.fetch(); holdingSave = true;
    await new Promise(resolve => { releaseSave = resolve; }); await route.fulfill({ response });
  });
  await ensureLyricsEditing(page); await page.getByRole('button', { name: '가사 저장', exact: true }).click();
  await expect.poll(() => holdingSave).toBe(true);
  await ensureLyricsEditing(page); await page.getByLabel('한국어 번역').fill('저장 응답을 기다리며 더 작성');
  releaseSave();
  await expect(page.locator('#toast')).toContainText('가사 저장됨');
  await expect(page.locator('[data-detail-draft]')).toBeVisible();
  await page.unroute('**/api/tracks/*/notes');
  await ensureLyricsEditing(page); await page.getByRole('button', { name: '가사 저장', exact: true }).click();
  await expect(page.locator('[data-detail-draft]')).toBeHidden();
  await nav('library'); await openByTitle(titles[0]);
  
  await expect(page.getByLabel('한국어 번역')).toHaveValue('첫 곡 초안');
  const warningPromise = page.waitForEvent('dialog');
  const cancelledReload = page.reload({ timeout: 2000 }).catch(() => {});
  const warning = await warningPromise; assert.equal(warning.type(), 'beforeunload'); await warning.dismiss(); await cancelledReload;
  await expect(page.getByLabel('한국어 번역')).toHaveValue('첫 곡 초안');
  await page.route('**/api/state', route => route.abort('failed'));
  await ensureLyricsEditing(page); await page.getByRole('button', { name: '가사 저장', exact: true }).click();
  await expect(page.locator('[data-detail-draft]')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('저장했습니다. 컬렉션은 다시 불러와 주세요.');
  await page.unroute('**/api/state');
  note({ check: 'save-failure-and-edits-during-save', beforeUnloadWarning: true, saveSuccessDespiteRefreshFailure: true, pass: true });
  // Decode failure and late preload are exercised through the same app/player.
  await page.reload(); await nav('library');
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  let releaseAudio, holdingAudio = false;
  await page.route(`**/api/tracks/${displayed[1]}/audio`, async route => {
    holdingAudio = true; await new Promise(resolve => { releaseAudio = resolve; }); await route.continue();
  });
  await page.locator('#library-grid [data-row-play]').first().click();
  await expect.poll(() => holdingAudio).toBe(true);
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('2/3');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '불러오는 중');
  releaseAudio();
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('2/3');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
  await page.unroute(`**/api/tracks/${displayed[1]}/audio`);
  await page.locator('#mini-play').click();
  // Reload clears decoded buffers so the corrupted response reaches decodeAudioData.
  await page.reload(); await nav('library');
  await page.route(`**/api/tracks/${displayed[1]}/audio`, route => route.fulfill({ contentType: 'audio/flac', body: Buffer.from('corrupt FLAC') }));
  await page.locator('#library-grid [data-row-play]').first().click();
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', new RegExp('다음 곡 준비 실패'));
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', new RegExp('재생 실패'), { timeout: 15000 });
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('2/3');
  await page.unroute(`**/api/tracks/${displayed[1]}/audio`);
  await page.locator('#mini-play').click();
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
  await page.locator('#mini-play').click();
  // Switching tracks while an old audio fetch is pending must not start the old track.
  await page.reload(); await nav('library');
  let releaseOld, holdingOld = false;
  await page.route(`**/api/tracks/${displayed[0]}/audio`, async route => { holdingOld = true; await new Promise(resolve => { releaseOld = resolve; }); await route.continue(); });
  await page.locator('#library-grid [data-row-play]').first().click(); await expect.poll(() => holdingOld).toBe(true);
  await page.locator('#library-grid [data-row-play]').nth(2).click();
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('3/3');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); releaseOld();
  await expect.poll(() => page.evaluate(() => window.__audio.starts.length)).toBe(1);
  await page.unroute(`**/api/tracks/${displayed[0]}/audio`);
  await page.locator('#mini-play').click();
  note({ check: 'late-preload-decode-failure-and-stale-audio', pass: true });
  // Known partial failure: retry only the failed file.
  const extras = [];
  for (let i = 0; i < 3; i++) {
    const path = join(root, `extra-${i}.flac`); await writeFile(path, playableFlac({ title: `추가 ${i}`, seconds: 1, frequency: 500 + i * 50 })); extras.push(path);
  }
  let commitCount = 0;
  await page.route('**/api/commit', route => {
    commitCount++;
    if (commitCount === 2) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '테스트 저장 공간 부족' }) });
    return route.continue();
  });
  await add(extras.slice(0, 2)); await page.locator('#commit-import').click();
  await expect(page.locator('#import-complete h2')).toHaveText('1곡 추가됨');
  await expect(page.locator('#complete-warnings')).toContainText('테스트 저장 공간 부족');
  await page.locator('#review-failed').click(); await expect(page.locator('#review-summary')).toHaveText('1곡을 추가할 수 있습니다');
  await page.locator('#commit-import').click(); await expect(page.locator('#import-complete h2')).toHaveText('2곡 추가됨');
  assert.equal(commitCount, 3); await page.unroute('**/api/commit');
  // Drop a successful response and the first status check; the UI must not claim failure or resubmit.
  await page.locator('#import-another').click();
  let lostCommitCount = 0;
  await page.route('**/api/commit', async route => { lostCommitCount++; await route.fetch(); await route.abort('failed'); });
  await page.route('**/api/imports/*', route => route.abort('failed'));
  await add([extras[2]]); await page.locator('#commit-import').click();
  await expect(page.locator('#complete-copy')).toContainText('완료 여부를 확인하지 못했습니다');
  await expect(page.locator('#uncertain-imports')).toBeVisible(); await expect(page.locator('#complete-warnings')).toBeHidden();
  await expect(page.locator('#play-imported')).toBeDisabled();
  await page.unroute('**/api/imports/*'); await page.locator('#review-failed').click();
  await expect(page.locator('#import-complete h2')).toHaveText('1곡 추가됨');
  assert.equal(lostCommitCount, 1); await page.unroute('**/api/commit');
  await access(extras[2]);
  note({ check: 'partial-failure-and-lost-success-response', pass: true });
  // Duplicate-only and low/unknown-bitrate selections must show their filenames and reasons.
  await page.locator('#import-another').click(); await add([extras[2]]);
  await expect(page.locator('#review-summary')).toHaveText('추가할 새 음원이 없습니다');
  await expect(page.locator('#review-exclusions')).toContainText('이미 소장한 동일 파일');
  await expect(page.locator('#commit-import')).toBeDisabled(); await page.locator('#cancel-import').click();
  const lowFiles = [];
  for (const [i, name] of ['50-Most-Famous.m4a', '𝙋𝙡𝙖𝙮𝙡𝙞𝙨𝙩-노르웨이-숲이.m4a'].entries()) {
    const path = join(root, name);
    const bytes = playableFlac({ title: `음질 제한 없음 ${i}`, frequency: 880 + i * 50, seconds: 1 });
    await writeFile(path, bytes); lowFiles.push(path); originals.set(path, bytes);
  }
  // Stage metadata isolates the import policy from codec decoding: the first
  // selection reports 128kbps AAC, the other reports an unknown bitrate.
  await page.route('**/api/stage', async route => {
    const response = await route.fetch(); const data = await response.json();
    Object.assign(data.metadata, { format: 'AAC', lossless: false, bitrate: data.metadata.title.endsWith('0') ? 128000 : null });
    await route.fulfill({ response, json: data });
  });
  await add(lowFiles); await expect(page.locator('#review-summary')).toHaveText('2곡을 추가할 수 있습니다');
  await expect(page.locator('#review-exclusions')).not.toContainText('음질 기준 미달');
  await expect(page.locator('#commit-import')).toBeEnabled();
  await page.locator('#commit-import').click(); await expect(page.locator('#import-complete h2')).toHaveText('2곡 추가됨');
  await page.unroute('**/api/stage');
  note({ check: 'low-and-unknown-bitrate-m4a-copy-allowed', pass: true });
  await page.locator('#import-another').click();
  // Move warning uses a real test folder with deletion denied, then restores its mode.
  const moveDir = join(root, 'move-source'); await mkdir(moveDir);
  const moveAudio = join(moveDir, 'move.flac'); await writeFile(moveAudio, playableFlac({ title: '이동 원본 보존', frequency: 990, seconds: 1 }));
  await chmod(moveDir, 0o555);
  try {
    await page.locator('.move-import summary').click(); await page.locator('#local-paths').fill(moveAudio);
    await page.getByRole('button', { name: '이동할 음악 확인', exact: true }).click();
    await expect(page.locator('#review-summary')).toHaveText('1곡을 추가할 수 있습니다');
    await page.getByRole('button', { name: '1곡 이동', exact: true }).click();
    await expect(page.locator('#import-complete h2')).toHaveText('1곡 추가됨');
    await expect(page.locator('#preservation-warnings')).toContainText('원본은 남겼습니다');
    await access(moveAudio);
  } finally { await chmod(moveDir, 0o755); }
  await nav('library');
  await page.getByRole('searchbox').fill('연결');
  await page.locator('#library-grid [data-row-play]').first().press('Shift+F10');
  await expect(page.locator('#library-grid .song-menu').first()).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.locator('#library-grid [data-row-play]').first()).toBeFocused();
  // Theme responds live to OS setting, manual override persists over reload.
  await page.locator('#settings-open').click(); await page.getByLabel('밝기').selectOption('system'); await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(28, 28, 30)');
  await page.getByLabel('밝기').selectOption('light');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 250, 250)');
  await page.getByLabel('밝기').selectOption('dark'); await page.reload();
  await expect(page.getByLabel('밝기')).toHaveValue('dark');
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  await nav('library');
  await page.screenshot({ path: join(artifacts, 'collection-normal-1280.png'), fullPage: true });
  await expect(page.locator('[data-view="artists"]')).toHaveCount(0);
  // Long mixed-script data tests wrapping without touching a stored track.
  await page.locator('.collection-song strong').first().evaluate(el => el.textContent = '아주 긴 한국어 中文 日本語 EnglishTitle'.repeat(7));
  const layouts = [];
  for (const width of [320, 390, 768, 1280]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 }); await page.locator('#settings-open').click(); await page.getByLabel('밝기').selectOption(theme); await page.keyboard.press('Escape');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: 'Collection', exact: true })).toBeVisible();
      await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed', 'true'); await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.app-shell')).paddingBottom) >= document.querySelector('#mini-player').offsetHeight)).toBe(true);
      const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, playerHeight: document.querySelector('#mini-player').offsetHeight, padding: parseFloat(getComputedStyle(document.querySelector('.app-shell')).paddingBottom) }));
      assert.ok(metrics.padding >= metrics.playerHeight);
      layouts.push({ width, theme, ...metrics }); console.log(JSON.stringify({ check: 'layout', width, theme, ...metrics }));
      if ((width === 1280 && theme === 'light') || (width === 390 && theme === 'dark')) await page.screenshot({ path: join(artifacts, `collection-${width}-${theme}.png`), fullPage: true });
    }
  }
  // A 1280×900 surface at 200% has a 640×450 CSS viewport and DPR 2.
  const zoomContext = await browser.newContext({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2, storageState: await context.storageState(), colorScheme: 'dark' });
  const zoomPage = await zoomContext.newPage(); zoomPage.on('pageerror', error => errors.push(error.message)); await zoomPage.goto(url);
  await expect(zoomPage.locator('#mini-player')).toBeVisible();
  assert.equal(await zoomPage.evaluate(() => innerWidth), 640);
  assert.equal(await zoomPage.evaluate(() => devicePixelRatio), 2);
  for (const route of ['library', 'import', 'queue']) {
    if (route === 'import') { await zoomPage.locator('.nav-button[data-route="library"]').click(); await zoomPage.locator('#settings-open').click(); await zoomPage.locator('#collection-add').click(); }
    else if (route === 'queue') await zoomPage.locator('#queue-open').click();
    else await zoomPage.locator(`.nav-button[data-route="${route}"]`).click();
    await expect.poll(() => zoomPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await zoomPage.locator('#volume-open').click(); await expect(zoomPage.locator('#volume-open')).toHaveAttribute('aria-pressed', 'true'); await zoomPage.locator('#volume-open').click(); await expect(zoomPage.locator('#volume-open')).toHaveAttribute('aria-pressed', 'false');
  }
  await zoomPage.screenshot({ path: join(artifacts, 'zoom-200.png'), fullPage: true });
  await zoomContext.close();
  note({ check: 'zoom-200-equivalent-reflow', cssViewport: '640x450', deviceScaleFactor: 2, surface: '1280x900', pass: true });
  await page.setViewportSize({ width: 320, height: 800 });
  for (const route of ['home', 'import', 'queue', 'library']) {
    await nav(route);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await nav('import'); await page.screenshot({ path: join(artifacts, 'import-320.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const final = (await getState()).tracks;
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes);
  assert.equal((await (await fetch(`${url}/api/tracks/${second.id}`)).json()).lyricsTranslation, '저장 응답을 기다리며 더 작성');
  note({ check: 'themes-keyboard-layouts-200percent', layouts, pass: true });
  note({ check: 'complete', artifacts, finalTrackCount: final.length, originalsUnchanged: true, pageErrors: errors, root });
  await writeFile(join(artifacts, 'browser-results.json'), JSON.stringify({ observations, errors }, null, 2));
});
