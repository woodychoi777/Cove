import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('Alarm UI: configuration, measured fade, ordered stages, keyboard dismissal and normal queue preservation', {skip:!process.env.RUN_BROWSER_TESTS,timeout:120000},async t=>{
 const module=process.env.PLAYWRIGHT_MODULE;const {chromium}=await import(module||'playwright');
 const {expect}=await import(module?pathToFileURL(join(module,'..','test.mjs')).href:'playwright/test');
 const temp=await mkdtemp(join(tmpdir(),'cove-alarm-')),out=resolve(process.env.ALARM_ARTIFACT_DIR||join(temp,'evidence'));await mkdir(out,{recursive:true});
 const server=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,PORT:'46317',SORISEOJAE_DATA_DIR:join(temp,'data')},stdio:['ignore','pipe','pipe']});t.after(()=>server.kill('SIGTERM'));
 await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('server timeout')),10000);server.stdout.on('data',c=>{if(String(c).includes('프로토타입:')){clearTimeout(timer);ok()}});server.on('error',no)});
 const url='http://127.0.0.1:46317',tracks=[];
 for(let i=0;i<5;i++){
  const body=playableFlac({title:['고요한 아침','천천히 일어나기','활기찬 하루','아침 클래식','원래 듣던 음악'][i],artist:'알람 검사',seconds:i===0?12:3,frequency:440});
  const staged=await(await fetch(url+'/api/stage',{method:'POST',headers:{'x-file-name':`${i}.flac`},body})).json();
  tracks.push(await(await fetch(url+'/api/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({importId:staged.importId})})).json());
 }
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({ids})=>{
  window.__config={enabled:false,time:'07:00',tracks:[null,null,null],volumes:[.2,.45,.7],classicId:null,classicVolume:.25};window.__acks=[];window.__gain=[];
  const ok=value=>Promise.resolve({ok:true,value});
  window.coveAlarm={get:()=>ok({config:window.__config,wake:{message:'깨우기 예약 검사 모드'}}),save:c=>{
   if(c.enabled&&([...c.tracks,c.classicId].includes(null)))return Promise.resolve({ok:false,error:'네 곡을 선택해 주세요.'});window.__config=structuredClone(c);return ok({config:c,wake:{message:'검사 예약'}});
  },preview:v=>ok(v),stop:t=>{window.__acks.push(t);return ok(true)},ready:()=>ok(null),onEvent:fn=>window.__alarmEvent=fn};
  const Native=window.AudioContext;window.__contexts=[];
  window.AudioContext=class extends Native{constructor(...args){super(...args);window.__contexts.push(this)}createGain(){const gain=super.createGain(),connect=gain.connect.bind(gain);gain.connect=(destination,...rest)=>{
   if(destination===this.destination){this.__meter=this.createAnalyser();this.__meter.fftSize=2048;this.__meter.connect(destination);return connect(this.__meter,...rest)}return connect(destination,...rest)};return gain}};
  localStorage.setItem('soriseojae.queue',JSON.stringify({ids:[ids[4],ids[1]],index:0,source:'보관할 목록',shuffle:true,repeat:'all',fadeSeconds:2}));
 },{ids:tracks.map(t=>t.id)});
 await page.goto(url);await page.locator('[data-route="library"]').first().click();await page.locator('#settings-open').click();await page.locator('#alarm-open').click();
 await expect(page.locator('#alarm-settings-dialog')).toBeVisible();await page.locator('#alarm-enabled').check();await page.locator('#alarm-settings-form .primary-button').click();await expect(page.locator('#alarm-settings-error')).toContainText('네 곡');
 for(let i=0;i<4;i++){await page.locator(`[data-alarm-choose="${i}"]`).click();await page.locator('#alarm-song-search').fill(tracks[i].title);await page.locator(`[data-alarm-track="${tracks[i].id}"]`).click();}
 for(const [width,height,scheme]of[[1280,900,'light'],[390,700,'light'],[600,434,'dark'],[320,640,'dark']]){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});await page.locator('#alarm-settings-form .primary-button').focus();
  const layout=await page.locator('#alarm-settings-dialog').evaluate(el=>{const r=el.getBoundingClientRect(),a=el.querySelector('.form-actions').getBoundingClientRect();return{fits:r.top>=0&&r.bottom<=innerHeight&&r.width<=innerWidth,actions:a.bottom<=r.bottom,overflow:document.documentElement.scrollWidth>innerWidth}});assert(layout.fits&&layout.actions&&!layout.overflow);await page.screenshot({path:join(out,`settings-${scheme}-${width}.png`)});
 }
 await page.setViewportSize({width:1280,height:900});await page.locator('#alarm-settings-form .primary-button').click();await expect(page.locator('#alarm-settings-dialog')).toBeHidden();
 const normal=await page.evaluate(()=>localStorage.getItem('soriseojae.queue'));
 await page.evaluate(()=>window.__alarmEvent({type:'start',token:'scheduled-test',config:window.__config}));
 await expect(page.locator('#alarm-ringing-dialog')).toBeVisible();await expect(page.locator('#alarm-now-title')).toHaveText(tracks[0].title);
 const rms=()=>page.evaluate(()=>{const meter=window.__contexts.at(-1)?.__meter;if(!meter)return 0;const data=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length)});
 await expect.poll(rms,{timeout:5000}).toBeGreaterThan(.00001);const early=await rms();
 // Measure the actual audio graph's envelope, not only slider text.
 await expect.poll(rms,{timeout:10000,intervals:[400]}).toBeGreaterThan(early*3);const later=await rms();
 await page.screenshot({path:join(out,'ringing.png')});
 await expect(page.locator('#alarm-now-title')).toHaveText(tracks[1].title,{timeout:15000});
 await expect(page.locator('#alarm-now-title')).toHaveText(tracks[2].title,{timeout:6000});
 await expect.poll(async()=>Number(await page.locator('#mini-volume-inline').inputValue())).toBe(.7);
 await expect(page.locator('#alarm-ringing-dialog')).toBeHidden({timeout:7000});
 await expect(page.locator('#mini-track')).toContainText(tracks[3].title);await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');assert.deepEqual(await page.evaluate(()=>window.__acks),['scheduled-test']);
 await expect(page.locator('#mini-track')).toContainText(tracks[4].title,{timeout:7000});await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');
 assert.equal(await page.evaluate(()=>localStorage.getItem('soriseojae.queue')),normal);assert.deepEqual(errors,[]);
 await writeFile(join(out,'results.json'),JSON.stringify({checks:['four-song-search-and-validation','four-modal-layouts-light-dark-fixed-actions','real-audio-first-stage-ramp','ordered-three-stage-volumes','automatic-third-end-classic-plays-once-no-repeat','normal-queue-and-mode-persistence-unchanged'],rms:{early,later},errors,temp},null,2));
});
