import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('Packaged Mac alarm: preload, scheduler, hidden-window restore, first-key stop and persisted daily claim', {skip:!process.env.RUN_DESKTOP_TESTS,timeout:120000},async t=>{
 const module=process.env.PLAYWRIGHT_MODULE;const {_electron}=await import(module||'playwright');const {expect}=await import(module?pathToFileURL(join(module,'..','test.mjs')).href:'playwright/test');
 const temp=await mkdtemp(join(tmpdir(),'cove-alarm-native-')),data=join(temp,'data'),profile=join(temp,'profile'),out=resolve(process.env.ALARM_NATIVE_ARTIFACT_DIR||join(temp,'evidence'));await mkdir(out,{recursive:true});
 let desktop,page;const errors=[];
 const launch=async()=>{
  desktop=await _electron.launch({executablePath:resolve(process.env.COVE_TEST_APP || 'dist/Cove.app/Contents/MacOS/Cove'),args:['--mute-audio'],env:{...process.env,COVE_DATA_DIR:data,COVE_PROFILE_DIR:profile}});
  page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>typeof window.coveAlarm?.get==='function');await page.waitForLoadState('domcontentloaded');
 };
 t.after(async()=>{await page?.screenshot({path:join(out,'last-state.png')}).catch(()=>{});await desktop?.close().catch(()=>{});});
 await launch();const url=new URL(page.url()).origin,tracks=[];
 for(let i=0;i<4;i++){
  const body=playableFlac({title:`Mac 알람 ${i+1}`,seconds:3,frequency:440});
  const staged=await(await page.request.post(url+'/api/stage',{headers:{'x-file-name':`${i}.flac`},data:body})).json();
  tracks.push(await(await page.request.post(url+'/api/commit',{data:{importId:staged.importId}})).json());
 }
 const invalid=await page.evaluate(()=>window.coveAlarm.save({enabled:true,time:'bad'}));assert(!invalid.ok);assert.equal(await page.evaluate(()=>typeof require),'undefined');
 await desktop.close();desktop=null;
 const settingsPath=join(profile,'library.json'),settings=JSON.parse(await readFile(settingsPath,'utf8'));
 const now=new Date();const time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
 settings.alarm={config:{enabled:true,time,tracks:tracks.slice(0,3).map(t=>t.id),volumes:[.2,.45,.7],classicId:tracks[3].id,classicVolume:.25},runs:[]};
 // Fixture-only settings seed. Does not call pmset or modify real alarm settings.
 await writeFile(settingsPath,JSON.stringify(settings));await launch();
 await expect(page.locator('#alarm-ringing-dialog')).toBeVisible({timeout:15000});await expect(page.locator('#alarm-now-title')).toHaveText('Mac 알람 1');
 const first=(await page.evaluate(()=>window.coveAlarm.get())).value;assert(first.active);assert.equal(first.wake.ready,false);
 await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 await desktop.evaluate(({app})=>app.emit('activate'));assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
 await page.screenshot({path:join(out,'ringing-native.png')});
 await page.keyboard.down('Space');await page.keyboard.up('Space');await expect(page.locator('#alarm-ringing-dialog')).toBeHidden();await expect(page.locator('#mini-track')).toContainText('Mac 알람 4');await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');
 assert.equal((await page.evaluate(()=>window.coveAlarm.get())).value.active,null);
 await desktop.close();desktop=null;await launch();
 const after=(await page.evaluate(()=>window.coveAlarm.get())).value;assert.equal(after.active,null);assert.deepEqual(after.config,settings.alarm.config);
 await expect(page.locator('#alarm-ringing-dialog')).toBeHidden();
 const persisted=JSON.parse(await readFile(settingsPath,'utf8'));assert.equal(persisted.alarm.runs.length,1);
 // Disable on the test profile. No owned system wake exists, so no auth is invoked.
 const disabled=await page.evaluate(async()=>{const current=(await window.coveAlarm.get()).value.config;return window.coveAlarm.save({...current,enabled:false});});assert(disabled.ok);
 const security=await desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return w.webContents.getLastWebPreferences();});assert(security.sandbox&&security.contextIsolation&&!security.nodeIntegration);
 assert.deepEqual(errors,[]);await writeFile(join(out,'results.json'),JSON.stringify({checks:['packaged-preload-available-sandbox-and-invalid-input-rejection','main-process-daily-scheduler-starts-real-audio-without-gesture','close-hides-enabled-window-and-activate-restores','native-before-input-stops-alarm-first-space-and-classic-starts','settings-and-day-claim-survive-relaunch-no-double-ring','disable-fixture-alarm-without-system-schedule-change'],errors,physicalSleepTested:false,temp},null,2));
});
