import { openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';
import { navigateTo, songMenu, openComments } from './song-ui.mjs';

test('Collection 플레이리스트: 설정 생성·추가/중복·편집/보호·충돌·재생독립·재시작/내보내기', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 180000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'cove-playlists-browser-'));
  const out = resolve(process.env.PLAYLIST_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  let server, stderr = '';
  async function start() {
    server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '41317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', chunk => stderr += chunk);
    await new Promise((ok, no) => { const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); ok(); } }); server.on('exit', code => { clearTimeout(timer); no(Error(`server ${code}: ${stderr}`)); }); });
  }
  await start(); t.after(() => server.kill('SIGTERM'));
  const url = 'http://127.0.0.1:41317';
  const api = async (path, method = 'GET', body, status = 200, token = true) => {
    const state = await (await fetch(url + '/api/state')).json();
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-local-token': state.localToken } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, status, path); return response.json();
  };
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], checks = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/api/playlists') && r.method() !== 'GET') requests.push({ url: r.url(), method: r.method() }); });
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png') }).catch(() => {}); await writeFile(join(out, 'partial.json'), JSON.stringify({ root, checks, errors })); await browser.close(); });
  await page.addInitScript(() => { const Native = AudioContext; window.__starts = 0; window.AudioContext = class extends Native { createBufferSource() { const b = super.createBufferSource(), start = b.start.bind(b); b.start = (...args) => { window.__starts++; return start(...args); }; return b; } }; });
  const nav = route => navigateTo(page, route);
  const selectedTab = () => page.locator('#playlist-tabs [aria-selected="true"]');
  const select = id => page.locator(`#playlist-tabs [data-playlist-id="${id ?? ''}"]`).click();
  const ids = () => page.locator('#library-grid [data-current-id]').evaluateAll(rows => rows.map(row => Number(row.dataset.currentId)));
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const createOpen = async () => { await nav('library'); await page.locator('#playlist-create').click(); await expect(page.locator('#settings-dialog')).not.toBeVisible(); await expect(page.locator('#playlist-name-dialog')).toBeVisible(); };
  const create = async name => { await createOpen(); await page.locator('#playlist-name-form [name="name"]').fill(name); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-dialog')).not.toBeVisible(); return Number(await selectedTab().getAttribute('data-playlist-id')); };
  const menu = async action => { await page.locator('#playlist-tabs [aria-selected="true"]').press('Shift+F10'); await page.locator(action).click(); };
  const rowMenu = async (id, action) => { await page.locator(`#library-grid [data-current-id="${id}"] [data-row-play]`).press('Shift+F10'); await page.locator(`.song-menu:popover-open ${action}`).click(); };
  const edit = () => menu('#playlist-edit');
  const pause = async () => { if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').click(); };
  await page.goto(url); await nav('library');
  await expect(page.locator('#collection-summary')).toHaveCount(0);
  await expect(page.locator('[data-view="library"] #playlist-create')).toHaveCount(1);
  await createOpen(); await page.locator('#playlist-name-dialog [data-dialog-close]').click(); await expect(page.locator('#settings-dialog')).toBeHidden(); await expect(page.locator('#playlist-create')).toBeFocused(); await page.keyboard.press('Escape');
  await createOpen(); await page.locator('#playlist-name-form [name="name"]').fill('   '); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-error')).toBeVisible();
  await page.locator('#playlist-name-form [name="name"]').fill('첫 목록'); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-dialog')).toBeHidden();
  const first = Number(await selectedTab().getAttribute('data-playlist-id'));
  await expect(page.locator('#play-collection, #playlist-select')).toHaveCount(0); await expect(page.locator('#library-empty')).toContainText('곡을 추가해 보세요');
  await page.locator('#empty-playlist-add').click(); await expect(page.locator('#playlist-add-empty')).toBeVisible(); await page.locator('#playlist-import-link').click(); await expect(page.locator('[data-view="import"]')).toBeVisible(); await page.keyboard.press('Escape');
  await api('/api/playlists', 'POST', { name: '거부' }, 403, false);
  checks.push('settings-only-create-cancel-focus-inline-name-error-empty-list-empty-library-and-token');

  const tracks = [], originals = [], lrc = '[00:00]First original\n[00:02]第一句翻译\n[00:02]Second original\n[00:04]第二句翻译\n[00:04]Third original\n[00:06]第三句翻译\n[00:06]Fourth original\n[00:08]第四句翻译\n[00:08]';
  for (let i = 0; i < 4; i++) {
    originals.push(playableFlac({ title: i < 2 ? '같은 곡명' : `목록 검사 ${i}`, artist: `검사 가수 ${i}`, album: `검사 앨범 ${i}`, seconds: 12, frequency: 330 + i * 110 }));
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: originals[i] })).json();
    const r = await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: { lrcText: lrc, lrcSourceName: 'original.lrc' } }) })).json(); tracks.push(await api('/api/tracks/' + r.id));
  }
  const [a, b, c, d] = tracks;
  await api('/api/queues', 'POST', { name: '기존 중복 큐', trackIds: [a.id, b.id, a.id] }, 201);
  await page.reload(); await nav('library'); await select(first);
  await page.locator('#empty-playlist-add').click(); await page.locator(`[data-pick-track="${a.id}"]`).check(); await page.locator(`[data-pick-track="${b.id}"]`).check(); await page.locator('#playlist-add-dialog [data-dialog-close]').click(); assert.deepEqual((await api('/api/playlists/' + first)).trackIds, []);
  await page.locator('#empty-playlist-add').click(); await page.locator(`[data-pick-track="${a.id}"]`).check(); await page.locator('#playlist-add-search').fill('가수 1'); await page.locator(`[data-pick-track="${b.id}"]`).check();
  await page.route('**/api/playlists/' + first, route => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { error: '검사 추가 실패' } }) : route.continue());
  await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-error')).toHaveText('검사 추가 실패'); await expect(page.locator(`[data-pick-track="${b.id}"]`)).toBeChecked();
  await page.unroute('**/api/playlists/' + first); await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-dialog')).toBeHidden();
  assert.deepEqual(await ids(), [b.id, a.id]);
  await page.locator('#playlist-add').click(); await expect(page.locator(`[data-pick-track="${a.id}"]`)).toBeDisabled(); await expect(page.locator(`[data-pick-track="${b.id}"]`)).toBeDisabled(); await page.locator(`[data-pick-track="${c.id}"]`).check(); await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-dialog')).toBeHidden(); assert.deepEqual(await ids(), [b.id, a.id, c.id]);
  await page.locator('#search-input').fill('가수 2'); assert.deepEqual(await ids(), [c.id]); await select(null); await expect(page.locator('#search-input')).toHaveValue(''); assert.deepEqual(await ids(), [d.id, c.id, b.id, a.id]);
  checks.push('multi-select-cancel-filter-preserves-hidden-selection-failure-retry-ID-dedup-global-order-current-scope-search');

  const second = await create('두 번째 목록'); await select(first); await createOpen(); await page.locator('#playlist-name-form [name="name"]').fill('첫 목록'); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-error')).toContainText('같은 이름'); await page.keyboard.press('Escape'); await expect(page.locator('#settings-dialog')).toBeHidden(); await page.keyboard.press('Escape'); await expect(page.locator('#settings-dialog')).toBeHidden();
  await select(null); await rowMenu(d.id, '[data-playlist-track]'); await expect(page.locator('#mini-player')).toBeHidden(); await page.locator(`[data-target-playlist="${second}"]`).click(); await expect(page.locator('#playlist-target-dialog')).toBeHidden(); assert.deepEqual((await api('/api/playlists/' + second)).trackIds, [d.id]);
  await select(first); await page.locator('#search-input').fill('가수 2'); assert.deepEqual(await ids(), [c.id]); await page.locator('#library-grid [data-row-play]').first().click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); await pause();
  assert.deepEqual((await queue()).ids, [c.id]); await page.locator('#search-input').fill('');
  await page.locator(`[data-row-play="${b.id}"]`).click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지'); await pause();
  const baselineQueue = await queue(), starts = await page.evaluate(() => window.__starts); assert.deepEqual(baselineQueue.ids, [b.id, a.id, c.id]);
  await page.locator('#mini-seek').evaluate(el => { el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator(`[data-row-play="${b.id}"]`).click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); await pause(); assert.deepEqual((await queue()).ids, baselineQueue.ids); assert.ok(Number(await page.locator('#mini-seek').inputValue()) >= 3);
  await menu('#playlist-rename'); await page.locator('#playlist-name-form [name="name"]').fill('이름이 바뀐 목록'); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-dialog')).toBeHidden(); assert.deepEqual((await queue()).ids, baselineQueue.ids);
  const renamed = await api('/api/playlists/' + first); assert.equal(renamed.name, '이름이 바뀐 목록');
  checks.push('duplicate-name-single-song-menu-no-play-saved-order-play-and-current-song-resume-rename-independent');
  await page.locator('#mini-play').click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  const continuousQueue = await queue(), continuousStarts = await page.evaluate(() => window.__starts);
  const transient = await create('재생 중 생성'); await page.locator('#empty-playlist-add').click();
  for (const id of [c.id, d.id]) await page.locator(`[data-pick-track="${id}"]`).check();
  await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-dialog')).toBeHidden();
  await edit(); await page.locator(`[data-playlist-up="${c.id}"]`).click(); await page.locator('#playlist-edit-save').click(); await expect(page.locator('#playlist-edit-bar')).toBeHidden();
  await menu('#playlist-rename'); await page.locator('#playlist-name-form [name="name"]').fill('재생 중 이름 변경'); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-dialog')).toBeHidden();
  await menu('#playlist-delete'); await page.locator('#playlist-delete-confirm').click(); await expect(page.locator('#playlist-delete-dialog')).toBeHidden();
  await select(first); assert.deepEqual(await queue(), continuousQueue); assert.equal(await page.evaluate(() => window.__starts), continuousStarts); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await page.locator('#mini-seek').evaluate(el => { el.value = '11.7'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(async () => (await queue()).index).toBe(1); await pause();
  checks.push('create-add-edit-rename-delete-do-not-interrupt-playing-audio-and-playlist-continues-naturally');


  await edit(); await expect(page.locator('#search-input')).toBeDisabled(); await page.locator(`[data-playlist-up="${c.id}"]`).click(); await page.locator(`[data-playlist-remove="${b.id}"]`).click(); assert.deepEqual(await ids(), [c.id, a.id]); assert.deepEqual((await api('/api/playlists/' + first)).trackIds, [b.id, a.id, c.id]);
  assert.deepEqual((await queue()).ids, baselineQueue.ids);
  await nav('home'); await nav('library'); await expect(page.locator('#playlist-edit-bar')).toBeVisible(); assert.deepEqual(await ids(), [c.id, a.id]);
  assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; }), true);
  await page.route('**/api/playlists/' + first, route => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { error: '검사 순서 저장 실패' } }) : route.continue()); await page.locator('#playlist-edit-save').click(); await expect(page.locator('#playlist-notice')).toContainText('검사 순서 저장 실패'); assert.deepEqual(await ids(), [c.id, a.id]); await page.unroute('**/api/playlists/' + first);
  const count = requests.length; let release, reached = false; await page.route('**/api/playlists/' + first, async route => { if (route.request().method() !== 'PATCH') return route.continue(); reached = true; await new Promise(ok => release = ok); await route.continue(); });
  await page.locator('#playlist-edit-save').click(); await expect.poll(() => reached).toBe(true); await expect(page.locator('#playlist-edit-save')).toBeDisabled(); await page.locator('#playlist-edit-save').evaluate(el => el.click()); assert.equal(requests.length, count + 1); release(); await expect(page.locator('#playlist-edit-bar')).toBeHidden(); await page.unroute('**/api/playlists/' + first);
  assert.deepEqual((await api('/api/playlists/' + first)).trackIds, [c.id, a.id]); assert.deepEqual((await queue()).ids, baselineQueue.ids);
  await edit(); await page.locator(`[data-playlist-remove="${a.id}"]`).click(); await page.locator('#playlist-edit-cancel').click(); assert.deepEqual(await ids(), [c.id, a.id]);
  await rowMenu(a.id, '[data-playlist-remove]'); await expect(page.locator('#playlist-edit-bar')).toBeVisible(); await page.locator('#playlist-edit-cancel').click();
  checks.push('temporary-reorder-remove-route-and-unload-protection-cancel-failure-retry-single-submit-and-queue-snapshot-independent');

  await page.locator('#playlist-add').click(); await page.locator(`[data-pick-track="${b.id}"]`).check(); const old = await api('/api/playlists/' + first); const remote = await api('/api/playlists/' + first, 'PATCH', { revision: old.revision, addTrackIds: [d.id] });
  await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-error')).toContainText('다른 창'); await expect(page.locator(`[data-pick-track="${b.id}"]`)).toBeChecked(); assert.deepEqual((await api('/api/playlists/' + first)).trackIds, remote.trackIds);
  await page.locator('#playlist-add-reload').click(); await expect(page.locator(`[data-pick-track="${d.id}"]`)).toBeDisabled(); await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-dialog')).toBeHidden(); assert.deepEqual((await api('/api/playlists/' + first)).trackIds, [c.id, a.id, d.id, b.id]);
  await edit(); await page.locator(`[data-playlist-up="${b.id}"]`).click(); const previous = await api('/api/playlists/' + first); await api('/api/playlists/' + first, 'PATCH', { revision: previous.revision, trackIds: [d.id, a.id] });
  await page.locator('#playlist-edit-save').click(); await expect(page.locator('#playlist-notice')).toContainText('다른 창'); assert.deepEqual(await ids(), [c.id, a.id, b.id, d.id]); await page.locator('#playlist-reload').click(); await expect.poll(ids).toEqual([d.id, a.id]); await page.locator('#playlist-edit-cancel').click();
  checks.push('cross-window-add-and-reorder-revision-conflicts-require-explicit-latest-reload-no-overwrite');

  const longName = '긴 & <목록> 감상 이름 '.repeat(5).trim(); await menu('#playlist-rename'); await page.locator('#playlist-name-form [name="name"]').fill(longName); await page.locator('#playlist-name-form .primary-button').click(); await expect(page.locator('#playlist-name-dialog')).toBeHidden();
  for (const scheme of ['light', 'dark']) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }, { width: 600, height: 434 }]) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize(viewport); await expect(selectedTab()).toHaveAttribute('title', longName);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await selectedTab().focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.getBoundingClientRect().right <= innerWidth), true);
    await page.locator('#playlist-add').click(); await page.locator('[data-pick-track]').last().focus(); assert.equal(await page.locator('#playlist-add-dialog').evaluate(el => el.contains(document.activeElement)), true);
    await page.screenshot({ path: join(out, `picker-${scheme}-${viewport.width}.png`) }); await page.keyboard.press('Escape');
    await page.screenshot({ path: join(out, `collection-${scheme}-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const queueBeforeDelete = await queue(); await menu('#playlist-delete'); await expect(page.locator('#playlist-delete-dialog')).toContainText(longName); await expect(page.locator('#playlist-delete-dialog')).toContainText('음악 파일은 유지됩니다'); await page.keyboard.press('Escape'); assert.ok(await api('/api/playlists/' + first));
  const latest = await api('/api/playlists/' + first); await menu('#playlist-delete'); await api('/api/playlists/' + first, 'PATCH', { revision: latest.revision, name: '다른 창 이름' }); await page.locator('#playlist-delete-confirm').click(); await expect(page.locator('#playlist-delete-error')).toContainText('다른 창'); await page.locator('#playlist-delete-reload').click(); await expect(page.locator('#playlist-delete-name')).toContainText('다른 창 이름'); await page.locator('#playlist-delete-confirm').click(); await expect(page.locator('#playlist-delete-dialog')).toBeHidden(); await expect(selectedTab()).toHaveAttribute('data-playlist-id',''); assert.deepEqual((await queue()).ids, queueBeforeDelete.ids);
  checks.push('long-name-title-light-dark-320-390-short-screen-keyboard-delete-cancel-conflict-and-current-queue-kept');

  await select(second); await page.locator('#playlist-add').click(); await page.locator(`[data-pick-track="${a.id}"]`).check(); const doomed = await api('/api/playlists/' + second); await api('/api/playlists/' + second, 'DELETE', { revision: doomed.revision }); await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-error')).toContainText('삭제'); await page.keyboard.press('Escape');
  await select(null); await rowMenu(a.id, '[data-playlist-track]'); await expect(page.locator('#playlist-target-empty')).toBeVisible(); await page.locator('#playlist-settings-link').click(); await expect(page.locator('#playlist-name-dialog')).toBeVisible(); await page.keyboard.press('Escape');
  const final = await create('재시작 보존'); await page.locator('#empty-playlist-add').click(); for (const id of [a.id, c.id, d.id]) await page.locator(`[data-pick-track="${id}"]`).check(); await page.locator('#playlist-add-save').click(); await expect(page.locator('#playlist-add-dialog')).toBeHidden();
  const saved = await api('/api/playlists/' + final), exported = await api('/api/export'); assert.equal(exported.schemaVersion, 2); assert.deepEqual(exported.playlists, [saved]); assert.deepEqual(exported.queues[0].trackIds, [a.id, b.id, a.id]);
  const stop = new Promise(ok => server.once('exit', ok)); server.kill('SIGTERM'); await stop; await start();
  await page.reload(); await nav('library'); await select(final); assert.deepEqual(await ids(), saved.trackIds); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-repeat').click(); await page.locator('#library-grid [data-row-play]').first().click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); assert.equal((await queue()).shuffle, true); assert.equal((await queue()).repeat, 'all'); assert.deepEqual((await queue()).ids.slice().sort(), saved.trackIds.slice().sort()); assert.deepEqual((await api('/api/playlists/' + final)).trackIds, saved.trackIds); await pause(); await openCollectionSong(page,d.id); await expect(page.locator('.lyric-translation')).toHaveCount(4); await songMenu(page, '[data-edit-info]'); await page.locator('#track-info-form [name="lyricsTranslation"]').fill('전환 후에도 남는 번역 초안'); await page.keyboard.press('Escape'); await openComments(page); await page.locator('#comment-text').fill('플레이리스트 작업 후 코멘트 초안'); await page.keyboard.press('Escape'); await nav('library'); await select(null); await openCollectionSong(page,d.id); await openComments(page); await expect(page.locator('#comment-text')).toHaveValue('플레이리스트 작업 후 코멘트 초안'); await page.keyboard.press('Escape'); await songMenu(page, '[data-edit-info]'); await expect(page.locator('#track-info-form [name="lyricsTranslation"]')).toHaveValue('전환 후에도 남는 번역 초안');
  for (let i = 0; i < tracks.length; i++) { const after = await api('/api/tracks/' + tracks[i].id); assert.deepEqual(await readFile(join(root, 'data/library', after.managedPath)), originals[i]); assert.equal(await readFile(join(root, 'data/library', after.lyricsFilePath), 'utf8'), lrc); assert.equal(after.lyricsOriginal, lrc); assert.equal(after.memory, tracks[i].memory); }
  assert.deepEqual(errors, []); checks.push('deleted-target-explicit-error-no-list-settings-path-restart-export-v2-legacy-queue-files-lyrics-and-drafts-preserved');
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, checks, errors, requests: requests.length }, null, 2)); console.log(JSON.stringify({ out, checks, errors }));
});
