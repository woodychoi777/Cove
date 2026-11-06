import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';
import { openCollectionSong, navigateTo } from './song-ui.mjs';

test('곡 정보 팝업: 통합 편집·실패/저장중 최신 입력·초안·재생 보호와 Today 간격', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright', { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const temp = await mkdtemp(join(tmpdir(), 'cove-info-browser-'));
  const out = resolve(process.env.INFO_ARTIFACT_DIR || join(temp, 'evidence')); await mkdir(out, { recursive: true });
  const url = 'http://127.0.0.1:45317';
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '45317', SORISEOJAE_DATA_DIR: join(temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk);
  await new Promise((ok, no) => { const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); ok(); } }); server.on('exit', () => { clearTimeout(timer); no(Error(stderr)); }); });
  const tracks = [], originals = [], checks = [], layouts = [], errors = [];
  for (let i = 0; i < 5; i++) {
    const bytes = playableFlac({ title: `편집 검사 ${i}`, artist: '공유 가수', album: '같은 앨범', seconds: 20, frequency: 330 + i * 70 }); originals.push(bytes);
    const staged = await (await fetch(`${url}/api/stage`, { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: bytes })).json();
    const track = await (await fetch(`${url}/api/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: { lrcText: '[00:00]첫 줄\n[00:10]다음 줄', lrcSourceName: 'original.lrc' } }) })).json();
    await fetch(`${url}/api/tracks/${track.id}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isLifeSong: true, memory: '코멘트 보존' }) });
    await fetch(`${url}/api/tracks/${track.id}/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listenedMs: 11000 }) });
    tracks.push(await (await fetch(`${url}/api/tracks/${track.id}`)).json());
  }
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png') }).catch(() => {}); await writeFile(join(out, 'partial.json'), JSON.stringify({ checks, layouts, errors }, null, 2)); await browser.close(); });
  const state = async () => (await page.request.get(`${url}/api/state`)).json();
  const detail = async id => (await page.request.get(`${url}/api/tracks/${id}`)).json();
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const nav = route => navigateTo(page, route);
  const dialog = page.locator('#track-info-dialog'), form = page.locator('#track-info-form');
  async function edit(id) {
    await nav('library'); await openCollectionSong(page, id);
    await expect(page.locator('#detail-content .detail-actions button')).toHaveCount(3);
    await expect(page.locator('#detail-content .song-menu')).toHaveCount(0);
    await page.locator('#detail-content [data-edit-info]').click();
    await expect(dialog).toBeVisible(); await expect(form.locator('[name="title"]')).toBeEnabled();
  }
  await page.goto(url);
  await expect(page.locator('#favorites-list .rediscovery-card')).toHaveCount(4);
  const firstId = Number(await page.locator('#recent-listening-list [data-row-play]').first().getAttribute('data-row-play'));
  await page.locator(`#recent-listening-list [data-row-play="${firstId}"]`).click();
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await page.locator('#mini-play').click();
  for (const width of [1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; };
      const row = document.querySelector('#recent-listening-list .collection-row.is-current');
      const cover = row.querySelector('.cover');
      const cards = [...document.querySelectorAll('#favorites-list .rediscovery-card')];
      const recent = document.querySelector('.today-recent').getBoundingClientRect();
      return { width: innerWidth, inset: cover.getBoundingClientRect().left - row.getBoundingClientRect().left,
        cards: cards.map(box), recent: box(document.querySelector('.today-recent')), recentBelow: recent.top > cards[0].getBoundingClientRect().bottom,
        plusXs: [...document.querySelectorAll('#recent-listening-list [data-quick-append]')].map(el => el.getBoundingClientRect().x), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert(layout.inset >= 12); assert.equal(new Set(layout.plusXs).size, 1); assert.equal(layout.overflow, false);
    if (width === 1440) { assert(layout.cards[0].width < 290); assert(layout.recent.x - layout.cards[1].right >= 72); }
    if (width <= 1000) assert(layout.recentBelow);
    layouts.push(layout); await page.screenshot({ path: join(out, `today-${width}.png`) });
  }
  checks.push('selected-row-left-blue-inset-fixed-plus-four-smaller-cards-72px-gap-existing-breakpoints');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const a = tracks[0], b = tracks[1]; await edit(a.id);
  const beforeQueue = await queue();
  await form.locator('[name="title"]').fill('바꾼 곡 이름'); await form.locator('[name="artist"]').fill('선택 곡 가수');
  await form.locator('[name="lyricsOriginal"]').fill('[00:00]새 가사\n[00:10]나중 가사');
  await form.locator('[name="lyricsTranslation"]').fill('새 번역\n나중 번역');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.locator('#track-info-image').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#track-info-image-undo')).toBeVisible();
  assert.equal((await detail(a.id)).title, a.title); assert.equal((await detail(a.id)).artworkPath, a.artworkPath);
  await page.screenshot({ path: join(out, 'editor-desktop.png') });
  let release, requested = false, delivered = false;
  const path = `**/api/tracks/${a.id}/info`;
  await page.route(path, async route => { const response = await route.fetch(); requested = true; await new Promise(ok => release = ok); await route.fulfill({ response }); delivered = true; });
  await form.locator('.primary-button').click(); await expect.poll(() => requested).toBe(true);
  // Reverting to the original baseline while a different title is in flight must remain dirty.
  await form.locator('[name="title"]').fill(a.title);
  release(); await expect.poll(() => delivered).toBe(true); await page.unroute(path);
  await expect(form.locator('.primary-button')).toBeEnabled(); await expect(dialog).toBeVisible();
  await expect(form.locator('[name="title"]')).toHaveValue(a.title); await expect(page.locator('#track-info-draft')).toBeVisible();
  assert.equal((await detail(a.id)).title, '바꾼 곡 이름');
  await form.locator('.primary-button').click(); await expect(dialog).toBeHidden();
  const saved = await detail(a.id), sibling = await detail(b.id);
  assert.equal(saved.title, a.title); assert.equal(saved.artist, '선택 곡 가수'); assert.equal(sibling.artist, b.artist);
  assert.equal(saved.lyricsOriginal, '[00:00]새 가사\n[00:10]나중 가사'); assert.equal(saved.lyricsTranslation, '새 번역\n나중 번역');
  assert.equal(saved.memory, '코멘트 보존'); assert.equal(saved.isLifeSong, true); assert.equal(saved.artworkPath, sibling.artworkPath);
  assert.deepEqual(await queue(), beforeQueue);
  await expect(page.locator('[data-detail-artist]')).toHaveText('선택 곡 가수');
  await expect(page.locator('[data-lyrics-lines]')).toContainText('새 번역');
  checks.push('single-modal-four-fields-and-image-one-save-shared-artist-safe-original-baseline-revert-preserved-queue-and-live-lyrics-update');

  await edit(a.id); await form.locator('[name="title"]').fill('실패 뒤 재시도');
  await page.route(path, route => route.fulfill({ status: 500, json: { error: '임시 저장 실패' } }));
  await form.locator('.primary-button').click(); await expect(page.locator('#track-info-error')).toHaveText('임시 저장 실패');
  await expect(form.locator('[name="title"]')).toHaveValue('실패 뒤 재시도'); assert.equal((await detail(a.id)).title, a.title);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await edit(a.id); await expect(form.locator('[name="title"]')).toHaveValue('실패 뒤 재시도');
  await page.unroute(path); await form.locator('.primary-button').click(); await expect(dialog).toBeHidden();
  assert.equal((await detail(a.id)).title, '실패 뒤 재시도');
  checks.push('failed-save-keeps-db-and-input-close-reopen-draft-retry');

  await edit(a.id);
  for (const [width, height] of [[1440,1000],[720,700],[390,700],[320,700],[600,434]]) {
    await page.setViewportSize({ width, height });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await form.locator('[name="lyricsTranslation"]').focus();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const fits = await dialog.evaluate(el => { const r=el.getBoundingClientRect(), action=el.querySelector('.form-actions').getBoundingClientRect(); return r.top>=0&&r.bottom<=innerHeight&&r.width<=innerWidth&&action.top>=r.top&&action.bottom<=r.bottom; });
      assert(fits);
      await form.locator('[name="lyricsTranslation"]').press('Tab');
      await form.locator('.primary-button').focus(); await expect(form.locator('.primary-button')).toBeInViewport();
      if (scheme === 'light' && [390,600].includes(width)) await page.screenshot({ path: join(out, `editor-${width}.png`) });
    }
  }
  checks.push('light-dark-10-modal-sizes-scrollable-body-fixed-save-footer-no-horizontal-overflow');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 }); await nav('library');
  const emptyId = tracks[4].id;
  await page.request.put(`${url}/api/tracks/${emptyId}/notes`, { data: { lyricsOriginal: '', lyricsTranslation: '' } });
  await openCollectionSong(page, emptyId); await page.locator('[data-add-lyrics]').click();
  await expect(dialog).toBeVisible(); await expect(form.locator('[name="lyricsOriginal"]')).toBeFocused(); await page.keyboard.press('Escape');
  const token = (await state()).localToken;
  assert.equal((await page.request.put(`${url}/api/tracks/${a.id}/info`, { data: { changes: { title: '거부' } } })).status(),403);
  assert.equal((await page.request.put(`${url}/api/tracks/${a.id}/info`, { headers: { 'x-local-token': token }, data: { changes: { title: '' }, artwork: png.toString('base64') } })).status(),400);
  assert.equal((await detail(a.id)).title, '실패 뒤 재시도');
  for(let i=0;i<tracks.length;i++) {
    const row=await detail(tracks[i].id);
    assert.deepEqual(await readFile(join(temp,'data/library',row.managedPath)),originals[i]);
    assert.equal(await readFile(join(temp,'data/library',row.lyricsFilePath),'utf8'),'[00:00]첫 줄\n[00:10]다음 줄');
  }
  assert.deepEqual(errors,[]);
  checks.push('empty-lyrics-entry-opens-modal-original-input-token-validation-invalid-combined-save-no-audio-or-lrc-changes');
  await writeFile(join(out,'results.json'),JSON.stringify({checks,layouts,errors,temp},null,2)); console.log(JSON.stringify({out,checks,errors}));
});
