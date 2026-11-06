import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {playableFlac} from './fixtures.mjs';

test('public readiness: discoverable import, preview/rollback, watch during playback, drafts and responsive focus', {skip:!process.env.RUN_BROWSER_TESTS,timeout:90000},async t=>{
 const module=process.env.PLAYWRIGHT_MODULE||'playwright';const {chromium}=await import(module);
 const {expect}=await import(module.startsWith('/')?pathToFileURL(join(module,'..','test.mjs')).href:'playwright/test');
 const root=await mkdtemp(join(tmpdir(),'cove-public-browser-')),data=join(root,'data'),inbox=join(root,'inbox');await mkdir(inbox);
 const out=resolve(process.env.PUBLIC_ARTIFACT_DIR||join(root,'evidence'));await mkdir(out,{recursive:true});
 const server=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,PORT:'48417',SORISEOJAE_DATA_DIR:data},stdio:['ignore','pipe','pipe']});t.after(()=>server.kill('SIGTERM'));
 await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('server timeout')),10000);server.stdout.on('data',b=>{if(String(b).includes('프로토타입:')){clearTimeout(timer);ok();}});server.on('exit',c=>{clearTimeout(timer);no(Error('server '+c));});});
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const Native=AudioContext;window.__audio=[];window.AudioContext=class extends Native{constructor(...args){super(...args);window.__audio.push(this);}createGain(){const gain=super.createGain(),connect=gain.connect.bind(gain);gain.connect=(...args)=>{if(args[0]===this.destination){this.__meter=this.createAnalyser();connect(this.__meter);}return connect(...args);};return gain;}};});
 const url='http://127.0.0.1:48417';await page.goto(url);
 await expect(page.locator('[data-view="home"] [data-route="import"]')).toBeVisible();await expect(page.locator('#settings-open')).toBeVisible();
 await page.screenshot({path:join(out,'first-use-web.png')});await page.locator('#collection-add').click();
 await page.locator('.import-storage > summary').click();await expect(page.locator('#import-library-path')).toContainText('library');
 const originals=[];for(let i=0;i<3;i++){const bytes=playableFlac({title:'공개 검사 '+(i+1),seconds:30,frequency:330+i*110}),path=join(root,i+'.flac');await writeFile(path,bytes);originals.push({path,bytes});}
 await writeFile(join(root,'0.lrc'),'[00:00]첫 줄\n[00:03]두 번째 줄\n[00:06]세 번째 줄');
 await page.locator('#import-review-first').check();await page.locator('#file-input').setInputFiles([...originals.map(f=>f.path),join(root,'0.lrc')]);
 await expect(page.locator('#review-summary')).toHaveText('3곡을 추가할 수 있습니다');
 await page.getByRole('button',{name:'3곡 복사하여 추가',exact:true}).click();
 await page.locator('.nav-button[data-route="library"]').click();
 await expect(page.locator('#library-grid [data-row-play]')).toHaveCount(3);
 const state=()=>page.request.get(url+'/api/state').then(r=>r.json());let initial=await state();const token=initial.localToken;
 const headers={'x-local-token':token};
 assert.equal((await page.request.post(url+'/api/auto-import/preview',{data:{directory:inbox}})).status(),403);
 await page.locator('#playlist-create').click();await page.locator('#playlist-name-form input').fill('첫 감상');await page.keyboard.press('Escape');await expect(page.locator('#playlist-create')).toBeFocused();
 await page.locator('#library-grid [data-row-play]').first().click();await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');
 const queue=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('soriseojae.queue')));const before=await queue();
 await expect.poll(()=>page.evaluate(()=>{const ctx=window.__audio.find(c=>c.__meter);if(!ctx)return 0;const b=new Float32Array(ctx.__meter.fftSize);ctx.__meter.getFloatTimeDomainData(b);return Math.sqrt(b.reduce((a,x)=>a+x*x,0)/b.length);})).toBeGreaterThan(.01);
 await page.locator('#mini-track').click();await page.locator('[data-comments]').click();await page.locator('#comment-text').fill('자동 추가 중에도 보존하는 코멘트 초안');await page.keyboard.press('Escape');
 await page.locator('[data-detail-back]').click();await page.locator('#settings-open').click();
 await expect(page.locator('#settings-dialog')).toBeVisible();await expect(page.locator('.settings-export-help')).toBeHidden();
 await page.locator('#auto-import-folder-choose').click();await page.locator('#auto-import-path').fill(inbox);await page.locator('#auto-import-path-check').click();
 await expect(page.locator('#auto-import-preview')).toBeVisible();await page.locator('#auto-import-preview-cancel').click();assert.equal((await page.request.get(url+'/api/auto-import').then(r=>r.json())).enabled,false);
 await page.locator('#auto-import-path-check').click();await page.locator('#auto-import-preview-confirm').click();await expect(page.locator('#auto-import-toggle')).toBeChecked();
 const saved=await readFile(join(data,'auto-import.json'),'utf8');
 const rejected=await page.request.put(url+'/api/auto-import',{headers,data:{directory:initial.libraryRoot,enabled:true}});assert.equal(rejected.status(),400);assert.equal(await readFile(join(data,'auto-import.json'),'utf8'),saved);
 await page.screenshot({path:join(out,'grouped-settings-web.png')});await page.keyboard.press('Escape');
 await writeFile(join(inbox,'자동 추가.flac'),playableFlac({title:'자동 추가 검사',seconds:12,frequency:770}));
 await expect.poll(async()=>(await state()).tracks.length,{timeout:16000}).toBe(4);
 assert.deepEqual((await queue()).ids,before.ids);assert.equal((await queue()).index,before.index);
 await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');
 await page.locator('#mini-track').click();await page.locator('[data-comments]').click();await expect(page.locator('#comment-text')).toHaveValue('자동 추가 중에도 보존하는 코멘트 초안');await page.keyboard.press('Escape');
 await page.locator('[data-detail-back]').click();await page.locator('#mini-play').click();
 await page.locator('#settings-open').click();await page.locator('.settings-more > summary').click();await expect(page.locator('.settings-export-help')).toContainText('음원 파일과 표지는 포함하지 않습니다');await page.keyboard.press('Escape');await expect(page.locator('#settings-open')).toBeFocused();
 for(const width of [680,390]){await page.setViewportSize({width,height:700});for(const id of ['#collection-add','#settings-open']){await page.locator(id).focus();assert(await page.locator(id).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}));}assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(out,'web-'+width+'.png')});}
 for(const f of originals)assert.deepEqual(await readFile(f.path),f.bytes);
 for(const track of initial.tracks){const detail=await page.request.get(url+'/api/tracks/'+track.id).then(r=>r.json());assert.deepEqual(await readFile(join(data,'library',detail.managedPath)),originals[Number(detail.originalName.split('.')[0])].bytes);}
 assert.deepEqual(errors,[]);await writeFile(join(out,'browser-results.json'),JSON.stringify({imported:4,playbackRmsAbove:.01,queueAndDraftPreserved:true,errors},null,2));console.log('public browser evidence: '+out);
});
