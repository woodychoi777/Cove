import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';
import { navigateTo, songMenu, openComments, openCollectionSong } from './song-ui.mjs';

test('내장 번역: 자연 재생·원문 시각 seek·별도 번역 우선·편집 왕복·코멘트 초안·원본 보존', {
  skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000
}, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'cove-lyric-pairs-'));
  const out = resolve(process.env.PAIRING_ARTIFACT_DIR || join(root, 'artifacts'));
  await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '40317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk);
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); ok(); } });
    server.on('exit', code => { clearTimeout(timer); no(Error(`server ${code}: ${stderr}`)); });
  });
  const url = 'http://127.0.0.1:40317';
  const original = '[ml:1.0]\n[offset:0]\n[00:00]Music: Synthetic\n[00:01]First original\n[00:03]第一句翻译\n[00:03]Second original\n[00:05]第二句翻译\n[00:05]Third original\n[00:07]第三句翻译\n[00:07]Fourth original\n[00:09]' + '最后一句很长的翻译也可以换行阅读。'.repeat(20) + '\n[00:09]';
  const tracks = [], audio = [];
  const get = async id => (await fetch(`${url}/api/tracks/${id}`)).json();
  for (let i = 0; i < 2; i++) {
    audio.push(playableFlac({ title: `번역 연결 검사 ${i + 1}`, album: `검사 앨범 ${i + 1}`, seconds: 12, frequency: 330 + i * 110 }));
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: audio[i] })).json();
    const song = await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: i ? {} : { lrcText: original, lrcSourceName: 'pairs.lrc' } }) })).json();
    tracks.push(await get(song.id));
  }
  const [song, other] = tracks;
  const lrcPath = join(root, 'data/library', song.lyricsFilePath);
  const lrcBefore = await readFile(lrcPath);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png') }).catch(() => {}); await browser.close(); });
  await page.addInitScript(ids => localStorage.setItem('soriseojae.queue', JSON.stringify({ ids, index: 0, fadeSeconds: 0 })), tracks.map(row => row.id));
  const open = async id => {
    await navigateTo(page, 'library');
    await openCollectionSong(page, id);
    await expect(page.locator('[data-detail-title]')).toHaveText(tracks.find(row => row.id === id).title);
  };
  const reader = page.locator('[data-lyrics-lines]');
  const row = index => reader.locator(`[data-lyric-index="${index}"]`);
  const seek = n => page.locator('#mini-seek').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); }, n);
  await page.goto(url); await open(song.id);
  await expect(reader.locator('.lyric-line')).toHaveCount(6);
  await expect(reader.locator('.lyric-translation')).toHaveCount(4);
  await expect(row(1).locator('.lyric-original')).toHaveText('First original');
  await expect(row(1).locator('.lyric-translation')).toHaveText('第一句翻译');
  await expect(row(1).locator('.lyric-original')).toHaveCSS('font-size', '30px');
  await expect(row(1).locator('.lyric-translation')).toHaveCSS('font-size', '17px');
  const originalBox = await row(1).locator('.lyric-original').boundingBox(), translatedBox = await row(1).locator('.lyric-translation').boundingBox();
  assert.ok(translatedBox.y >= originalBox.y + originalBox.height);
  await page.locator('#mini-play').click();
  await expect(row(1)).toHaveAttribute('aria-current', 'true');
  await expect(row(2)).toHaveAttribute('aria-current', 'true', { timeout: 7000 });
  await page.locator('#mini-play').click();
  await row(1).press('Enter');
  await expect(page.locator('#mini-play')).toHaveAttribute('aria-label', '일시정지');
  await expect(row(1)).toHaveAttribute('aria-current', 'true');
  assert.ok(Number(await page.locator('#mini-seek').inputValue()) < 2);
  await page.locator('#mini-play').click();
  checks.push('original-above-translation-30-17px-natural-time-boundary-and-seek-at-original-time');

  await reader.press('PageDown'); await expect(reader).toHaveAttribute('data-follow', 'false');
  await seek(7); await expect(row(4)).toHaveAttribute('aria-current', 'true');
  await page.locator('[data-lyrics-follow]').click(); await expect(reader).toBeFocused();
  await expect(reader).toHaveAttribute('data-follow', 'true');
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 600, height: 456 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    assert.ok(await reader.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await expect(row(4).locator('.lyric-translation')).toContainText('最后一句很长的翻译');
    await page.screenshot({ path: join(out, `paired-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seek(3); await page.screenshot({ path: join(out, 'paired-desktop.png') });
  checks.push('manual-reading-return-long-translation-wrapping-small-and-short-screen');

  await songMenu(page, '[data-edit-lyrics]');
  const input = page.locator('[name="lyricsOriginal"]');
  await expect(input).toHaveValue(original);
  const explicit = '[00:01]명시 첫 번역\n[00:03]명시 둘째 번역\n[00:05]명시 셋째 번역\n[00:07]명시 마지막 번역';
  await page.locator('[name="lyricsTranslation"]').fill(explicit);
  await page.getByRole('button', { name: '가사 저장', exact: true }).click();
  await expect(page.locator('[data-detail-draft]')).toBeHidden();
  await page.locator('[data-listen-preview]').click();
  await expect(reader.locator('.lyric-translation')).toHaveCount(4);
  await expect(row(1).locator('.lyric-translation')).toHaveText('명시 첫 번역');
  assert.equal(await reader.locator('.lyric-original').filter({ hasText: '翻译' }).count(), 0);
  const saved = await get(song.id); assert.equal(saved.lyricsOriginal, original); assert.equal(saved.lyricsTranslation, explicit);
  checks.push('explicit-translation-wins-without-duplicates-and-original-editor-save-roundtrip');

  await openComments(page); await page.locator('#comment-text').fill('곡 전환에도 남아 있는 코멘트 초안');
  await page.keyboard.press('Escape');
  await page.locator('#mini-next').click();
  await expect(page.locator('[data-detail-title]')).toHaveText(other.title);
  await page.locator('#mini-play').click();
  await open(song.id); await openComments(page);
  await expect(page.locator('#comment-text')).toHaveValue('곡 전환에도 남아 있는 코멘트 초안');
  await page.keyboard.press('Escape');
  for (let i = 0; i < tracks.length; i++) assert.deepEqual(await readFile(join(root, 'data/library', tracks[i].managedPath)), audio[i]);
  assert.deepEqual(await readFile(lrcPath), lrcBefore);
  assert.equal((await get(song.id)).memory, song.memory);
  assert.deepEqual(errors, []);
  checks.push('next-song-comment-draft-audio-lrc-and-stored-record-preserved');
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, checks, errors }, null, 2));
  console.log(JSON.stringify({ out, checks, errors }));
});
