import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { MusicLibrary } from '../src/library.mjs';
import { MusicStore } from '../src/store.mjs';
import { playableFlac, syntheticFlac } from './fixtures.mjs';

test('자동 사진 제거: UI/API/외부 요청 없음, 저장 사진·출처·기록·내장 추출·직접 등록 보존', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 90000 }, async t => {
  const module=process.env.PLAYWRIGHT_MODULE || 'playwright';
  const {chromium}=await import(module),{expect}=await import(module.startsWith('/')?pathToFileURL(join(module,'..','test.mjs')).href:'playwright/test');
  const root=await mkdtemp(join(tmpdir(),'soriseojae-artwork-removal-')),data=join(root,'data');
  const out=resolve(process.env.REMOVAL_ARTIFACT_DIR || join(root,'artifacts'));await mkdir(out,{recursive:true});
  const store=new MusicStore(join(data,'soriseojae.sqlite')),library=new MusicLibrary({rootPath:join(data,'library'),store});await library.init();
  const originalAudio=playableFlac({title:'이전 사진 보존 검사',album:'보존 앨범',seconds:6}),lrc='[00:00]보존할 가사\n[00:03]다음 줄';
  const staged=await library.stage(Readable.from(originalAudio),'retained.flac');let retained=await library.commit(staged.importId,{lrcText:lrc,lrcSourceName:'retained.lrc'});
  const picture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const oldPhoto=join(dirname(library.resolveManagedPath(retained.managedPath)),'cover-auto-preserved.png'),sidecar=Buffer.from(JSON.stringify({provider:'online',after:relative(library.rootPath,oldPhoto)}));
  await writeFile(oldPhoto,picture);await writeFile(oldPhoto+'.json',sidecar);store.updateArtwork(retained.id,relative(library.rootPath,oldPhoto));
  store.updateNotes(retained.id,{lyricsOriginal:lrc,lyricsTranslation:'보존 번역',meaning:'보존 의미',favoriteReason:'보존 이유',memory:'보존 기록',isLifeSong:true});
  store.saveQueue({name:'보존 대기열',trackIds:[retained.id]});retained=store.getTrack(retained.id);const before=store.exportCollection();store.close();
  const server=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,PORT:'25317',SORISEOJAE_DATA_DIR:data},stdio:['ignore','pipe','pipe']});
  let stderr='';server.stderr.on('data',chunk=>stderr+=chunk);t.after(()=>server.kill('SIGTERM'));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'서버 시작 시간 초과')),10000);server.stdout.on('data',chunk=>{if(String(chunk).includes('프로토타입:')){clearTimeout(timer);resolve();}});server.once('exit',code=>{clearTimeout(timer);reject(new Error(stderr+code));});});
  const base='http://127.0.0.1:25317',api=async path=>(await fetch(base+path)).json();
  for(const path of ['/api/artwork/configuration','/api/artwork/inspect','/api/artwork/prepare-import','/api/artwork/import-folder','/api/artwork/sessions/old','/api/artwork/sessions/old/candidates/old','/api/artwork/sessions/old/apply']){
    for(const method of ['GET','POST'])assert.equal((await fetch(base+path,{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:'{}'}:{})})).status,404,path);
  }
  assert.equal((await fetch(base+'/artwork-completion.js')).status,404);
  const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1280,height:900}});t.after(()=>browser.close());
  const errors=[],outbound=[],artworkRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',request=>{
    if(new URL(request.url()).origin!==base)outbound.push(request.url());
    if(request.url().includes('/api/artwork/'))artworkRequests.push(request.url());
  });
  await page.goto(base);await page.locator('.nav-button[data-route="library"]').click();
  await expect(page.getByRole('button',{name:'사진 없는 앨범 보완',exact:true})).toHaveCount(0);await expect(page.locator('#artwork-completion-dialog')).toHaveCount(0);
  const retainedImage=page.locator(`#library-grid [data-current-id="${retained.id}"] .cover img`);await expect(retainedImage).toBeVisible();await expect.poll(()=>retainedImage.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  await page.screenshot({path:join(out,'collection-preserved.png'),fullPage:true});
  await page.locator('#collection-add').click();const bytes=syntheticFlac();
  await page.locator('#file-input').setInputFiles({name:'embedded.flac',mimeType:'audio/flac',buffer:bytes});await expect(page.locator('#batch-form')).toBeVisible();
  await expect(page.locator('#batch-list')).toContainText('내장 표지');await expect(page.locator('#batch-form')).not.toContainText('온라인');await expect(page.locator('[id^="artwork-import"]')).toHaveCount(0);
  await page.screenshot({path:join(out,'import-embedded-only.png'),fullPage:true});await page.locator('#commit-import').click();await expect(page.locator('#import-complete')).toBeVisible();await expect(page.locator('#import-complete')).not.toContainText('사진 결과');
  const state=await api('/api/state'),added=state.tracks.find(track=>track.id!==retained.id);assert.ok(added.artworkPath.endsWith('cover.png'));
  const addedFull=await api(`/api/tracks/${added.id}`);assert.deepEqual(await readFile(join(data,'library',addedFull.managedPath)),bytes);assert.deepEqual(await readFile(join(data,'library',added.artworkPath)),picture);
  await page.locator('#open-imported').click();await page.locator(`#library-grid [data-current-id="${added.id}"] [data-row-play]`).press('Shift+F10');await page.locator('.song-menu:popover-open').getByRole('menuitem',{name:'가사·곡 정보',exact:true}).click();
  await page.locator('#detail-content [data-more]').click();await page.locator('[data-artwork-menu]').click();
  await page.locator('[data-artwork-file]').setInputFiles({name:'manual.png',mimeType:'image/png',buffer:picture});await expect(page.locator('[data-artwork-save]')).toBeEnabled();await page.locator('[data-artwork-save]').click();await expect(page.locator('.artwork-dialog')).not.toBeVisible();
  const manual=await api(`/api/tracks/${added.id}`);assert.match(manual.artworkPath,/cover-manual-/);assert.deepEqual(await readFile(join(data,'library',added.artworkPath)),picture);
  await page.screenshot({path:join(out,'manual-registration-retained.png'),fullPage:true});
  assert.deepEqual(await api(`/api/tracks/${retained.id}`),retained);assert.deepEqual(await readFile(oldPhoto),picture);assert.deepEqual(await readFile(oldPhoto+'.json'),sidecar);
  assert.deepEqual(await readFile(library.resolveManagedPath(retained.managedPath)),originalAudio);assert.equal(await readFile(library.resolveManagedPath(retained.lyricsFilePath),'utf8'),lrc);
  assert.deepEqual((await api('/api/export')).queues,before.queues);assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);assert.deepEqual(artworkRequests,[]);
  await writeFile(join(out,'results.json'),JSON.stringify({apiRemoved:true,uiRemoved:true,automaticArtworkAndSidecarPreserved:true,embeddedExtraction:true,manualRegistration:true,audioLyricsNotesAndQueuePreserved:true,outboundRequests:0,removedAPIRequestsFromUI:0,errors},null,2));
});
