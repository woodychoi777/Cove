import { navigateTo, toggleManage, openComments, songMenu } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('셔플·반복: 실제 출력 유지·자연 종료·긴 AAC·설정 복원·Collection 목록·키보드', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 150000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-modes-'));
  const out = resolve(process.env.MODES_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '26317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk); t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); }); });
  const url = 'http://127.0.0.1:26317', tracks = [], originals = [];
  for (const [name, body] of [['A.flac', playableFlac({ title: '셔플 첫 곡', seconds: 15, frequency: 330 })], ['B.flac', playableFlac({ title: '반복 둘째 곡', seconds: 15, frequency: 550 })], ['C.flac', playableFlac({ title: '반복 셋째 곡', seconds: 15, frequency: 660 })], ['AAC.m4a', await readFile(new URL('./fixtures/aac-tone.m4a', import.meta.url))]]) {
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': name }, body })).json();
    tracks.push(await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: { artist: '모드 검사 아티스트', lrcText: '[00:00]보존 가사' } }) })).json());
    originals.push(body);
  }
  const [a, b, c, aac] = tracks;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png'), fullPage: true }).catch(() => {}); await browser.close(); });
  await page.addInitScript(() => {
    Math.random = () => 0;
    const Native = window.AudioContext;
    window.__modes = { contexts: [], media: [], immediateStarts: 0, naturalEnds: 0, nodes: [], decoded: 0 };
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__modes.contexts.push(this); }
      decodeAudioData(...args) { window.__modes.decoded++; return super.decodeAudioData(...args); }
      createBufferSource() { const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node); window.__modes.nodes.push(node); node.addEventListener('ended', () => { if (!node.__stopped) window.__modes.naturalEnds++; }); node.start = (...args) => { if (args[0] <= this.currentTime + .1) window.__modes.immediateStarts++; return start(...args); }; node.stop = (...args) => { node.__stopped = true; return stop(...args); }; return node; }
      createMediaElementSource(media) { window.__modes.media.push(media); return super.createMediaElementSource(media); }
      createGain() { const gain = super.createGain(), connect = gain.connect.bind(gain); gain.connect = (...args) => { if (args[0] === this.destination) { this.__meter = this.createAnalyser(); connect(this.__meter); } return connect(...args); }; return gain; }
    };
  });
  await page.route('**/api/state', async route => { const response = await route.fetch(), state = await response.json(); state.tracks.find(track => track.id === aac.id).durationMs = 4 * 3600_000; await route.fulfill({ response, json: state }); });
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const restore = async (ids, extra = {}) => { await page.evaluate(saved => localStorage.setItem('soriseojae.queue', JSON.stringify(saved)), { ids, index: 0, source: '반복 검사', ...extra }); await page.reload(); await expect(page.locator('#mini-player')).toBeVisible(); };
  const play = async () => { await page.locator('#mini-play').click(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); };
  const seekNearEnd = () => page.locator('#mini-seek').evaluate(input => { input.value = String(Number(input.max) - .4); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const rms = () => page.evaluate(() => { const ctx = window.__modes.contexts[0], data = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length); });
  await page.goto(url);
  await restore([a.id, b.id, a.id, c.id, b.id], { index: 1 });
  await expect(page.locator('#mini-shuffle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#mini-repeat')).toHaveAttribute('aria-label', '반복: 끔');
  await play(); await expect.poll(rms).toBeGreaterThan(.01);
  await expect.poll(async () => Number(await page.locator('#mini-seek').inputValue())).toBeGreaterThan(.2);
  const before = Number(await page.locator('#mini-seek').inputValue()), height = (await page.locator('#mini-player').boundingBox()).height;
  await page.locator('#mini-shuffle').press('Enter');
  const shuffled = await queue(); assert.deepEqual(shuffled.ids.slice(0, 2), [a.id, b.id]); assert.notDeepEqual(shuffled.order, [0, 1, 2, 3, 4]);
  assert.equal(await page.evaluate(() => window.__modes.nodes[0].__stopped || false), false);
  assert.equal(await page.evaluate(() => window.__modes.immediateStarts), 1);
  assert.ok(Number(await page.locator('#mini-seek').inputValue()) >= before);
  await page.locator('#mini-shuffle').press('Enter'); assert.deepEqual((await queue()).ids, [a.id, b.id, a.id, c.id, b.id]);
  assert.equal((await page.locator('#mini-player').boundingBox()).height, height);
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-repeat').click();
  const saved = await queue(); await page.reload(); await expect(page.locator('#mini-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mini-repeat')).toHaveAttribute('aria-label', '반복: 전체');
  assert.deepEqual((await queue()).ids, saved.ids); assert.deepEqual((await queue()).order, saved.order);
  assert.equal(await page.evaluate(() => window.__modes.contexts.length), 0); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '재생');
  assert.equal(Number(await page.locator('#mini-seek').inputValue()), 0);
  await page.locator('#mini-shuffle').click(); assert.deepEqual((await queue()).ids, [a.id, b.id, a.id, c.id, b.id]);
  checks.push('shuffle-current-output-position-prefix-duplicates-original-order-and-paused-reload');
  // Natural buffer ending repeats, while the user's next skips to the following occurrence.
  await restore([a.id, b.id]); await page.locator('#mini-repeat').click(); await page.locator('#mini-repeat').click();
  await play(); await seekNearEnd(); await expect.poll(() => page.evaluate(() => window.__modes.naturalEnds)).toBeGreaterThan(0);
  assert.equal((await queue()).index, 0); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await page.locator('#mini-next').click(); await expect.poll(async () => (await queue()).index).toBe(1);
  await expect(page.locator('#mini-next')).toBeDisabled(); await page.locator('#mini-play').click();
  await page.locator('#mini-repeat').click(); await expect(page.locator('#mini-repeat')).toHaveAttribute('aria-label', '반복: 끔');
  await page.locator('#mini-repeat').click(); await expect(page.locator('#mini-next')).toBeEnabled();
  await play(); await seekNearEnd(); await expect.poll(async () => (await queue()).index).toBe(0); await page.locator('#mini-play').click();
  checks.push('buffer-natural-repeat-one-manual-next-repeat-all-wrap');
  // The real short AAC is forced onto the long-recording path; no complete PCM decode.
  await restore([aac.id, b.id], { repeat: 'one' }); await play();
  await expect.poll(() => page.evaluate(() => window.__modes.media[0]?.currentTime || 0)).toBeGreaterThan(.1);
  const mediaBefore = await page.evaluate(() => window.__modes.media.length);
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-shuffle').click();
  assert.equal(await page.evaluate(() => window.__modes.media.length), mediaBefore);
  assert.equal(await page.evaluate(() => window.__modes.media[0].paused), false);
  await seekNearEnd(); await expect.poll(() => page.evaluate(() => window.__modes.media.length)).toBeGreaterThan(mediaBefore + 1);
  assert.equal((await queue()).index, 0); assert.equal(await page.evaluate(() => window.__modes.decoded), 0);
  await page.locator('#mini-next').click(); await expect.poll(async () => (await queue()).index).toBe(1); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중'); await page.locator('#mini-play').click();
  checks.push('real-AAC-stream-repeat-without-full-decode-and-manual-next');
  // Collection row playback keeps the current queue's shuffle and editing draft.
  await navigateTo(page, 'home'); await expect(page.locator('#random-song')).toHaveCount(0); await navigateTo(page,'library');
  if (await page.locator('#mini-shuffle').getAttribute('aria-pressed') !== 'true') await page.locator('#mini-shuffle').click();
  await page.locator('#library-grid [data-row-play]').first().click();
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
  assert.equal((await queue()).ids.length, tracks.length); assert.equal(new Set((await queue()).ids).size, tracks.length); assert.equal((await queue()).shuffle, true);
  await page.locator('#mini-play').click(); await page.locator('#mini-track').click();
  await page.locator('#detail-content [data-edit-info]').click();
  await page.locator('#track-info-form [name="lyricsTranslation"]').fill('셔플·반복 중 보호할 초안');
  await page.keyboard.press('Escape');
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-repeat').click();
  await page.locator('#detail-content [data-edit-info]').click();
  await expect(page.locator('#track-info-form [name="lyricsTranslation"]')).toHaveValue('셔플·반복 중 보호할 초안');
  await page.locator('#track-info-form .primary-button').click(); await expect(page.locator('#track-info-dialog')).toBeHidden();
  await page.locator('#queue-open').click();
  await expect(page.locator('#queue-list [data-entry-key]')).toHaveCount(tracks.length);
  await expect(page.locator('#queue-order-summary')).toContainText('현재 재생 순서');
  await page.screenshot({ path: join(out, 'queue-desktop.png'), fullPage: true });
  for (const viewport of [{ width: 320, height: 700 }, { width: 756, height: 450 }]) {
    await page.setViewportSize(viewport);
    for (const id of ['mini-shuffle', 'mini-repeat']) {
      await page.locator(`#${id}`).focus(); await page.keyboard.press('Space');
      await expect(page.locator(`#${id}`)).toBeFocused();
      const box = await page.locator(`#${id}`).boundingBox(); assert.ok(box.x >= 3 && box.y >= 3 && box.x + box.width <= viewport.width - 3 && box.y + box.height <= viewport.height - 3);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: join(out, `queue-${viewport.width}.png`), fullPage: true });
  }
  for (let i = 0; i < tracks.length; i++) assert.deepEqual(await readFile(join(root, 'data/library', tracks[i].managedPath)), originals[i]);
  assert.deepEqual(errors, []); checks.push('collection-shuffle-draft-queue-and-responsive-keyboard');
  await writeFile(join(out, 'results.json'), JSON.stringify({ checks, errors, originalsPreserved: true }, null, 2));
});
