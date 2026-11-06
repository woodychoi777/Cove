import { navigateTo, songMenu } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('긴 AAC M4A: 범위 재생·실제 출력·탐색·초안·연속 전환·취소', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-long-audio-'));
  const out = resolve(process.env.LONG_AUDIO_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '21317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk); t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); }); });
  const url = 'http://127.0.0.1:21317';
  const bytes = await readFile(new URL('./fixtures/aac-tone.m4a', import.meta.url));
  const tracks = [];
  for (const [name, body] of [['AAC.m4a', bytes], ['FLAC.flac', playableFlac({ seconds: 3, title: '짧은 FLAC' })]]) {
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': name }, body })).json();
    tracks.push(await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: {} }) })).json());
  }
  const [aac, flac] = tracks;
  const range = await fetch(`${url}/api/tracks/${aac.id}/audio`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206); assert.match(range.headers.get('content-range'), /^bytes 0-1023\//); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith(`/api/tracks/${aac.id}/audio`)) requests.push({ range: request.headers().range || null }); });
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__streamProbe = { decoded: 0, mediaSources: 0, contexts: [], media: [] };
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__streamProbe.contexts.push(this); }
      decodeAudioData(...args) { window.__streamProbe.decoded++; return super.decodeAudioData(...args); }
      createMediaElementSource(media) { window.__streamProbe.mediaSources++; window.__streamProbe.media.push(media); const node = super.createMediaElementSource(media); return node; }
      createGain() { const gain = super.createGain(), connect = gain.connect.bind(gain); gain.connect = (...args) => { if (args[0] === this.destination) { this.__meter = this.createAnalyser(); connect(this.__meter); } return connect(...args); }; return gain; }
    };
  });
  await page.route('**/api/state', async route => { const response = await route.fetch(); const state = await response.json(); state.tracks.find(track => track.id === aac.id).durationMs = 4 * 3600_000; await route.fulfill({ response, json: state }); });
  await page.goto(url);
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const ids = [aac.id, flac.id, aac.id];
  await page.evaluate(ids => localStorage.setItem('soriseojae.queue', JSON.stringify({ ids, index: 0, fadeSeconds: 4, source: '긴 음원 검사' })), ids);
  await page.reload();
  const startedAt = Date.now(); await page.locator('#mini-play').click();
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
  const startMs = Date.now() - startedAt;
  await expect.poll(() => page.evaluate(() => { const ctx = window.__streamProbe.contexts[0], samples = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length); })).toBeGreaterThan(.01);
  assert.equal(await page.evaluate(() => window.__streamProbe.decoded), 0);
  assert.equal(await page.evaluate(() => window.__streamProbe.mediaSources), 1);
  assert.ok(requests.some(row => row.range?.startsWith('bytes=')));
  const rms = await page.evaluate(() => { const ctx = window.__streamProbe.contexts[0], samples = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length); });
  await page.locator('#mini-play').click(); const position = Number(await page.locator('#mini-seek').inputValue());
  await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#mini-play').click(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
  await expect.poll(() => page.evaluate(() => { const ctx = window.__streamProbe.contexts[0], samples = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(samples); return Math.max(...samples.map(Math.abs)); })).toBeLessThan(.00001);
  assert.ok(Number(await page.locator('#mini-seek').inputValue()) >= position);
  await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('#mini-volume-inline')).toHaveValue('0.8');
  await expect.poll(() => page.evaluate(() => { const ctx = window.__streamProbe.contexts[0], samples = new Float32Array(ctx.__meter.fftSize); ctx.__meter.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length); })).toBeGreaterThan(.01);
  await page.locator('#mini-play').click();
  // Save a draft while streaming and allow both transport boundaries to finish.
  await page.locator('#mini-track').click(); await songMenu(page, '[data-edit-info]');
  const translation = page.locator('#track-info-form [name="lyricsTranslation"]');
  await translation.fill('긴 음원 중 작성하는 초안');
  await page.locator('#track-info-dialog [data-dialog-close]').click();
  await page.locator('#mini-seek').evaluate(input => { input.value = '2.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#mini-play').click();
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('2/3');
  await expect.poll(async () => { const value = await queue(); return `${value.source} · ${value.index + 1}/${value.ids.length}`; }, { timeout: 15000 }).toContain('3/3');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '대기열 재생 완료', { timeout: 10000 });
  await songMenu(page, '[data-edit-info]');
  await expect(translation).toHaveValue('긴 음원 중 작성하는 초안');
  assert.equal(await page.evaluate(() => window.__streamProbe.decoded), 1); // FLAC only
  await page.screenshot({ path: join(out, 'stream-complete.png'), fullPage: true });
  await page.locator('#track-info-form .primary-button').click(); await expect(page.locator('#track-info-dialog')).toBeHidden();
  // Delayed ranges must be cancelled when another track is explicitly selected.
  await page.reload();
  await navigateTo(page, 'library');
  let waiting = false, release;
  await page.route(`**/api/tracks/${aac.id}/audio`, async route => { waiting = true; await new Promise(resolve => release = resolve); await route.continue().catch(() => {}); });
  await page.locator(`#library-grid [data-row-play="${aac.id}"]`).click(); await expect.poll(() => waiting).toBe(true);
  await page.locator(`#library-grid [data-row-play="${flac.id}"]`).click(); release();
  await expect(page.locator('#mini-track')).toContainText('짧은 FLAC');
  await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');
  assert.equal(await page.evaluate(() => window.__streamProbe.media.every(media => media.paused && !media.getAttribute('src'))), true);
  await page.unroute(`**/api/tracks/${aac.id}/audio`);
  await page.locator('#mini-play').click();
  assert.deepEqual(await readFile(join(root, 'data/library', aac.managedPath)), bytes);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, startMs, rms, rangeRequests: requests, decodedLongAudio: 0, boundaries: 'AAC→FLAC→AAC→終了', draftPreserved: true, staleMediaReleased: true, originalsPreserved: true, errors }, null, 2));
  console.log(JSON.stringify({ out, startMs, rms, checks: 'real AAC range/graph/seek/pause/volume/queue/draft/stale-load' }));
});
