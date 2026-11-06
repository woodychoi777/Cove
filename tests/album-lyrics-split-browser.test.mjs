import { navigateTo, lyricsViewportFits, openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('앨범·가사 두 열: 반응형·표지 실패/지연·중앙 탐색·긴 내용·원본 보존', {
  skip: !process.env.RUN_BROWSER_TESTS, timeout: 150000
}, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-split-'));
  const out = resolve(process.env.SPLIT_ARTIFACT_DIR || join(root, 'artifacts'));
  await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '39317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  let stderr = '';
  server.stderr.on('data', c => stderr += c);
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000);
    server.stdout.on('data', c => { if (String(c).includes('프로토타입:')) { clearTimeout(timer); ok(); } });
    server.on('exit', () => { clearTimeout(timer); no(Error(stderr)); });
  });
  const url = 'http://127.0.0.1:39317';
  const api = async (path, values, type = 'application/json') => {
    const response = await fetch(url + path, values === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(values) : values });
    assert.ok(response.ok, path); return response.json();
  };
  const original = '[00:00]처음 꺼내는 노래\n[00:02]지금 듣는 한 줄\n[00:04]' + '줄임 없이 읽는 긴 원문 '.repeat(40) + '\n[00:12]마지막 노래';
  const translated = '처음 줄 번역\n현재 줄 번역\n' + '생략하지 않는 긴 번역 '.repeat(35) + '\n마지막 번역';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const tracks = [], originals = [];
  for (let i = 0; i < 4; i++) {
    const bytes = playableFlac({ title: i === 3 ? '긴 제목도 생략하지 않고 읽습니다 '.repeat(14) : ['앨범과 가사', '시간표 없는 가사', '가사 없는 음악'][i], artist: '배치 검사 가수', album: `배치 검사 앨범 ${i}`, seconds: 20, frequency: 330 + i * 110 });
    originals.push(bytes);
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: bytes })).json();
    const song = await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: i === 0 ? { lrcText: original, lrcSourceName: 'original.lrc' } : {} }) })).json();
    await api(`/api/tracks/${song.id}/notes`, { lyricsOriginal: i === 1 ? '시간표 없는 첫 원문\n시간표 없는 둘째 원문' : i === 2 ? '' : original, lyricsTranslation: i === 1 ? '첫 번역\n둘째 번역' : i === 2 ? '' : translated, memory: '보존할 코멘트', isLifeSong: true });
    if (i < 2) await api(`/api/tracks/${song.id}/artwork`, png, 'image/png');
    tracks.push(await api(`/api/tracks/${song.id}`));
  }
  const [a, b, c, d] = tracks, errors = [], layouts = [], checks = [];
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => {
    await page.screenshot({ path: join(out, 'last-state.png'), fullPage: true }).catch(() => {});
    await writeFile(join(out, 'partial.json'), JSON.stringify({ root, checks, layouts, errors }, null, 2));
    await browser.close();
  });
  const nav = () => navigateTo(page, 'library');
  const open = async id => { await nav(); await openCollectionSong(page, id); await expect(page.locator('[data-detail-title]')).toHaveText(tracks.find(row => row.id === id).title); };
  const reader = page.getByRole('region', { name: '가사 감상', exact: true });
  const back = page.getByRole('button', { name: '재생 중인 가사로 돌아가기', exact: true });
  const seek = value => page.locator('#mini-seek').evaluate((el, n) => { el.value = String(n); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const backdrop = () => page.locator('.detail-stage').evaluate(el => el.style.getPropertyValue('--listening-artwork'));
  await page.addInitScript(ids => localStorage.setItem('soriseojae.queue', JSON.stringify({ ids, index: 0, fadeSeconds: 0 })), tracks.map(row => row.id));
  await page.goto(url); await page.locator('#mini-play').click();
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await page.locator('#mini-play').click(); await open(a.id); await seek(2);
  await expect.poll(backdrop).toContain(`/tracks/${a.id}/artwork`);
  await expect(page.locator('.sidebar')).toBeHidden();
  assert.equal(await page.getByRole('navigation', { name: '주요 화면' }).count(), 0);
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  await expect(reader.locator('[data-lyric-index]')).toHaveCount(4);
  // Back retains each real entry screen, scroll position and available focus.
  await page.setViewportSize({ width: 390, height: 500 });
  for (const route of ['home', 'library']) {
    await navigateTo(page, route);
    await page.locator('#mini-track').focus();
    const sourceScroll = await page.locator('#main-content').evaluate(el => el.scrollTop);
    await page.locator('#mini-track').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('[data-detail-back]')).toHaveText({ home: 'Today', library: 'Collection', artists: 'Artist' }[route]);
    await page.locator('[data-detail-back]').press('Enter');
    await expect(page.locator(`[data-view="${route}"]`)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect.poll(() => page.locator('#main-content').evaluate(el => el.scrollTop)).toBe(sourceScroll);
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement.closest('.view.is-visible, .sidebar:not([hidden]), #mini-player')))).toBe(true);
  }
  checks.push('listening-hides-navigation-and-grid-gutter-no-Fullscreen-API-back-home-collection-artist-restores-scroll-focus');
  await page.setViewportSize({ width: 1280, height: 900 }); await open(a.id); await seek(2);
  for (const scheme of ['light', 'dark']) for (const [width, height] of [[1920,1080],[1600,900],[1280,900],[1200,640],[1080,900],[1001,800],[761,700],[1280,400],[390,844],[320,700],[720,480],[600,456]]) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height });
    await expect.poll(() => lyricsViewportFits(page)).toBe(true);
    const geometry = await page.evaluate(() => {
      const box = el => el.getBoundingClientRect().toJSON();
      const stage = document.querySelector('.detail-stage'), cover = document.querySelector('.detail-artwork .cover'), copy = document.querySelector('.detail-copy'), reader = document.querySelector('[data-lyrics-lines]');
      return { stage: box(stage), cover: box(cover), copy: box(copy), reader: box(reader), title: box(copy.querySelector("h1")), artist: box(copy.querySelector("[data-detail-artist]")), more: box(copy.querySelector("[data-more]")), back: box(document.querySelector("[data-detail-back]")), titleAlign: getComputedStyle(copy.querySelector("h1")).textAlign, heightStacked: stage.hasAttribute("data-height-stacked"), contentWidth: document.querySelector('[data-view="detail"]').clientWidth - parseFloat(getComputedStyle(document.querySelector('[data-view="detail"]')).paddingLeft) * 2, stacked: getComputedStyle(stage).getPropertyValue('--stacked').trim() === '1', textAlign: getComputedStyle(reader.querySelector('.lyric-copy')).textAlign, overflow: document.documentElement.scrollWidth > innerWidth, readerOverflow: reader.scrollWidth > reader.clientWidth, original: getComputedStyle(reader.querySelector('.lyric-original')).fontSize, translation: getComputedStyle(reader.querySelector('.lyric-translation')).fontSize };
    });
    layouts.push({ scheme, width, height, ...geometry });
    assert.equal(geometry.stacked, geometry.contentWidth < 900 || geometry.heightStacked);
    if (width === 1280 && height === 400) assert.equal(geometry.heightStacked, true);
    assert.ok(Math.abs(geometry.cover.width - geometry.cover.height) < 1);
    assert.equal(geometry.titleAlign, 'center');
    const center = box => box.x + box.width / 2;
    const controls = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { play: box('#mini-play'), seek: box('#mini-seek'), center: box('.mini-center'), track: box('#mini-track'), end: box('.mini-end'), elapsed: box('#mini-elapsed'), total: box('#mini-time') };
    });
    assert.ok(Math.abs(center(controls.play) - width / 2) < 1, 'play button stays on the screen axis');
    assert.ok(Math.abs(center(controls.seek) - center(controls.play)) < 1, 'seek rail and play button share an axis');
    assert.ok(controls.elapsed.right <= controls.seek.left && controls.seek.right <= controls.total.left);
    if (width > 760) {
      assert.ok(controls.track.right <= controls.center.left && controls.center.right <= controls.end.left, 'side controls do not overlap the transport');
      assert.ok(controls.track.left >= Math.min(64, width / 30) - 1);
    }
    if (width === 1920) { assert.ok(controls.seek.width >= 560 && controls.seek.width <= 641); assert.ok(Math.abs(controls.track.left - 64) < 1); }
    assert.ok(Math.abs(center(geometry.title) - center(geometry.reader)) < 1);
    assert.ok(Math.abs(center(geometry.artist) - center(geometry.reader)) < 1);
    assert.ok(geometry.title.bottom <= geometry.artist.top + 1 && geometry.artist.bottom <= geometry.reader.top + 1);
    assert.ok(Math.abs(geometry.more.top - geometry.back.top) < 1);
    assert.ok(geometry.more.left > width / 2 && geometry.more.right <= width - 15 && geometry.more.width >= 44);
    assert.equal(geometry.textAlign, 'center'); assert.equal(geometry.overflow, false); assert.equal(geometry.readerOverflow, false);
    await expect(page.locator('.sidebar')).toBeHidden();
    assert.equal(await page.getByRole('navigation', { name: '주요 화면' }).count(), 0);
    assert.equal(await reader.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none');
    assert.ok(geometry.reader.height >= 80); assert.ok(geometry.cover.width > 0 && geometry.cover.width <= 460);
    assert.ok(geometry.reader.height <= 441);
    if (!geometry.stacked && height >= 900) { assert.ok(geometry.reader.height >= 340); assert.ok(geometry.copy.top > geometry.stage.top + 30); }
    if (geometry.stacked) { assert.ok(geometry.cover.bottom <= geometry.copy.top + 1); assert.ok(geometry.copy.bottom <= geometry.reader.top + 1); }
    else { assert.ok(geometry.cover.right + 45 <= geometry.reader.left); assert.ok(geometry.cover.width >= 240);
      if (height >= 900) { const visualCenter = geometry.cover.top + geometry.cover.height / 2; assert.ok(visualCenter >= height / 2 - 1 && visualCenter <= height / 2 + 25, 'artwork and lyrics balance against the whole window including the player'); }
      assert.ok(Math.abs(geometry.cover.top - geometry.reader.top) <= 2);
      assert.ok(Math.abs(geometry.cover.bottom - geometry.reader.bottom) <= 2);
      assert.ok(geometry.title.bottom < geometry.cover.top);
      assert.ok(geometry.cover.top - geometry.artist.bottom >= 24);
    }
    const fixed = await page.locator('.detail-artwork,.detail-copy').evaluateAll(items => items.map(el => el.getBoundingClientRect().toJSON()));
    const queue = await page.evaluate(() => localStorage.getItem('soriseojae.queue'));
    await reader.press('End'); await expect(back).toBeVisible();
    let priorEndPosition = NaN;
    await expect.poll(async () => {
      const position = await reader.evaluate(el => el.scrollTop);
      const stable = position > 0 && Math.abs(position - priorEndPosition) < 1;
      priorEndPosition = position; return stable;
    }).toBe(true);
    assert.deepEqual(await page.locator('.detail-artwork,.detail-copy').evaluateAll(items => items.map(el => el.getBoundingClientRect().toJSON())), fixed);
    if (!geometry.stacked) { const boxes = await page.locator('.detail-artwork .cover,[data-lyrics-lines]').evaluateAll(items => items.map(el => el.getBoundingClientRect().toJSON())); assert.ok(Math.abs(boxes[0].top-boxes[1].top)<=2 && Math.abs(boxes[0].bottom-boxes[1].bottom)<=2); }
    await page.locator('[data-lyric-index="3"]').focus();
    await expect.poll(() => reader.evaluate(el => { const row = el.querySelector('[data-lyric-index="3"]').getBoundingClientRect(), r = el.getBoundingClientRect(); return row.height > r.height - 72 ? Math.abs(row.top - r.top - 6) < 2 : row.top >= r.top && row.bottom <= r.bottom - 65; })).toBe(true);
    await back.press('Enter'); await expect(reader).toBeFocused(); await expect(back).toBeHidden();
    await expect(reader).toHaveCSS('mask-image', 'none');
    assert.equal(await page.evaluate(() => localStorage.getItem('soriseojae.queue')), queue);
    await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
    if ([1920,1280,1001,761,390,320,600].includes(width)) await page.screenshot({ path: join(out, `${scheme}-${width}.png`), fullPage: true });
  }
  checks.push('24-layouts-screen-centered-transport-and-seek-no-side-overlap-optical-stage-center-common-square-and-viewport-top-bottom-within-2px-short-wide-fallback-title-artist-centered-over-lyrics-more-at-screen-top-right-content-breakpoint-square-cover-fixed-header-center-lyrics-themes-short-window-keyboard-last-line-return-no-replay');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-detail-title]').evaluate(el => el.textContent = '제목이 두세 줄에 걸쳐 자연스럽게 이어지는 음악, '+ '조용한 밤의 기록 '.repeat(4));
  await expect.poll(() => lyricsViewportFits(page)).toBe(true);
  await expect.poll(() => page.evaluate(() => { const a=document.querySelector('.detail-artwork .cover').getBoundingClientRect(), b=document.querySelector('[data-lyrics-lines]').getBoundingClientRect(); return Math.abs(a.top-b.top)<=2 && Math.abs(a.bottom-b.bottom)<=2; })).toBe(true);
  await page.screenshot({path:join(out,'three-line-title-aligned.png')});
  await page.locator('[data-detail-title]').evaluate((el,title) => el.textContent=title,a.title);
  await expect.poll(() => lyricsViewportFits(page)).toBe(true);
  await seek(4); await expect(page.locator('[data-lyric-index="2"]')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => reader.evaluate(el => Math.abs(el.querySelector('.is-current').getBoundingClientRect().top - el.getBoundingClientRect().top - 20) < 3)).toBe(true);
  await reader.press('Home'); await expect(back).toBeVisible();
  await page.locator('#detail-content [data-more]').click(); await page.locator('.song-menu:popover-open [data-edit-info]').click();
  await expect(page.locator('#track-info-dialog')).toBeVisible();
  await expect(page.locator('#track-info-form [name="lyricsTranslation"]')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('#track-info-form [name="lyricsOriginal"]')).toHaveValue(original);
  checks.push('oversized-line-start-alignment-unified-edit-modal-keeps-listening-layout');
  await page.keyboard.press('Escape'); await expect(page.locator('#track-info-dialog')).toBeHidden();
  // A failed cover changes neither stored artwork nor the next song's background.
  const pattern = `**/api/tracks/${a.id}/artwork*`;
  const detailPattern = `**/api/tracks/${a.id}`;
  const uncachedCover = suffix => page.route(detailPattern, async route => {
    const response = await route.fetch(), json = await response.json();
    await route.fulfill({ response, json: { ...json, artworkPath: json.artworkPath + suffix } });
  });
  await uncachedCover('-failure');
  await page.route(pattern, route => route.fulfill({ status: 404, body: '' }));
  await open(c.id);
  await open(a.id); await expect.poll(backdrop).toBe(''); await expect(page.locator('[data-detail-cover] svg')).toBeVisible();
  await page.unroute(pattern); await page.unroute(detailPattern);
  let release, finished, waiting = false;
  const delayedCoverDone = new Promise(ok => finished = ok);
  await uncachedCover('-delayed');
  await page.route(pattern, async route => { const response = await route.fetch(); waiting = true; await new Promise(ok => release = ok); await route.fulfill({ response }); finished(); });
  await open(c.id);
  await open(a.id); await expect.poll(() => waiting).toBe(true);
  // Opening a collection row replaces the seed queue with the displayed order.
  const direction = await page.evaluate(id => {
    const queue = JSON.parse(localStorage.getItem('soriseojae.queue'));
    return queue.ids[queue.index + 1] === id ? 'next' : queue.ids[queue.index - 1] === id ? 'prev' : null;
  }, b.id);
  assert.ok(direction, '검사 곡은 현재 표시 대기열에서 인접해야 한다');
  await page.locator(`#mini-${direction}`).click(); await expect(page.locator('[data-detail-title]')).toHaveText(b.title);
  if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').click();
  await expect.poll(backdrop).toContain(`/tracks/${b.id}/artwork`); release(); await delayedCoverDone; await page.unroute(pattern); await page.unroute(detailPattern);
  await expect.poll(backdrop).toContain(`/tracks/${b.id}/artwork`);
  await expect(reader).toHaveClass(/is-untimed/); await expect(reader.locator('[aria-current]')).toHaveCount(0); await expect(back).toBeHidden();
  await open(c.id); await expect(reader).toContainText('아직 가사가 없습니다'); await expect(reader.locator('.lyric-line')).toHaveCount(0); await expect.poll(backdrop).toBe('');
  checks.push('missing-and-failed-cover-neutral-late-image-cannot-overwrite-next-song-untimed-static-empty-clears-old-lyrics');
  for (const [width,height] of [[1280,900],[390,844],[320,700]]) {
    await page.setViewportSize({width,height}); await open(d.id);
    await expect.poll(() => reader.evaluate(el => el.clientHeight >= 90)).toBe(true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', {name:'곡 더 보기',exact:true}).press('Enter');
    await expect(page.locator('.song-menu:popover-open [data-comments]')).toBeVisible(); await page.keyboard.press('Escape');
    await page.screenshot({path:join(out,`long-title-${width}.png`),fullPage:true});
  }
  for (let i = 0; i < tracks.length; i++) {
    const after = await api(`/api/tracks/${tracks[i].id}`);
    assert.deepEqual(after, tracks[i]);
    assert.deepEqual(await readFile(join(root,'data/library',after.managedPath)), originals[i]);
    if (after.artworkPath) assert.deepEqual(await readFile(join(root,'data/library',after.artworkPath)), png);
    if (after.lyricsFilePath) assert.equal(await readFile(join(root,'data/library',after.lyricsFilePath),'utf8'), original);
  }
  assert.deepEqual(errors, []); checks.push('long-title-remains-readable-menu-access-original-audio-artwork-LRC-notes-unchanged');
  await writeFile(join(out,'results.json'),JSON.stringify({root,checks,layouts,errors},null,2));
});
