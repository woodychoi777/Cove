import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { playableFlac } from './fixtures.mjs';
import { navigateTo } from './song-ui.mjs';
import { DAILY_RECOMMENDATIONS_KEY } from '../public/daily-recommendations.js';

test('Today 세 블록: 하루 선정·재실행·날짜/후보 갱신·우측+·목록 재생·파일/큐 보호', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 150000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright', { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'cove-three-blocks-'));
  const out = resolve(process.env.TODAY_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '34317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] }); t.after(() => server.kill('SIGTERM'));
  let stderr = ''; server.stderr.on('data', c => stderr += c);
  await new Promise((ok, no) => { const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000); server.stdout.on('data', c => { if (String(c).includes('프로토타입:')) { clearTimeout(timer); ok(); } }); server.on('exit', () => { clearTimeout(timer); no(Error(stderr)); }); });
  const url = 'http://127.0.0.1:34317', day = 86400000, now = new Date(2026, 9, 24, 12).getTime();
  const post = async (path, body) => { const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok); return r.json(); };
  const tracks = [], originals = [], checks = [], layouts = [], errors = [];
  const db = new DatabaseSync(join(root, 'data/soriseojae.sqlite')); t.after(() => db.close());
  const stamp = days => new Date(now - days * day).toISOString();
  let context, page;
  const profile = join(root, 'chrome-profile');
  async function launch() {
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chrome', viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Seoul' });
    await context.addInitScript(value => {
      const NativeDate = Date; window.__todayNow = value;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [window.__todayNow])); } static now() { return window.__todayNow; } };
      Math.random = () => 0;
    }, now);
    page = context.pages()[0]; page.on('pageerror', e => errors.push(e.message));

  }
  await launch();
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png'), fullPage: true }).catch(() => {}); await writeFile(join(out, 'partial.json'), JSON.stringify({ root, checks, layouts, errors, clock: await page.evaluate(() => ({injected: window.__todayNow, now: Date.now(), date: new Date().toString(), snapshot: localStorage.getItem('soriseojae.today-recommendations.v1')})).catch(() => null) }, null, 2)); await context.close(); });
  const nav = route => navigateTo(page, route);
  const snapshot = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), DAILY_RECOMMENDATIONS_KEY);
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const blockIds = id => page.locator(`#${id} [data-current-id]`).evaluateAll(rows => rows.map(row => Number(row.dataset.currentId)));
  const favorites = () => blockIds('favorites-list'), rediscovery = () => blockIds('rediscovery-list');
  const pause = async () => { if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').click(); };
  const plus = (block, id) => page.locator(`#${block} [data-quick-append="${id}"]`);
  await page.goto(url);
  await expect(page.locator('[data-view="home"] .page-header button, [data-view="home"] .top-tools, .today-actions, #random-song')).toHaveCount(0);
  for (const title of ['나의 최애곡', '최근 많이 들은 곡']) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('#favorites-list')).toHaveText('최애곡을 추가해 보세요'); await expect(page.locator('.today-rediscovery')).toBeHidden(); await expect(page.locator('#rediscovery-list')).toBeEmpty();
  checks.push('empty-rediscovery-hides-entire-section-without-empty-message');
  for (let i = 0; i < 6; i++) {
    const bytes = playableFlac({ title: i === 5 ? '길고 긴 제목이 버튼을 밀지 않습니다 '.repeat(6) : `오늘 검사 ${'ABCDEF'[i]}`, artist: i === 5 ? '알 수 없는 아티스트' : `검사 가수 ${i}`, album: `찾을 앨범 ${i}`, seconds: 12, frequency: 330 + i * 60 }); originals.push(bytes);
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: bytes })).json();
    tracks.push(await post('/api/commit', { importId: staged.importId, metadata: { lrcText: '[00:00]검사 첫 줄\n[00:06]다음 줄', lrcSourceName: '검사.lrc' } }));
  }
  const [a, b, c, d, e, f] = tracks;
  for (const track of tracks) db.prepare('UPDATE tracks SET created_at=?,last_played_at=?,is_life_song=?,memory=? WHERE id=?').run(stamp(150), stamp([a.id, b.id, e.id, f.id].includes(track.id) ? 100 : 1), track.id <= d.id ? 1 : 0, '기록 보존', track.id);
  for (const [track, count] of [[d, 3], [c, 2], [f, 1]]) for (let i = 0; i < count; i++) db.prepare('INSERT INTO playback_events(track_id,created_at,listened_ms,completed) VALUES(?,?,6000,0)').run(track.id, new Date().toISOString());
  const protectedRows = db.prepare('SELECT * FROM tracks').all();
  await nav('library'); await nav('home'); await expect(page.locator('#favorites-list .rediscovery-card')).toHaveCount(2); await expect(page.locator('#rediscovery-list .rediscovery-card')).toHaveCount(2);
  await expect(page.locator('[data-view="home"] .page-header button')).toHaveCount(0); await expect(page.locator('#settings-open')).toBeHidden();
  await expect(page.getByRole('heading', { name: '오랜만에 꺼내는 곡', exact: true })).toBeVisible();
  const initial = await snapshot(), favoriteIds = initial.favorites, oldIds = initial.rediscovery;
  assert(oldIds.every(id => !favoriteIds.includes(id))); assert.deepEqual(await blockIds('recent-listening-list'), [d.id, c.id, f.id]);
  assert.equal(await page.locator('[data-view="home"] [data-more], [data-view="home"] .song-menu').count(), 0);
  const idsBefore = await snapshot(); await nav('library'); await nav('home'); assert.deepEqual(await snapshot(), idsBefore); await page.reload(); await expect.poll(snapshot).toEqual(idsBefore);
  await context.close(); await launch(); await page.goto(url); await expect.poll(snapshot).toEqual(idsBefore);
  checks.push('daily-uniform-picks-persist-page-navigation-reload-real-profile-relaunch-and-independent-recent-ranking');

  await plus('recent-listening-list', d.id).click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  await plus('favorites-list', favoriteIds[0]).press('Space'); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); assert.deepEqual((await queue()).ids, [d.id]); await pause(); await plus('favorites-list', favoriteIds[0]).press('Enter'); await plus('favorites-list', favoriteIds[0]).press('Enter'); assert.deepEqual((await queue()).ids, [d.id, favoriteIds[0], favoriteIds[0]]);
  await page.locator(`#favorites-list .recommendation-cover[data-row-play="${favoriteIds[0]}"]`).click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); assert.deepEqual((await queue()).ids, favoriteIds);
  const position = Number(await page.locator('#mini-seek').inputValue()); await plus('rediscovery-list', oldIds[0]).click(); assert.deepEqual((await queue()).ids, [...favoriteIds, oldIds[0]]); assert.ok(Number(await page.locator('#mini-seek').inputValue()) >= position); await pause();
  const held = await queue(); await page.locator(`#favorites-list .recommendation-copy[data-row-play="${favoriteIds[0]}"]`).click(); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); assert.deepEqual(await queue(), held); await pause();
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-repeat').click(); const settings = await queue(); await plus('recent-listening-list', c.id).click(); assert.deepEqual((await queue()).ids, [...settings.ids, c.id]); assert.equal((await queue()).shuffle, true); assert.equal((await queue()).repeat, 'all');
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-repeat').click(); await page.locator('#mini-repeat').click();
  await page.locator(`#rediscovery-list .recommendation-cover[data-row-play="${oldIds[0]}"]`).click(); await pause(); assert.deepEqual((await queue()).ids, oldIds);
  await post(`/api/tracks/${oldIds[0]}/playback`, { listenedMs: 6000, completed: false }); await nav('library'); await nav('home'); assert.deepEqual(await rediscovery(), oldIds);
  const stableQueue = await queue(); assert.deepEqual((await snapshot()).rediscovery, oldIds);
  checks.push('all-blocks-plus-native-keys-empty-queue-no-autoplay-duplicates-current-resume-shuffle-repeat-and-rediscovery-snapshot-after-listen');

  for (const scheme of ['light', 'dark']) for (const width of [3010, 2560, 1920, 1440, 1280, 1000, 768, 600, 390, 320]) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('.today-columns').evaluate(el => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
      return { width: innerWidth, available: document.querySelector('[data-view="home"]').clientWidth - parseFloat(getComputedStyle(document.querySelector('[data-view="home"]')).paddingLeft) * 2,
        cols: getComputedStyle(el).gridTemplateColumns.split(' ').length, overflow: document.documentElement.scrollWidth > innerWidth,
        favorites: rect('.today-favorites'), rediscovery: rect('.today-rediscovery'), recent: rect('.today-recent'), recentCover: rect('#recent-listening-list .cover'),
        cards: [...document.querySelectorAll('.recommendation-grid .rediscovery-card')].map(row => { const c = row.querySelector('.cover').getBoundingClientRect(), b = row.querySelector('[data-quick-append]').getBoundingClientRect(), text = row.querySelector('.recommendation-copy').getBoundingClientRect(); return { x: c.x, y: c.y, width: c.width, height: c.height, plusX: b.x, plusY: b.y, plusWidth: b.width, plusHeight: b.height, clearText: text.right <= b.left, right: c.right }; }),
        recentXs: [...document.querySelectorAll('#recent-listening-list [data-quick-append]')].map(button => button.getBoundingClientRect().x) };
    });
    assert.equal(geometry.overflow, false); assert.equal(geometry.cols, geometry.available >= 960 ? 2 : 1);
    assert(geometry.cards.every(card => Math.abs(card.width - card.height) < 1 && card.clearText && card.plusWidth === 44 && card.plusHeight === 44));
    assert.equal(new Set(geometry.recentXs).size, 1); if (geometry.available >= 1500) { assert.equal(geometry.cards[0].y, geometry.cards[1].y); assert(geometry.cards[1].x > geometry.cards[0].x); assert(geometry.favorites.x < 300); } else { assert.equal(geometry.cards[0].x, geometry.cards[2].x); assert.equal(geometry.cards[1].x, geometry.cards[3].x); } assert.equal(geometry.cards[0].width, geometry.cards[2].width);
    if (geometry.cols === 2) { assert.equal(geometry.favorites.y, geometry.recent.y); assert.equal(geometry.cards[0].y, geometry.cards[1].y); assert(Math.abs(geometry.cards[0].y - geometry.recentCover.y) <= 1); }
    else assert(geometry.recent.y >= geometry.rediscovery.y + geometry.rediscovery.height);
    layouts.push({ scheme, ...geometry });
    await plus('recent-listening-list', f.id).focus(); await expect.poll(() => plus('recent-listening-list', f.id).evaluate(el => { const r = el.getBoundingClientRect(), p = document.querySelector('#mini-player').getBoundingClientRect(), nav = document.querySelector('.sidebar'), top = getComputedStyle(nav).position === 'sticky' ? nav.getBoundingClientRect().bottom : 0; return r.top >= top + 5 && r.bottom <= p.top - 5; })).toBe(true);
    await page.locator('#main-content').evaluate(el => el.scrollTo(0, 0));
    if ([3010, 1920, 1440, 1000, 390, 320].includes(width)) await page.screenshot({ path: join(out, `today-${scheme}-${width}.png`), fullPage: true });
  }
  checks.push('14-theme-layouts-parallel-card-grid-3-block-reading-order-44px-fixed-right-plus-and-visible-keyboard-focus');

  const removed = favoriteIds[0], kept = favoriteIds[1];
  db.prepare('UPDATE tracks SET is_life_song=0 WHERE id=?').run(removed); await nav('library'); await nav('home'); await expect.poll(favorites).not.toContain(removed); assert.equal((await favorites())[0], kept);
  const afterRemoval = await favorites(); db.prepare('UPDATE tracks SET is_life_song=1 WHERE id=?').run(e.id); await nav('library'); await nav('home'); assert.deepEqual(await favorites(), afterRemoval); assert.deepEqual(await rediscovery(), oldIds); assert.deepEqual(await queue(), stableQueue);
  checks.push('same-day-unmark-fills-only-hole-add-keeps-valid-order-and-no-queue-change');

  const recentBeforeExpansion = await blockIds('recent-listening-list');
  for (const track of tracks) db.prepare('UPDATE tracks SET last_played_at=? WHERE id=?').run(stamp(0), track.id);
  await page.evaluate(value => { window.__todayNow = value; }, now + day); await nav('library'); await nav('home');
  await expect(page.locator('.today-rediscovery')).toBeHidden(); await expect(page.locator('#rediscovery-list')).toBeEmpty(); assert.notEqual((await snapshot()).date, initial.date); assert.deepEqual(await queue(), stableQueue);
  await expect(page.locator('#favorites-list .rediscovery-card')).toHaveCount(4);
  const expanded = await favorites();
  assert.equal(new Set(expanded).size, 4); assert.deepEqual(await blockIds('recent-listening-list'), recentBeforeExpansion);
  await page.reload(); await expect.poll(favorites).toEqual(expanded); assert.deepEqual(await queue(), stableQueue);
  for (const width of [3010, 1920, 1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('#favorites-list').evaluate(el => {
      const cards = [...el.querySelectorAll('.rediscovery-card')].map(card => {
        const r = card.getBoundingClientRect(), b = card.querySelector('[data-quick-append]').getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, plusRight: b.right };
      });
      return { columns: getComputedStyle(el).gridTemplateColumns.split(' ').length, cards, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(layout.overflow, false); assert(layout.cards.every(card => Math.abs(card.right - card.plusRight) < 1));
    if (width >= 1920) { assert.equal(layout.columns, 4); assert(layout.cards.every(card => card.y === layout.cards[0].y)); }
    else if (width === 1440) {
      assert.equal(layout.columns, 2); assert.equal(layout.cards[0].y, layout.cards[1].y);
      assert.equal(layout.cards[2].y, layout.cards[3].y); assert(layout.cards[2].y > layout.cards[0].y);
      assert.equal(layout.cards[0].x, layout.cards[2].x); assert.equal(layout.cards[1].x, layout.cards[3].x);
    }
    if (width === 390) assert.equal(layout.columns, 1);
    await page.screenshot({ path: join(out, `four-favorites-${width}.png`), fullPage: true });
  }
  checks.push('no-rediscovery-expands-to-four-daily-favorites-stable-on-reload-2x2-and-mobile-right-plus-recent-queue-preserved');
  db.exec('UPDATE tracks SET is_life_song=0'); await nav('library'); await nav('home'); await expect(page.locator('#favorites-list')).toHaveText('최애곡을 추가해 보세요');
  db.prepare('UPDATE tracks SET is_life_song=1 WHERE id=?').run(a.id); await nav('library'); await nav('home'); await expect(page.locator('#favorites-list .rediscovery-card')).toHaveCount(1); await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.locator('#favorites-list .cover').evaluate(el => el.getBoundingClientRect().width < 330)).toBe(true);
  await page.screenshot({ path: join(out, 'one-favorite-empty-rediscovery.png'), fullPage: true });
  checks.push('next-local-day-reselection-listened-rediscovery-excluded-0-and-1-favorite-constant-size-no-fallback');

  await page.route('**/api/state', async route => { const response = await route.fetch(), data = await response.json(); for (const [id, ms] of [[a.id, 599999], [b.id, 600000], [c.id, 754000], [d.id, 5025000], [e.id, null], [f.id, 600000]]) data.tracks.find(t => t.id === id).durationMs = ms; await route.fulfill({ response, json: data }); }); await page.reload(); await nav('library');
  for (const [id, text] of [[a.id, ''], [b.id, '긴 음악'], [c.id, '긴 음악'], [d.id, '긴 음악'], [e.id, ''], [f.id, '긴 음악']]) assert.equal((await page.locator(`#library-grid [data-current-id="${id}"] .long-track-label`).allTextContents()).join(''), text);
  await page.locator('#search-input').fill('찾을 앨범 2'); await expect(page.locator('#library-grid [data-current-id]')).toHaveCount(1);
  for (let i = 0; i < tracks.length; i++) { assert.deepEqual(await readFile(join(root, 'data/library', tracks[i].managedPath)), originals[i]); const row = db.prepare('SELECT * FROM tracks WHERE id=?').get(tracks[i].id), original = protectedRows.find(t => t.id === row.id); for (const key of ['title', 'created_at', 'memory', 'lyrics_lrc', 'lyrics_original', 'lyrics_translation']) assert.equal(row[key], original[key]); }
  assert.deepEqual(errors, []); checks.push('existing-collection-duration-search-original-audio-lrc-notes-unchanged');
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, initial, checks, layouts, errors }, null, 2)); console.log(JSON.stringify({ root, out, checks, errors }));
});
