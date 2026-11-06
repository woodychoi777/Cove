import { navigateTo, ensureLyricsEditing, lyricsViewportFits, toggleManage, openComments, songMenu } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('로딩 높이 안정과 곡 행·더 보기·키보드 목록 재생', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-interaction-'));
  const out = resolve(process.env.INTERACTION_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '23317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk); t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); }); });
  const url = 'http://127.0.0.1:23317', tracks = [];
  for (const [name, body] of [['AAC.m4a', await readFile(new URL('./fixtures/aac-tone.m4a', import.meta.url))], ['two.flac', playableFlac({ title: '행 재생 둘째', album: '앨범 B', seconds: 12, frequency: 550 })], ['three.flac', playableFlac({ title: '행 재생 셋째', album: '앨범 C', seconds: 12, frequency: 660 })]]) {
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': name }, body })).json();
    tracks.push(await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: { artist: '행 검사 아티스트' } }) })).json());
  }
  const [aac, second, third] = tracks;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await writeFile(join(out, 'page-errors.json'), JSON.stringify(errors)); await page.screenshot({ path: join(out, 'last-state.png'), fullPage: true }).catch(() => {}); await browser.close(); });
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__interaction = { media: [], events: [], starts: 0 };
    window.AudioContext = class extends Native {
      createMediaElementSource(media) { window.__interaction.media.push(media); for (const name of ['waiting', 'playing', 'ended']) media.addEventListener(name, () => window.__interaction.events.push({ name, at: performance.now() })); return super.createMediaElementSource(media); }
      createBufferSource() { const source = super.createBufferSource(), start = source.start.bind(source); source.start = (...args) => { if (args[0] <= this.currentTime + .1) window.__interaction.starts++; return start(...args); }; return source; }
    };
  });
  await page.route('**/api/state', async route => { const response = await route.fetch(); const state = await response.json(); state.tracks.find(track => track.id === aac.id).durationMs = 3600_000; await route.fulfill({ response, json: state }); });
  await page.goto(url);
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const restore = async ids => { await page.evaluate(ids => localStorage.setItem('soriseojae.queue', JSON.stringify({ ids, index: 0, fadeSeconds: 0, source: '상태 검사' })), ids); await page.reload(); await expect(page.locator('#mini-player')).toBeVisible(); };
  const observe = () => page.evaluate(() => {
    window.__layout = [];
    const read = reason => window.__layout.push({ reason, at: performance.now(), height: document.querySelector('#mini-player').getBoundingClientRect().height, shown: document.querySelector('#mini-play').dataset.iconState === 'loader', text: document.querySelector('#mini-player').dataset.playbackStatus, toast: document.querySelector('#toast').className });
    window.__layoutObserver?.disconnect(); window.__heightObserver?.disconnect();
    window.__layoutObserver = new MutationObserver(() => read('mutation')); window.__layoutObserver.observe(document.querySelector('#mini-play'), { attributes: true, subtree: true, childList: true, characterData: true });
    window.__heightObserver = new ResizeObserver(() => read('resize')); window.__heightObserver.observe(document.querySelector('#mini-player')); read('initial');
  });
  await restore([aac.id, second.id]); await observe(); await page.locator('#mini-play').click();
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); await page.locator('#mini-play').click();
  const initial = await page.evaluate(() => ({ layout: window.__layout, mediaEvents: window.__interaction.events }));
  await writeFile(join(out, process.env.CAPTURE_LISTENING_BASELINE ? 'before.json' : 'short-loading.json'), JSON.stringify(initial, null, 2));
  if (process.env.CAPTURE_LISTENING_BASELINE) { console.log(JSON.stringify(initial)); return; }
  assert.ok(initial.mediaEvents.some(event => event.name === 'waiting'));
  assert.equal(initial.layout.some(row => row.shown), false, 'short real AAC loading must not flash a status message');
  assert.equal(new Set(initial.layout.map(row => row.height)).size, 1, 'short loading does not resize player');
  assert.equal(initial.layout.some(row => row.toast.includes('is-visible')), false);
  checks.push('real-short-waiting-hidden-without-height-change-or-toast');

  // Hold actual range delivery; the player must still be genuinely loading.
  await restore([aac.id, second.id]); await observe();
  let release, waiting = false;
  await page.route(`**/api/tracks/${aac.id}/audio`, async route => { waiting = true; await new Promise(resolve => release = resolve); await route.continue().catch(() => {}); });
  await page.locator('#mini-play').click(); await expect.poll(() => waiting).toBe(true);
  await expect(page.locator('#mini-play')).toHaveAttribute('data-icon-state', 'loader'); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '불러오는 중');
  for (const selector of ['#mini-track','#volume-open','.mini-end #queue-open']) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#playback-error-open')).toBeHidden();
  const held = await page.evaluate(() => ({ rows: window.__layout, currentTime: document.querySelector('#mini-seek').value }));
  assert.equal(Number(held.currentTime), 0);
  const firstShown = held.rows.find(row => row.shown); assert.ok(firstShown.at - held.rows[0].at >= 550);
  release(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); await page.locator('#mini-play').click();
  await page.unroute(`**/api/tracks/${aac.id}/audio`);
  const sustained = await page.evaluate(() => window.__layout); assert.equal(new Set(sustained.map(row => row.height)).size, 1);
  checks.push('sustained-real-buffering-delayed-inside-fixed-player');

  // Decoder error must bypass the loading delay and offer an actionable retry.
  await restore([aac.id, second.id]);
  await page.route(`**/api/tracks/${aac.id}/audio`, route => route.fulfill({ status: 404, body: 'missing' }));
  await page.locator('#mini-play').click(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', new RegExp('재생 실패'));
  await page.locator('#playback-error-open').click(); await expect(page.locator('#retry-playback')).toBeVisible(); await expect(page.locator('#skip-playback')).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 700 });
  const errorHeight = (await page.locator('#mini-player').boundingBox()).height;
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', new RegExp('다음 곡으로 이동하거나 다시 시도하세요'));
  for (const id of ['retry-playback', 'skip-playback']) { const box = await page.locator(`#${id}`).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 320); }
  await page.keyboard.press('Escape');
  for (const selector of ['#mini-track','#volume-open','.mini-end #queue-open']) await expect(page.locator(selector)).toBeVisible();
  assert.equal((await page.locator('#mini-player').boundingBox()).height, errorHeight);
  await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed', 'true'); await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.mini-end #queue-open').click(); await expect(page.locator('#queue-panel')).toBeVisible();
  await page.locator('#playback-error-open').click();
  await page.screenshot({ path: join(out, 'error-320.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute(`**/api/tracks/${aac.id}/audio`); await page.locator('#retry-playback').press('Enter'); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); await expect(page.locator('#mini-play')).toBeFocused(); await page.locator('#mini-play').click();
  checks.push('real-error-and-retry-stay-visible');

  await restore([aac.id, second.id, aac.id]); await observe(); await page.locator('#mini-play').click();
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('2/3');
  await page.locator('#mini-seek').evaluate(input => { input.value = '11.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('3/3');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '대기열 재생 완료', { timeout: 10000 });
  const transitions = await page.evaluate(() => window.__layout);
  assert.equal(new Set(transitions.map(row => row.height)).size, 1);
  checks.push('natural-AAC-FLAC-AAC-and-completion-never-resize-player');

  const nav = route => navigateTo(page, route);
  await nav('library');
  const rows = page.locator('#library-grid .collection-row'), displayed = await rows.evaluateAll(rows => rows.map(row => Number(row.dataset.currentId)));
  const button = id => page.locator(`#library-grid [data-row-play="${id}"]`);
  const more = id => page.locator(`#library-grid [data-current-id="${id}"] [data-row-play]`);
  const detail = async id => { await more(id).press('Shift+F10'); await page.locator('.song-menu:popover-open').getByRole('menuitem', { name: '가사·곡 정보', exact: true }).click(); };
  assert.equal(await rows.locator('button').filter({ has: page.locator('svg.icon-play') }).count(), 0);
  await button(third.id).locator('strong').click(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); assert.deepEqual((await queue()).ids, displayed); assert.equal((await queue()).index, displayed.indexOf(third.id));
  const stored = JSON.stringify(await queue()), starts = await page.evaluate(() => window.__interaction.starts);
  await button(third.id).locator('.cover').click();
  assert.equal(JSON.stringify(await queue()), stored); assert.equal(await page.evaluate(() => window.__interaction.starts), starts); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await page.locator('#mini-play').click(); const position = Number(await page.locator('#mini-seek').inputValue());
  await button(third.id).press('Space'); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지'); assert.ok(Number(await page.locator('#mini-seek').inputValue()) >= position);
  assert.equal(JSON.stringify(await queue()), stored);
  await page.locator('#mini-play').click();
  // The album/empty part of the main button and outer row padding play too.
  await button(second.id).locator('.collection-title-text').click(); assert.equal((await queue()).index, displayed.indexOf(second.id)); await page.locator('#mini-play').click();
  await page.locator(`#library-grid [data-current-id="${third.id}"]`).click({ position: { x: 1, y: 5 } }); assert.equal((await queue()).index, displayed.indexOf(third.id));
  await page.locator('#mini-play').click();
  const paused = JSON.stringify(await queue()), oldStarts = await page.evaluate(() => window.__interaction.starts);
  await more(second.id).press('Shift+F10'); await page.keyboard.press('Escape'); await expect(more(second.id)).toBeFocused();
  assert.equal(JSON.stringify(await queue()), paused); assert.equal(await page.evaluate(() => window.__interaction.starts), oldStarts);
  await more(second.id).press('Shift+F10'); await page.locator('.song-menu:popover-open [data-row-next]').click();
  assert.equal(await page.evaluate(() => window.__interaction.starts), oldStarts); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  await detail(second.id); await expect(page.locator('#detail-content h1')).toHaveText(second.title); assert.equal(await page.evaluate(() => window.__interaction.starts), oldStarts);
  await toggleManage(page);  await page.getByLabel('한국어 번역').fill('행 이동 중 유지할 초안');
  checks.push('title-cover-empty-space-enter-space-current-resume-and-menu-isolation');

  await nav('library'); await page.getByRole('searchbox').fill('행 재생');
  const filtered = await page.locator('#library-grid [data-row-play]').evaluateAll(buttons => buttons.map(button => Number(button.dataset.rowPlay)));
  await page.locator('#library-grid [data-row-play]').last().press('Enter'); assert.deepEqual((await queue()).ids, filtered); await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('검색 결과');
  await page.locator('#mini-play').click(); await page.getByRole('searchbox').fill(''); await detail(second.id);  await expect(page.getByLabel('한국어 번역')).toHaveValue('행 이동 중 유지할 초안');
  await ensureLyricsEditing(page); await page.getByRole('button', { name: '가사 저장', exact: true }).click(); await expect(page.locator('[data-detail-draft]')).toBeHidden();
  await expect(page.locator('[data-view="artists"]')).toHaveCount(0);
  checks.push('search-and-artist-displayed-snapshots-detail-and-draft-protection');

  // Reproduce short waiting/playing flurries on the actual media instance after
  // the real network scenarios; these injected events test presentation only.
  for (const [width, height] of [[320,800],[390,800],[756,456],[1280,900]]) {
    await page.setViewportSize({ width, height }); await restore([aac.id, second.id]); await observe();
    await page.locator('#mini-play').click(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
    await page.evaluate(async () => { const media = window.__interaction.media.at(-1); for (let i=0;i<3;i++) { media.dispatchEvent(new Event('waiting')); await new Promise(resolve=>setTimeout(resolve,60)); media.dispatchEvent(new Event('playing')); } });
    const metrics = await page.evaluate(() => ({ layout: window.__layout, scrollWidth: document.documentElement.scrollWidth, width: innerWidth }));
    assert.equal(new Set(metrics.layout.map(row=>row.height)).size,1); assert.equal(metrics.layout.some(row=>row.shown),false); assert.ok(metrics.scrollWidth<=metrics.width);
    await page.locator('#mini-play').click(); await nav('library');
    const main = page.locator('#library-grid [data-row-play]').first(), rowMore = page.locator('#library-grid [data-row-play]').nth(1);
    await main.focus(); await page.keyboard.press('Tab'); await expect(rowMore).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(main).toBeFocused();
    await expect.poll(()=>main.evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('#mini-player').getBoundingClientRect(),s=document.querySelector('.sidebar');const top=getComputedStyle(s).position==='sticky'?s.getBoundingClientRect().bottom:0;return r.top>=top+6&&r.bottom<=p.top-6&&el.matches(':focus-visible');})).toBe(true);
    await page.screenshot({ path: join(out, `rows-${width}.png`), fullPage: true });
  }
  checks.push('waiting-flurries-stable-320-390-756-1280-and-row-menu-focus');
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'),JSON.stringify({ root, checks, initial, sustained, transitions, errors },null,2)); console.log(JSON.stringify({ out, checks, errors }));
});
