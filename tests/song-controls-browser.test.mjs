import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('song controls: wide stage, heart/comment/editor, draft/automatic follow, stale fetch and small focus', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright', { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const temp = await mkdtemp(join(tmpdir(), 'cove-song-controls-'));
  const out = resolve(process.env.SONG_CONTROLS_ARTIFACT_DIR || join(temp, 'evidence')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '48317', SORISEOJAE_DATA_DIR: join(temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  let stderr = ''; server.stderr.on('data', c => stderr += c);
  await new Promise((ok, no) => { const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000); server.stdout.on('data', c => { if (String(c).includes('프로토타입:')) { clearTimeout(timer); ok(); } }); server.on('exit', () => { clearTimeout(timer); no(Error(stderr)); }); });
  const url = 'http://127.0.0.1:48317', songs = [], originals = [], lrc = '[00:00]첫 번째 가사\n[00:03]음악을 따라 읽는 가사\n[00:06]원문 아래에 번역\n[00:09]마지막 줄';
  for (let i = 0; i < 3; i++) {
    const data = playableFlac({ title: `곡 ${i + 1}`, artist: '감상 검사', seconds: 12, frequency: 330 + i * 60 }); originals.push(data);
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${i}.flac` }, body: data })).json();
    songs.push(await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: { lrcText: lrc, lrcSourceName: 'original.lrc' } }) })).json());
  }
  const [a, b, c] = songs;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 3010, height: 1692 } }), errors = [], layouts = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png') }).catch(() => {}); await browser.close(); });
  await page.addInitScript(ids => { if (!localStorage.getItem('soriseojae.queue')) localStorage.setItem('soriseojae.queue', JSON.stringify({ ids, index: 0, source: '검사 목록', repeat: 'off', shuffle: false, fadeSeconds: 0 })); }, songs.map(s => s.id));
  await page.goto(url); await expect(page.locator('.today-recent')).toContainText('최근 7일');
  await page.locator('#mini-track').click();
  const detailTitle = page.locator('[data-detail-title]'), heart = page.locator('#detail-content [data-favorite]'), comment = page.locator('#detail-content [data-comments]'), edit = page.locator('#detail-content [data-edit-info]');
  await expect(detailTitle).toHaveText(a.title);
  for (const [width, height] of [[3010,1692],[1920,1080],[1280,900],[1000,700],[600,434],[390,700],[320,640]]) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ['light','dark']) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.evaluate(() => {
        const r = document.querySelector('[data-lyrics-lines]').getBoundingClientRect(), p = document.querySelector('#mini-player').getBoundingClientRect();
        return r.height >= 96 && r.bottom <= p.top - 5;
      })).toBe(true);
      const geometry = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
        return { width:innerWidth, height:innerHeight, back:rect('[data-detail-back]'), actions:rect('.detail-actions'), cover:rect('.detail-artwork .cover'), lyrics:rect('[data-lyrics-lines]'), font:parseFloat(getComputedStyle(document.querySelector('.lyric-original')).fontSize), overflow:document.documentElement.scrollWidth > innerWidth };
      });
      assert(!geometry.overflow); assert(geometry.back.x < 100); assert(geometry.actions.x >= geometry.back.right + 8);
      if (width >= 1280) { assert(Math.abs(geometry.cover.y - geometry.lyrics.y) <= 1); assert(Math.abs(geometry.cover.height - geometry.lyrics.height) <= 1); }
      if (width === 3010) { assert(geometry.cover.width >= 700); assert(geometry.font >= 44); }
      for (const target of [heart, comment, edit, page.locator('[data-detail-back]')]) { await target.focus(); await expect(target).toBeInViewport(); }
      layouts.push({ colorScheme, ...geometry });
      if ([3010,390].includes(width)) await page.screenshot({ path: join(out, `song-${width}-${colorScheme}.png`) });
    }
  }
  await page.setViewportSize({ width:1280, height:900 });
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const before = await queue();
  await heart.press('Enter'); await expect(heart).toHaveAttribute('aria-pressed','true'); await expect(heart.locator('svg')).toHaveCount(1);
  assert.deepEqual(await queue(), before);
  await heart.press('Enter'); await expect(heart).toHaveAttribute('aria-pressed','false');
  await page.route(`**/api/tracks/${a.id}/favorite`, r => r.fulfill({ status:500, json:{error:'검사 저장 실패'} }));
  await heart.click(); await expect(heart).toBeEnabled(); await expect(heart).toHaveAttribute('aria-pressed','false'); await page.unroute(`**/api/tracks/${a.id}/favorite`);
  await edit.click(); await expect(page.locator('#track-info-dialog')).toBeVisible(); await expect(page.locator('#track-info-delete')).toBeEnabled();
  const titleInput = page.locator('#track-info-form [name="title"]'); await titleInput.fill('보호할 편집 초안');
  await page.locator('#track-info-delete').click(); await expect(page.locator('#delete-track-title')).toHaveText(a.title);
  await page.locator('#delete-track-dialog [data-dialog-close]').click();
  await expect(titleInput).toHaveValue('보호할 편집 초안'); await expect(page.locator('#track-info-delete')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
  await edit.click(); await expect(titleInput).toHaveValue('보호할 편집 초안'); await titleInput.fill(a.title); await page.locator('#track-info-form .primary-button').click();
  // A real natural end while comments are open must not replace the comment's song.
  await page.locator('#mini-seek').evaluate(el => { el.value='11'; el.dispatchEvent(new Event('input',{bubbles:true})); }); await page.locator('#mini-play').click();
  await comment.click(); await page.locator('#comment-text').fill('곡 1의 코멘트 초안');
  await expect(page.locator('#mini-track')).toContainText(b.title, { timeout:7000 });
  await expect(page.locator('#comments-track-title')).toHaveText(a.title); await expect(detailTitle).toHaveText(a.title);
  await page.locator('#comments-dialog [data-dialog-close]').click(); await expect(detailTitle).toHaveText(b.title);
  await page.locator('#mini-play').click(); await page.locator('#mini-prev').click(); await expect(detailTitle).toHaveText(a.title);
  await comment.click(); await expect(page.locator('#comment-text')).toHaveValue('곡 1의 코멘트 초안');
  await page.locator('#comments-form .primary-button').click(); await expect(page.locator('#comments-draft')).toBeHidden(); await page.keyboard.press('Escape');
  if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').click();
  // Delayed B must not overwrite C after two fast next operations.
  let held = false, delivered = false, release;
  await page.route(`**/api/tracks/${b.id}`, async r => { held=true; await new Promise(ok => release=ok); try { await r.continue(); } catch { /* A superseded request can already be canceled. */ } finally { delivered=true; } });
  await page.locator('#mini-next').click(); await expect.poll(() => held).toBe(true);
  await page.locator('#mini-next').click(); await expect(detailTitle).toHaveText(c.title); release(); await expect.poll(() => delivered).toBe(true);
  await page.unroute(`**/api/tracks/${b.id}`); await expect(detailTitle).toHaveText(c.title);
  if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').click();
  for (let i=0;i<songs.length;i++) {
    const row = await (await page.request.get(`${url}/api/tracks/${songs[i].id}`)).json();
    assert.deepEqual(await readFile(join(temp,'data/library',row.managedPath)), originals[i]);
    assert.equal(await readFile(join(temp,'data/library',row.lyricsFilePath),'utf8'), lrc);
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out,'results.json'), JSON.stringify({ layouts, errors, preserved:['audio','LRC','queue','editor draft after delete cancel','comments across natural next','late response cannot overwrite current'], temporaryData:temp },null,2));
});
