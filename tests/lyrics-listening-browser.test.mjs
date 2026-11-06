import { navigateTo, lyricsViewportFits, toggleManage, openComments, songMenu } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('승인 가사: 현재행·번역·수동탐색·복귀·큰행·reduce·초안·포커스', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-lyrics-'));
  const out = resolve(process.env.LYRICS_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '24317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk); t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } }); server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); }); });
  const url = 'http://127.0.0.1:24317';
  const original = '[offset:500]\n[00:01]검사 원문 첫 줄\n[00:02]검사 원문 둘째 줄\n[00:04]검사 원문 셋째 줄\n[00:04]동시에 표시하는 줄\n[00:06]\n[00:08]'+ '긴 원문도 줄임 없이 모두 읽습니다. '.repeat(30)+'\n[00:12]마지막 검사 줄';
  const translation = '[offset:500]\n[00:01]첫 줄 번역\n[00:02]둘째 줄 번역\n[00:04]셋째 줄 번역\n[00:08]'+ '긴 번역도 생략하지 않습니다. '.repeat(30)+'\n[00:12]마지막 줄 번역';
  const tracks=[];
  for (let i=0;i<2;i++) { const staged=await(await fetch(url+'/api/stage',{method:'POST',headers:{'x-file-name':`${i}.flac`},body:playableFlac({title:`가사 검사 ${i+1}`,seconds:20,frequency:440+i*110})})).json(); tracks.push(await(await fetch(url+'/api/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({importId:staged.importId,metadata:{lrcText:original,lrcSourceName:'test.lrc'}})})).json()); }
  const [song, other]=tracks;
  const save=async values=>{const response=await fetch(`${url}/api/tracks/${song.id}/notes`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({lyricsOriginal:original,lyricsTranslation:translation,meaning:'',favoriteReason:'',memory:'',isLifeSong:false,...values})});assert.equal(response.status,200);};
  await save({});
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:1000},colorScheme:'light'});
  const errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{await page.screenshot({path:join(out,'last-state.png'),fullPage:true}).catch(()=>{});await browser.close();});
  await page.addInitScript(()=>{const Native=window.AudioContext;window.__lyricAudio={starts:0};window.AudioContext=class extends Native{createBufferSource(){const source=super.createBufferSource(),start=source.start.bind(source);source.start=(...args)=>{window.__lyricAudio.starts++;return start(...args);};return source;}};});
  const nav=()=>navigateTo(page, 'library');
  const open=async()=>{await nav();await page.locator(`#library-grid [data-current-id="${song.id}"] [data-row-play]`).press('Shift+F10');await page.locator('.song-menu:popover-open').getByRole('menuitem',{name:'가사·곡 정보',exact:true}).click();};
  const reader=page.locator('[data-lyrics-lines]'),back=page.locator('[data-lyrics-follow]');
  const seek=async seconds=>{await page.locator('#mini-seek').evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},seconds);};
  const pause=async()=>{if(await page.locator('#mini-play').getAttribute('aria-label')==='일시정지')await page.locator('#mini-play').click();};
  const top=()=>reader.evaluate(el=>el.scrollTop);
  const centered=()=>reader.evaluate(el=>{const row=el.querySelector('.is-current');if(!row)return false;const b=el.getBoundingClientRect(),r=row.getBoundingClientRect();const top=r.top-b.top+el.scrollTop, ideal=r.height>el.clientHeight-40?top-20:top-(el.clientHeight-r.height)/2;return Math.abs(el.scrollTop-Math.max(0,Math.min(el.scrollHeight-el.clientHeight,ideal)))<3;});
  await page.goto(url);await page.evaluate(ids=>localStorage.setItem('soriseojae.queue',JSON.stringify({ids,index:0,fadeSeconds:0})),[song.id,other.id]);await page.reload();await open();
  await expect(page.locator('#detail-content')).toHaveClass(/lyrics-listening/);await expect(page.locator('[data-lyrics-lines] button')).toHaveCount(6);
  await expect(page.locator('[data-lyric-index="0"] .lyric-translation')).toHaveText('첫 줄 번역');
  await expect(page.locator('[data-lyric-index="2"] .lyric-original')).toContainText('동시에 표시하는 줄');
  await expect(page.locator('[data-lyric-index="3"] .lyric-original')).toHaveText('간주');
  await expect(back).toBeHidden();assert.equal(await reader.locator('.lyric-time').count(),0);
  assert.equal(await page.locator('[data-lyrics-state],.lyrics-follow,.sidebar-status,#storage-bar').count(),0);
  assert.equal(await page.getByRole('tablist').locator('[data-lyrics-follow]').count(),0);
  await expect(page.getByRole('button',{name:'곡 더 보기',exact:true})).toBeVisible();
  await page.locator('#detail-content [data-more]').click();await expect(page.locator('.song-menu:popover-open [data-edit-title]')).toBeVisible();await page.keyboard.press('Escape');

  await seek(0);
  await expect(reader.locator('[aria-current]')).toHaveCount(0);
  await seek(.7);await expect(page.locator('[data-lyric-index="0"]')).toHaveAttribute('aria-current','true');
  await expect.poll(centered).toBe(true);
  const before=await reader.locator('.lyric-line').evaluateAll(rows=>rows.map(row=>({height:row.offsetHeight,top:row.offsetTop})));
  await seek(2);await expect(page.locator('[data-lyric-index="1"]')).toHaveAttribute('aria-current','true');await expect.poll(centered).toBe(true);
  const after=await reader.locator('.lyric-line').evaluateAll(rows=>rows.map(row=>({height:row.offsetHeight,top:row.offsetTop})));assert.deepEqual(after,before);
  // Multiple changes/ticks do not recreate rows or scroll repeatedly in one line.
  await reader.evaluate(el=>{window.__lyricsMutations=[];window.__lyricsScrolls=0;window.__lyricNode=el.querySelector('[data-lyric-index="1"]');new MutationObserver(items=>window.__lyricsMutations.push(...items.map(i=>i.type))).observe(el,{childList:true,subtree:true});const native=el.scrollTo.bind(el);el.scrollTo=(...args)=>{window.__lyricsScrolls++;return native(...args);};});
  const stable=await top();await page.locator('#mini-play').click();await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', '재생 중');await pause();
  assert.equal(await page.evaluate(()=>window.__lyricsScrolls),0);assert.equal(await top(),stable);assert.equal(await page.evaluate(()=>window.__lyricNode.isConnected),true);assert.deepEqual(await page.evaluate(()=>window.__lyricsMutations),[]);
  checks.push('offset-simultaneous-interlude-translation-highlight-stable-layout-no-tick-rerender');

  await reader.hover();await page.mouse.wheel(0,160);await expect(reader).toHaveAttribute('data-follow','false');await expect(back).toHaveText('재생 중인 가사로');
  const controlPlacement=await back.evaluate(el=>{const a=el.getBoundingClientRect(),r=document.querySelector('[data-lyrics-lines]').getBoundingClientRect();return {inside:a.top>=r.top&&a.bottom<=r.bottom,centered:Math.abs((a.left+a.right)/2-(r.left+r.right)/2)<3,visible:a.right<=innerWidth-6};});
  assert.deepEqual(controlPlacement,{inside:true,centered:true,visible:true});

  await expect.poll(async()=>Math.abs((await top())-stable)>20).toBe(true);
  const manual=await top();await seek(4);await expect(page.locator('[data-lyric-index="2"]')).toHaveAttribute('aria-current','true');assert.ok(Math.abs((await top())-manual)<2);
  assert.ok(Math.abs((await top())-manual)<2);
  const starts=await page.evaluate(()=>window.__lyricAudio.starts);await back.click();await expect(reader).toBeFocused();await expect(back).toBeHidden();await expect.poll(centered).toBe(true);assert.equal(await page.evaluate(()=>window.__lyricAudio.starts),starts);assert.equal(await page.getByText(/일시정지 · 현재 가사|현재 가사 따라가는 중|가사 둘러보는 중|재생하면 현재 가사/).count(),0);await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');
  // A scroll event by itself is browser/automatic scrolling, not user intent.
  await reader.dispatchEvent('scroll');await expect(reader).toHaveAttribute('data-follow','true');
  await reader.press('PageDown');await expect(reader).toHaveAttribute('data-follow','false');await back.click();
  await reader.dispatchEvent('touchmove');await expect(reader).toHaveAttribute('data-follow','false');await back.click();
  await reader.evaluate(el=>{const r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.right-1,clientY:r.top+30}));});await expect(reader).toHaveAttribute('data-follow','false');await back.click();
  // Interrupt an in-flight smooth move at its current position.
  await seek(11.8);await reader.dispatchEvent('wheel',{deltaY:-5});await expect(reader).toHaveAttribute('data-follow','false');const stopped=await top();
  await expect.poll(async()=>Math.abs((await top())-stopped)<2).toBe(true);
  await back.click();await expect.poll(centered).toBe(true);
  checks.push('wheel-key-touch-scrollbar-smooth-interrupt-and-paused-return-focus');

  await seek(8);await expect(page.locator('[data-lyric-index="4"]')).toHaveAttribute('aria-current','true');await expect.poll(centered).toBe(true);
  assert.ok(await page.locator('[data-lyric-index="4"]').evaluate(el=>el.offsetHeight>el.parentElement.clientHeight));
  const longText=await page.locator('[data-lyric-index="4"] .lyric-original').innerText();assert.ok(longText.length>400);
  await page.screenshot({path:join(out,'lyrics-long-light.png'),fullPage:true});
  await reader.press('PageDown');await expect(reader).toHaveAttribute('data-follow','false');
  // Native keyboard activation of a lyric line resumes playback explicitly.
  await page.locator('[data-lyric-index="0"]').press('Enter');await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');await expect(page.locator('[data-lyric-index="0"]')).toHaveAttribute('aria-current','true');await pause();
  await page.locator('[data-lyric-index="1"]').press('Space');await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');await pause();
  await page.locator('[data-lyric-index="2"]').focus();await expect(reader).toHaveAttribute('data-follow','false');await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');
  checks.push('oversized-row-top-alignment-untruncated-and-line-enter-space-play');

  await toggleManage(page);await page.getByLabel('한국어 번역').fill('가사 감상 전환에도 유지할 초안');
  await page.locator('[data-listen-preview]').click();
  await expect(reader).toHaveAttribute('data-follow','false');
  await page.locator('#mini-next').click();await pause();await expect(page.locator('#detail-content h1')).toHaveText(other.title);await expect(page.locator('[data-lyrics-current-track]')).toBeHidden();await expect(back).toBeHidden();await open();
  await toggleManage(page);await expect(page.getByLabel('한국어 번역')).toHaveValue('가사 감상 전환에도 유지할 초안');
  await page.getByRole('button',{name:'가사 저장',exact:true}).click();await expect(page.locator('[data-detail-draft]')).toBeHidden();
  checks.push('management-tabs-preview-and-other-playing-track-preserve-draft-without-false-highlight');

  await page.reload();await open();
  await page.route(`**/api/tracks/${song.id}/audio`,route=>route.fulfill({status:404,body:'missing'}));
  await page.locator('[data-lyric-index="2"]').click();await expect(page.locator('#mini-player')).toHaveAttribute('data-playback-status', new RegExp('재생 실패'));await expect(reader.locator('[aria-current]')).toHaveCount(0);await page.locator('#playback-error-open').click();await expect(page.locator('#retry-playback')).toBeVisible();await page.keyboard.press('Escape');
  await page.unroute(`**/api/tracks/${song.id}/audio`);
  await save({lyricsOriginal:'[00:00.10]빠른 첫 줄\n[00:00.30]빠른 둘째 줄\n[00:00.60]빠른 셋째 줄\n[00:02]빠른 마지막 줄',lyricsTranslation:''});await page.reload();await open();
  await page.locator('#mini-play').click();await expect(page.locator('[data-lyric-index="2"]')).toHaveAttribute('aria-current','true');await pause();
  await seek(.15);await expect(page.locator('[data-lyric-index="0"]')).toHaveAttribute('aria-current','true');await seek(2.1);await expect(page.locator('[data-lyric-index="3"]')).toHaveAttribute('aria-current','true');
  checks.push('real-natural-fast-timestamps-backward-seek-and-failed-line-no-false-highlight');

  // State fixtures use the existing notes API and the existing parser.
  for(const [name,values] of [['untimed',{lyricsOriginal:'시간 없는 원문 하나\n시간 없는 원문 둘',lyricsTranslation:'번역 하나\n번역 둘'}],['unpaired',{lyricsOriginal:'[00:01]단 하나의 원문',lyricsTranslation:'연결되지 않은 번역 하나\n연결되지 않은 번역 둘'}],['empty',{lyricsOriginal:'',lyricsTranslation:''}]]){
    await save(values);await page.reload();await open();
    if(name==='untimed'){await expect(reader.locator('button')).toHaveCount(0);assert.equal(await page.locator('[data-lyrics-state]').count(),0);await expect(reader.locator('.lyric-translation')).toHaveCount(2);}
    if(name==='unpaired'){await expect(reader.locator('.lyric-translation')).toHaveCount(0);await expect(reader.locator('.lyrics-extra')).toContainText('번역 · 줄 연결 필요');}
    if(name==='empty'){await expect(reader).toContainText('아직 가사가 없습니다');await reader.getByRole('button',{name:'가사 입력'}).click();await expect(page.getByLabel('원문 가사',{exact:false})).toBeFocused();await expect(page.getByLabel('원문 가사',{exact:false})).toBeVisible();}
    await expect(back).toBeHidden();
  }
  checks.push('untimed-static-empty-input-action-and-unpaired-translation');
  await save({memory:'저장된 기록'});await page.reload();await open();
  await page.locator('#mini-play').click();await pause();
  for(const reduced of ['no-preference','reduce']){
    await page.emulateMedia({reducedMotion:reduced});
    for(const [width,height] of [[320,900],[390,900],[756,456],[1280,1000]]){
      await page.setViewportSize({width,height});await seek(2);if(await back.isVisible())await back.click();
      await expect(page.locator('[data-lyric-index="1"]')).toHaveAttribute('aria-current','true');
      await expect(page.locator('[data-view="detail"] .back-button')).toBeVisible();
      await expect.poll(()=>lyricsViewportFits(page)).toBe(true);
      const metrics=await reader.evaluate(el=>({height:el.clientHeight,scrollWidth:el.scrollWidth,width:el.clientWidth,viewport:innerHeight,transition:getComputedStyle(el.querySelector('.lyric-original')).transitionDuration}));
      assert.ok(metrics.height<=height);assert.ok(metrics.scrollWidth<=metrics.width+1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(reduced==='reduce')assert.ok(metrics.transition.split(',').every(value=>parseFloat(value)===0));
      await reader.press('Home');await expect(reader).toHaveAttribute('data-follow','false');await back.press('Enter');await expect(reader).toBeFocused();await expect(back).toBeHidden();
      await expect.poll(()=>reader.evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('#mini-player').getBoundingClientRect(),s=document.querySelector('.sidebar'),top=getComputedStyle(s).position==='sticky'?s.getBoundingClientRect().bottom:0;return r.top>=top+6&&r.bottom<=p.top-6&&el.matches(':focus-visible');})).toBe(true);
      const textStyle=await reader.locator('.lyric-original').first().evaluate(el=>({weight:getComputedStyle(el).fontWeight,transform:getComputedStyle(el).transform}));assert.equal(textStyle.weight,'450');assert.equal(textStyle.transform,'none');
      if(width===390||width===1280)await page.screenshot({path:join(out,`lyrics-${width}-${reduced}.png`),fullPage:true});
    }
  }
  await nav();await page.locator('#settings-open').click();await page.getByLabel('밝기').selectOption('dark');await page.keyboard.press('Escape');await open();await page.setViewportSize({width:390,height:900});await page.screenshot({path:join(out,'lyrics-390-dark.png'),fullPage:true});
  checks.push('320-390-short-window-reduce-light-dark-and-return-focus');
  assert.deepEqual(errors,[]);
  await writeFile(join(out,'results.json'),JSON.stringify({root,checks,errors,originalLayout:before,highlightedLayout:after},null,2));console.log(JSON.stringify({out,checks,errors}));
});
