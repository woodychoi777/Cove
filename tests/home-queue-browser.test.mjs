import { navigateTo, lyricsViewportFits, toggleManage, openComments, songMenu, openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {playableFlac} from './fixtures.mjs';

test('오늘·컬렉션+·텍스트 아티스트·우하단 대기열 팝업과 기존 큐/초안 보호', {skip:!process.env.RUN_BROWSER_TESTS,timeout:180000},async t=>{
 const module=process.env.PLAYWRIGHT_MODULE||'playwright',{chromium}=await import(module);
 const {expect}=await import(module.startsWith('/')?pathToFileURL(join(module,'..','test.mjs')).href:'playwright/test');
 const root=await mkdtemp(join(tmpdir(),'soriseojae-home-queue-')),out=resolve(process.env.HOME_QUEUE_ARTIFACT_DIR||join(root,'artifacts'));await mkdir(out,{recursive:true});
 const server=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,PORT:'32317',SORISEOJAE_DATA_DIR:join(root,'data')},stdio:['ignore','pipe','pipe']});
 let stderr='';server.stderr.on('data',c=>stderr+=c);t.after(()=>server.kill('SIGTERM'));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'서버 시작 시간 초과')),10000);server.stdout.on('data',c=>{if(String(c).includes('프로토타입:')){clearTimeout(timer);resolve()}});server.on('exit',code=>{clearTimeout(timer);reject(new Error(`서버 종료 ${code}: ${stderr}`))})});
 const url='http://127.0.0.1:32317',tracks=[],originals=[],checks=[],errors=[];
 const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1280,height:900},colorScheme:'light'});
 page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await page.screenshot({path:join(out,'last-state.png'),fullPage:true}).catch(()=>{});await writeFile(join(out,'partial.json'),JSON.stringify({root,checks,errors}));await browser.close()});
 await page.addInitScript(()=>{const Native=AudioContext;window.__homeStarts=0;window.AudioContext=class extends Native{createBufferSource(){const s=super.createBufferSource(),start=s.start.bind(s);s.start=(...args)=>{window.__homeStarts++;return start(...args)};return s}}});
 const nav=route=>navigateTo(page, route);
 const queue=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('soriseojae.queue')));
 const panel=page.locator('#queue-panel'),toggle=page.locator('#queue-open');
 const pop=async()=>{if(!await panel.isVisible())await toggle.click()};
 const extras=async()=>{if(!await page.locator('#queue-extras').evaluate(el=>el.open))await page.locator('#queue-extras > summary').click()};
 const pause=async()=>{if(await page.locator('#mini-play').getAttribute('aria-label')==='일시정지')await page.locator('#mini-play').evaluate(el=>el.click())};
 const seek=seconds=>page.locator('#mini-seek').evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}))},seconds);
 const manage=()=>toggleManage(page);
 const restore=async(ids,index=0)=>{await page.evaluate(({ids,index})=>localStorage.setItem('soriseojae.queue',JSON.stringify({ids,index,fadeSeconds:0,source:'팝업 검사'})),{ids,index});await page.reload()};
 await page.goto(url);
 await expect(page.locator('#home-empty')).toContainText('Collection에서 음악을 추가하세요');await expect(page.locator('[data-route="import"]')).toHaveCount(1);
 assert.equal(await page.locator('.nav-button[data-route="queue"], [data-view="queue"], .sidebar-add, #recent-grid').count(),0);
 await expect(toggle).toBeVisible();await expect(page.locator('#mini-player')).toBeHidden();await pop();await expect(panel).toContainText('대기열이 비었습니다');await expect(page.locator('#queue-extras')).not.toHaveAttribute('open','');await page.keyboard.press('Escape');await expect(toggle).toBeFocused();
 await page.locator('#home-empty [data-route="library"]').click();await expect(page.locator('[data-view="library"] #collection-add')).toHaveCount(0);await expect(page.locator('#collection-add')).toBeHidden();
 await page.locator('#settings-open').click();await expect(page.locator('#settings-dialog #collection-add')).toBeVisible();await expect(page.locator('#collection-add')).toHaveAccessibleName('음원 추가');
 await page.locator('#collection-add').click();await expect(page.locator('#settings-dialog')).toBeHidden();await expect(page.locator('[data-view="import"]')).toHaveClass(/is-visible/);
 for(let i=0;i<3;i++){
  const bytes=playableFlac({title:`팝업 검사 ${'ABC'[i]}`,artist:`검사 가수 ${i}`,album:`검사 앨범 ${i}`,seconds:8,frequency:440+i*110});originals.push(bytes);
  const staged=await(await fetch(url+'/api/stage',{method:'POST',headers:{'x-file-name':`${i}.flac`},body:bytes})).json();
  tracks.push(await(await fetch(url+'/api/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({importId:staged.importId,metadata:{lrcText:`[00:00]${'ABC'[i]} 가사\n[00:04]${'ABC'[i]} 마지막`,lrcSourceName:'검사.lrc'}})})).json());
 }
 const [a,b,c]=tracks;
 await fetch(url+'/api/queues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'중복 순서',trackIds:[a.id,b.id,a.id]})});await page.reload();await nav('home');
 await expect(page.locator('#recent-listening-list')).toHaveText('아직 감상 기록이 없습니다');await expect(page.locator('#featured-track')).toHaveCount(0);
 await expect(page.locator('[data-view="home"] [data-route="import"]')).toHaveCount(0);await expect(page.locator('#collection-add')).toBeHidden();
 await pop();await extras();await page.locator('[data-load-queue]').click();await expect(panel).toBeVisible();await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');assert.deepEqual((await queue()).ids,[a.id,b.id,a.id]);await page.keyboard.press('Escape');
 checks.push('one-collection-plus-empty-library-import-no-player-saved-queue-and-no-history-fallback');
 for(const [id,count]of[[a.id,1],[b.id,3],[c.id,2]])for(let i=0;i<count;i++)await fetch(`${url}/api/tracks/${id}/playback`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({listenedMs:4000,completed:false})});
 await nav('library');await nav('home');const recent=page.locator('#recent-listening-list');
 await expect(recent.locator('[data-row-play]')).toHaveCount(3);assert.deepEqual(await recent.locator('[data-row-play]').evaluateAll(rows=>rows.map(row=>Number(row.dataset.rowPlay))),[b.id,c.id,a.id]);assert.equal(await recent.locator('.collection-album,.song-duration').count(),0);
 assert.equal(await recent.locator('[data-more],.song-menu').count(),0);await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');
 await recent.locator(`[data-row-play="${c.id}"]`).click();await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');await pause();assert.deepEqual((await queue()).ids,[b.id,c.id,a.id]);assert.equal((await queue()).index,1);
 const oldQueue=await queue();await nav('library');await nav('home');assert.deepEqual((await queue()).ids,oldQueue.ids);
 await page.screenshot({path:join(out,'today.png'),fullPage:true});
 await expect(page.locator('[data-route="artists"],[data-view="artists"]')).toHaveCount(0);await nav('library');
 checks.push('actual-30-day-ranking-menu-isolation-displayed-order-playback-no-queue-reorder-and-text-artists');

 await restore([a.id,b.id,a.id,c.id,a.id,b.id,a.id,c.id,a.id,b.id,a.id,c.id],9);await nav('library');await pop();
 await expect(page.locator('body')).toHaveAttribute('data-route','library');await expect(page.locator('#queue-close')).toBeFocused();await expect(toggle).toHaveAttribute('aria-expanded','true');
 const visibleCurrent=()=>page.locator('.is-queued-current').evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('.queue-body').getBoundingClientRect();return r.top>=p.top-1&&r.bottom<=p.bottom+1});await expect.poll(visibleCurrent).toBe(true);
 const keys=await page.locator('#queue-list [data-entry-key]').evaluateAll(rows=>rows.map(r=>r.dataset.entryKey));assert.equal(new Set(keys).size,12);
 const held=JSON.stringify(await queue()),starts=await page.evaluate(()=>window.__homeStarts);
 await page.locator(`#library-grid [data-row-play="${c.id}"]`).click();await expect(panel).toBeHidden();assert.equal(JSON.stringify(await queue()),held);assert.equal(await page.evaluate(()=>window.__homeStarts),starts);
 await pop();await toggle.click();await expect(panel).toBeHidden();await expect(toggle).toBeFocused();await pop();await page.locator('#queue-close').click();await expect(toggle).toBeFocused();
 await pop();await page.locator('[data-queue-up="9"]').click();await expect(panel).toBeVisible();assert.equal((await queue()).index,8);await expect(page.locator('[data-queue-up="8"]')).toBeFocused();
 await page.locator('[data-queue-remove="8"]').click();await expect(panel).toBeVisible();assert.equal((await queue()).ids.length,11);
 await page.keyboard.press('Escape');await expect(toggle).toBeFocused();
 await toggleManage(page,false);await pop();await extras();await page.locator('.queue-settings > summary').click();await page.locator('#transition-setting').selectOption('2');assert.equal((await queue()).fadeSeconds,2);
 await page.locator('#queue-save-open').click();await expect(panel).toBeHidden();await page.getByLabel('대기열 이름').fill('팝업에서 저장');await page.locator('#queue-save-form .primary-button').click();await expect(panel).toBeVisible();await expect(page.locator('#queue-save-open')).toBeFocused();
 await page.getByRole('button',{name:'불러오기',exact:true}).last().click();await expect(panel).toBeVisible();await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');
 await page.locator('#volume-open').click();await expect(panel).toBeHidden();await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed','true');assert.equal(await page.locator('#volume-dialog').count(),0);await page.locator('#volume-open').press('Enter');await expect(page.locator('#volume-open')).toHaveAttribute('aria-pressed','false');await expect(page.locator('#volume-open')).toBeFocused();
 checks.push('popup-no-navigation-toggle-outside-no-misplay-current-duplicate-keys-reorder-remove-save-load-transition-and-volume');

 await restore([a.id,b.id,c.id]);await page.locator('#mini-track').click();await songMenu(page,'[data-edit-info]');await page.locator('#track-info-form [name="lyricsTranslation"]').fill('저장하지 않은 A 번역');await page.keyboard.press('Escape');
 await pop();await page.locator('[data-queue-play="1"]').click();await expect(panel).toBeVisible();await expect(page.locator('[data-detail-title]')).toHaveText(b.title);await pause();
 await page.keyboard.press('Escape');await expect(page.locator('#detail-content [data-play]')).toHaveCount(0);
 await nav('library');await openCollectionSong(page, a.id);await songMenu(page,'[data-edit-info]');await expect(page.locator('#track-info-form [name="lyricsTranslation"]')).toHaveValue('저장하지 않은 A 번역');await page.locator('#track-info-form .primary-button').click();await expect(page.locator('#track-info-dialog')).toBeHidden();
 await restore([a.id,b.id,c.id]);await nav('library');await pop();await page.locator('.queue-body').evaluate(el=>el.scrollTop=20);const top=await page.locator('.queue-body').evaluate(el=>el.scrollTop);
 await page.locator('#mini-play').evaluate(el=>el.click());await seek(7.6);await expect.poll(async()=>(await queue()).index).toBe(1);await pause();await expect(panel).toBeVisible();assert.ok(Math.abs(await page.locator('.queue-body').evaluate(el=>el.scrollTop)-top)<2);
 await nav('home');await expect(panel).toBeHidden();
 checks.push('queue-selection-and-natural-next-retain-panel-scroll-lyrics-follow-and-per-ID-draft');

 for(const viewport of[{width:320,height:700},{width:390,height:844},{width:756,height:456}]){
  await page.setViewportSize(viewport);await pop();
  const measure=()=>panel.evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('#mini-player').getBoundingClientRect(),n=document.querySelector('.sidebar'),top=getComputedStyle(n).position==='sticky'?n.getBoundingClientRect().bottom:0;return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,player:p.top,nav:top,viewport:innerWidth}});
  await expect.poll(async()=>{const r=await measure();return r.left>=12&&r.right<=r.viewport-12&&r.height<=440&&r.top>=r.nav+6&&r.bottom<=r.player-6}).toBe(true);
  await page.locator('[data-queue-play]').last().focus();await expect(page.locator('[data-queue-play]').last()).toBeFocused();
  const rect=await page.locator('[data-queue-play]').last().boundingBox(),box=await panel.boundingBox();assert.ok(rect.y>=box.y&&rect.y+rect.height<=box.y+box.height);
  await page.screenshot({path:join(out,`popup-${viewport.width}.png`),fullPage:true});await page.keyboard.press('Escape');await expect(toggle).toBeFocused();
 }
 for(let i=0;i<tracks.length;i++)assert.deepEqual(await readFile(join(root,'data/library',tracks[i].managedPath)),originals[i]);
 assert.deepEqual(errors,[]);checks.push('320-390-short-window-keyboard-popup-geometry-and-original-bytes');
 await writeFile(join(out,'results.json'),JSON.stringify({root,tracks,checks,errors},null,2));console.log(JSON.stringify({root,out,checks:checks.length}));
});
