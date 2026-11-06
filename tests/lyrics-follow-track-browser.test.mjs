import { navigateTo, lyricsViewportFits, toggleManage, openComments, songMenu, openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('가사 현재곡 추적: 자연/수동/셔플·동일 ID·늦은 조회·편집·초안·포커스', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 180000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-follow-'));
  const out = resolve(process.env.FOLLOW_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '30317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk); t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); }); });
  const url = 'http://127.0.0.1:30317', tracks = [], originals = [];
  for (const [i, name] of ['A', 'B', 'C'].entries()) {
    const bytes = playableFlac({ title: `추적 검사 ${name}`, artist: `${name} 아티스트`, album: `${name} 앨범`, seconds: 20, frequency: 330 + i * 110 }); originals.push(bytes);
    const staged = await (await fetch(url + '/api/stage', { method: 'POST', headers: { 'x-file-name': `${name}.flac` }, body: bytes })).json();
    const song = await (await fetch(url + '/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: i < 2 ? { lrcText: `[00:00]${name} 첫 줄\n[00:02]${name} 둘째 줄\n[00:16]${name} 마지막 줄`, lrcSourceName: `${name}.lrc` } : {} }) })).json();
    await fetch(`${url}/api/tracks/${song.id}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...song, lyricsTranslation: i < 2 ? `${name} 번역 1\n${name} 번역 2\n${name} 번역 3` : '' }) });
    tracks.push(song);
  }
  const [a,b,c] = tracks;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], queries = [], checks = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/\/api\/tracks\/\d+$/.test(r.url())) queries.push(r.url()); });
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png'), fullPage: true }).catch(() => {}); await writeFile(join(out, 'partial.json'), JSON.stringify({root,checks,errors})); await browser.close(); });
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__followAudio = { starts: 0, contexts: 0 };
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__followAudio.contexts++; }
      createBufferSource() { const source = super.createBufferSource(), start = source.start.bind(source); source.start = (...args) => { if (args[0] <= this.currentTime + .1) window.__followAudio.starts++; return start(...args); }; return source; }
    };
  });
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('soriseojae.queue')));
  const pause = async () => { if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').evaluate(el=>el.click()); };
  const seek = seconds => page.locator('#mini-seek').evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(seconds));
  const nav = route => route === 'queue' ? page.locator('#queue-open').click() : navigateTo(page, route);
  const open = async id => { await nav('library'); await openCollectionSong(page, id); await expect(page.locator('[data-detail-title]')).toHaveText((await (await fetch(`${url}/api/tracks/${id}`)).json()).title); };
  const manage = () => toggleManage(page);
  const title = () => page.locator('[data-detail-title]');
  const reader = page.locator('[data-lyrics-lines]');
  const reset = async (ids = [a.id,b.id,c.id], index = 0) => {
    await page.evaluate(({ids,index}) => localStorage.setItem('soriseojae.queue', JSON.stringify({ids,index,source:'추적 검사',fadeSeconds:0})), {ids,index}); await page.reload(); await open(ids[index]);
  };
  const next = async () => { await page.locator('#mini-next').click(); await pause(); };
  const holdDetail = async id => {
    let release, requested = false;
    const pattern = `**/api/tracks/${id}`;
    await page.route(pattern, async route => { const response = await route.fetch(); requested = true; await new Promise(resolve => release = resolve); await route.fulfill({response}); });
    return { wait: () => expect.poll(() => requested).toBe(true), release: async () => { const done = page.waitForResponse(r => r.url().endsWith(`/api/tracks/${id}`)); release(); await done; await page.unroute(pattern); } };
  };
  await page.goto(url); await reset();
  await expect(page.locator('#detail-content [data-play]')).toHaveCount(0);
  await page.locator('#mini-play').click(); await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status','재생 중');
  await reader.focus(); await seek(19.6); const transitionStarts = await page.evaluate(() => window.__followAudio.starts);
  await expect(title()).toHaveText(b.title); await pause();
  await expect(reader).toBeFocused(); await expect(reader).toHaveAttribute('data-follow','true');
  await expect(page.locator('[data-lyric-index="0"] .lyric-original')).toHaveText('B 첫 줄');
  await expect(page.locator('[data-lyric-index="0"] .lyric-translation')).toHaveText('B 번역 1');
  await expect(page.locator('[data-detail-artist]')).toHaveText('B 아티스트');
  assert.deepEqual((await queue()).ids,[a.id,b.id,c.id]); assert.equal((await queue()).index,1);
  assert.equal(await page.evaluate(() => window.__followAudio.contexts),1);
  // Seeking A starts a source; following B must not start another immediate source.
  assert.equal(await page.evaluate(() => window.__followAudio.starts),transitionStarts);
  checks.push('real-natural-A-B-title-artist-translation-current-line-focus-and-no-audio-queue-restart');

  const count = queries.length;
  await page.evaluate(() => { window.__sameDetail = document.querySelector('#notes-form'); window.__sameLyrics = document.querySelector('[data-lyrics-lines]'); });
  await seek(2.2); await page.locator('#mini-play').click(); await expect(page.locator('[data-lyric-index="1"]')).toHaveAttribute('aria-current','true'); await pause();
  await page.locator('#volume-open').click(); await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed','true'); await page.locator('#volume-open').click();
  await page.locator('#mini-shuffle').click(); await page.locator('#mini-shuffle').click();
  await page.locator('#mini-repeat').click(); await page.locator('#mini-repeat').click();
  await seek(19.7); await page.locator('#mini-play').click(); await expect.poll(async () => Number(await page.locator('#mini-seek').inputValue())).toBeLessThan(2); await pause();
  assert.equal(queries.length,count); assert.equal(await page.evaluate(() => window.__sameDetail === document.querySelector('#notes-form') && window.__sameLyrics === document.querySelector('[data-lyrics-lines]')),true);
  await next(); await expect(title()).toHaveText(c.title); await expect(reader).toContainText('아직 가사가 없습니다');
  await page.locator('#mini-prev').click(); await pause(); await expect(title()).toHaveText(b.title); await expect(page.locator('#mini-prev')).toBeFocused();
  checks.push('same-ID-zero-queries-stable-DOM-pause-seek-volume-shuffle-repeat-one-and-manual-next-prev');

  await reset(); const held = await holdDetail(b.id);
  await next(); await held.wait(); await expect(reader).toBeHidden(); await expect(page.locator('#detail-content')).toHaveAttribute('aria-busy','true');
  await next(); await expect(title()).toHaveText(c.title); await held.release(); await expect(title()).toHaveText(c.title); await expect(reader).toContainText('아직 가사가 없습니다');
  await page.screenshot({path:join(out,'rapid-C-empty.png'),fullPage:true});
  checks.push('rapid-A-B-C-late-B-ignored-and-no-old-lyrics-while-loading');

  for (const destination of ['comments','edit','library']) {
    await reset(); const held = await holdDetail(b.id); await next(); await held.wait();
    if (destination === 'comments') await openComments(page);
    if (destination === 'edit') await manage();
    if (destination === 'library') await nav('library');
    await held.release(); await expect(title()).toHaveText(a.title);
    if (destination === 'comments') { await page.keyboard.press('Escape'); await expect(title()).toHaveText(b.title); }
    if (destination === 'edit') { await expect(page.locator('body')).toHaveAttribute('data-app-mode','edit'); await manage(); await expect(title()).toHaveText(a.title); await page.locator('[data-lyrics-current-track]').click(); await expect(title()).toHaveText(b.title); }
    if (destination === 'library') { await expect(page.locator('[data-view="library"]')).toHaveClass(/is-visible/); await next(); await expect(page.locator('[data-view="library"]')).toHaveClass(/is-visible/); }
  }
  checks.push('pending-response-invalidated-on-dialog-mode-route-and-explicit-preview');

  await reset(); await manage(); await page.getByLabel('한국어 번역').fill('A에 남겨둘 초안'); await next(); await expect(title()).toHaveText(a.title);
  await page.locator('[data-listen-preview]').click();
  await expect(title()).toHaveText(a.title); await expect(reader).toContainText('A 첫 줄');
  await page.locator('#mini-play').click(); await pause(); await expect(title()).toHaveText(a.title);
  await next(); await expect(title()).toHaveText(c.title);
  await open(a.id); await manage(); await expect(page.getByLabel('한국어 번역')).toHaveValue('A에 남겨둘 초안');
  await page.getByRole('button',{name:'가사 저장',exact:true}).click(); await expect(page.locator('[data-detail-draft]')).toBeHidden();
  checks.push('management-protected-preview-until-next-real-change-and-per-ID-lyric-draft-preserved');

  // Save submission and latest edit must remain separate even across an automatic DOM replacement.
  for (const success of [true,false]) {
    await reset(); await manage(); const baseline = await (await fetch(`${url}/api/tracks/${a.id}`)).json();
    await page.getByLabel('한국어 번역').fill('제출한 번역');
 
    let release, waiting = false;
    await page.route(`**/api/tracks/${a.id}/notes`, async route => { const response = success ? await route.fetch() : null; waiting = true; await new Promise(resolve => release = resolve); await route.fulfill(response ? {response} : {status:500,json:{error:'검사 저장 실패'}}); });
    await page.getByRole('button',{name:'가사 저장',exact:true}).click(); await expect.poll(() => waiting).toBe(true);
 
    await page.getByLabel('한국어 번역').fill(baseline.lyricsTranslation);
    await page.locator('[data-listen-preview]').click(); await next(); await expect(title()).toHaveText(b.title);
    release(); await expect(page.locator('#toast')).toHaveText(success ? '가사 저장됨' : '검사 저장 실패'); await page.unroute(`**/api/tracks/${a.id}/notes`);
    await open(a.id); await manage(); await expect(page.getByLabel('한국어 번역')).toHaveValue(baseline.lyricsTranslation);
    
    await page.getByRole('button',{name:'가사 저장',exact:true}).click(); await expect(page.locator('[data-detail-draft]')).toBeHidden();
  }
  checks.push('D1-success-failure-baseline-return-translation-memory-life-latest-edit-survives-auto-replacement');

  await reset(); await page.locator('#detail-content [data-more]').click(); await page.locator('#mini-play').evaluate(el=>el.click()); await seek(19.6);
  await expect(page.locator('#mini-track')).toContainText(b.title); await expect(title()).toHaveText(a.title); await expect(page.locator('.song-menu:popover-open')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(title()).toHaveText(b.title); await pause();
  await reset(); await page.locator('#detail-content [data-more]').click(); await page.locator('#detail-more [data-edit-title]').click();
  await page.getByLabel('곡 이름',{exact:true}).fill('A 대화상자 수정');
  await page.locator('#mini-play').evaluate(el=>el.click()); await seek(19.6); await expect(page.locator('#mini-track')).toContainText(b.title);
  await expect(title()).toHaveText(a.title); await expect(page.getByLabel('곡 이름',{exact:true})).toBeFocused();
  await page.locator('#title-form .primary-button').click(); await expect(title()).toHaveText(b.title); await pause();
  checks.push('natural-transition-never-steals-popover-dialog-input-and-aligns-on-completion');

  await reset(); await page.locator('#mini-shuffle').click(); const shuffled = await queue(); await next();
  const current = tracks.find(track=>track.id===shuffled.ids[1]); await expect(title()).toHaveText(current.title);
  await page.locator('#mini-repeat').click(); await next(); await next(); await expect(title()).toHaveText('A 대화상자 수정');
  assert.deepEqual((await queue()).ids,shuffled.ids);
  await nav('queue'); await page.locator('[data-queue-play="2"]').click(); await pause(); await expect(page.locator('#queue-panel')).toBeVisible();
  checks.push('shuffle-order-repeat-all-wrap-and-queue-selection-does-not-open-detail');

  for (const viewport of [{width:390,height:844},{width:320,height:700},{width:756,height:456}]) {
    await reset(); await page.setViewportSize(viewport); await page.emulateMedia({reducedMotion:'reduce'});
    await reader.press('PageDown'); await expect(reader).toHaveAttribute('data-follow','false');
    await page.locator('#mini-play').evaluate(el=>el.click()); await seek(19.6); await expect(title()).toHaveText(b.title); await pause();
    await expect(reader).toBeFocused(); await expect(reader).toHaveAttribute('data-follow','true');
    await expect(page.locator('[data-view="detail"] .back-button')).toBeVisible();
    await expect.poll(()=>reader.evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('#mini-player').getBoundingClientRect(),s=document.querySelector('.sidebar'),top=getComputedStyle(s).position==='sticky'?s.getBoundingClientRect().bottom:0;return r.top>=top+6&&r.bottom<=p.top-6&&el.matches(':focus-visible');})).toBe(true);
    const actionWidth=await page.locator('.detail-actions').evaluate(el=>el.getBoundingClientRect().width); assert.ok(actionWidth<=45); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(out,`follow-${viewport.width}.png`),fullPage:true});
    await next(); await expect(page.locator(await page.locator('#mini-next').isEnabled() ? '#mini-next' : '#mini-play')).toBeFocused();
  }
  for (let i=0;i<tracks.length;i++) assert.deepEqual(await readFile(join(root,'data/library',tracks[i].managedPath)),originals[i]);
  const savedA=await (await fetch(`${url}/api/tracks/${a.id}`)).json(); assert.equal(await readFile(join(root,'data/library',savedA.lyricsFilePath),'utf8'),a.lyricsOriginal);
  assert.deepEqual(errors,[]); checks.push('small-short-reduced-motion-no-play-slot-region-and-player-focus-original-LRC-preserved');
  await writeFile(join(out,'results.json'),JSON.stringify({root,tracks,checks,queries:queries.length,errors},null,2));
  console.log(JSON.stringify({out,root,checks:checks.length}));
});
