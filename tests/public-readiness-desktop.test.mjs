import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {playableFlac} from './fixtures.mjs';
test('packaged public readiness: native folder preview, cancel, saved copy config and actual 200% focus',{skip:!process.env.RUN_DESKTOP_TESTS,timeout:60000},async t=>{
 const module=process.env.PLAYWRIGHT_MODULE||'playwright', {_electron}=await import(module);const {expect}=await import(module.startsWith('/')?pathToFileURL(join(module,'..','test.mjs')).href:'playwright/test');
 const root=await mkdtemp(join(tmpdir(),'cove-public-native-')),inbox=join(root,'source'),data=join(root,'data');await mkdir(join(inbox,'가수','앨범'),{recursive:true});await writeFile(join(inbox,'가수','앨범','곡.flac'),playableFlac({seconds:1}));
 const out=resolve(process.env.PUBLIC_ARTIFACT_DIR||join(root,'evidence'));await mkdir(out,{recursive:true});
 const app=await _electron.launch({executablePath:resolve(process.env.COVE_TEST_APP||'dist/Cove.app/Contents/MacOS/Cove'),args:['--mute-audio'],env:{...process.env,COVE_DATA_DIR:data,COVE_PROFILE_DIR:join(root,'profile')}});
 t.after(async()=>{await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeVisible();
 await page.locator('#settings-open').click();
 await expect(page.locator('.settings-signature')).toHaveText('Made by woodychoi777');
 await expect(page.locator('#settings-dialog .dialog-heading [data-dialog-close]')).toBeVisible();
 assert(await page.locator('#settings-dialog [data-dialog-close]').evaluate(el=>{const b=el.getBoundingClientRect(),d=el.closest('dialog').getBoundingClientRect();return b.right<=d.right&&b.right>=d.right-60&&b.top<d.top+60;}));
 await page.locator('#settings-title').click();await expect(page.locator('#settings-dialog')).toBeVisible();
 await page.mouse.click(4,4);await expect(page.locator('#settings-dialog')).toBeHidden();await expect(page.locator('#settings-open')).toBeFocused();
 await page.locator('#settings-open').click();await page.locator('#settings-dialog [data-dialog-close]').click();await expect(page.locator('#settings-dialog')).toBeHidden();
 await page.locator('#settings-open').click();

 // Stub OS chooser responses, retaining the real preload, IPC trust boundary, HTTP validation and filesystem.
 await app.evaluate(({dialog,shell},path)=>{globalThis.__picker=[];globalThis.__opened=[];dialog.showOpenDialog=async(_owner,options)=>{globalThis.__picker.push(options);return{canceled:false,filePaths:[path]};};shell.openPath=async path=>{globalThis.__opened.push(path);return '';};},inbox);
 await page.locator('#auto-import-folder-choose').click();await expect(page.locator('#auto-import-preview-copy')).toContainText('기존 음악 1곡');await expect(page.locator('#auto-import-preview-copy')).toContainText('하위 폴더 포함');
 assert.equal((await page.request.get(new URL('/api/auto-import',page.url()).href).then(r=>r.json())).enabled,false);
 await page.locator('#auto-import-preview-cancel').click();
 await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});await page.locator('#auto-import-folder-choose').click();await expect(page.locator('#auto-import-preview')).toBeHidden();
 await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},inbox);
 await page.locator('#auto-import-folder-choose').click();await page.locator('#auto-import-preview-confirm').click();await expect(page.locator('#auto-import-toggle')).toBeChecked();
 const config=JSON.parse(await readFile(join(data,'auto-import.json'),'utf8'));assert.equal(config.directory,await realpath(inbox));assert.equal(config.mode,'copy');
 await page.locator('#auto-import-folder-open').click();await expect(page.locator('#auto-import-folder-open')).toBeEnabled();assert.deepEqual(await app.evaluate(()=>globalThis.__opened),[config.directory]);
 await page.locator('#theme-setting').selectOption('light');await page.screenshot({path:join(out,'native-settings-light.png')});
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1000,800);w.webContents.setZoomFactor(2);});assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),2);
 await page.locator('.settings-more > summary').click();const exportLink=page.locator('#settings-dialog a[href="/api/export"]');await exportLink.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');await expect(exportLink).toBeFocused();
 await expect.poll(()=>exportLink.evaluate(el=>{const r=el.getBoundingClientRect(),body=el.closest('.dialog-body').getBoundingClientRect();return r.top>=body.top+3&&r.bottom<=body.bottom-3&&r.left>=3&&r.right<=innerWidth-3;})).toBe(true);
 await writeFile(join(out,'native-settings-200.png'),Buffer.from(await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')),'base64'));await page.keyboard.press('Escape');await expect(page.locator('#settings-open')).toBeFocused();
 await page.locator('#collection-add').focus();await expect(page.locator('#collection-add')).toBeInViewport();await page.keyboard.press('Enter');await expect(page.locator('[data-view="import"]')).toBeVisible();
 await page.locator('#choose-files').focus();await expect(page.locator('#choose-files')).toBeInViewport();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await writeFile(join(out,'native-import-200.png'),Buffer.from(await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')),'base64'));
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setZoomFactor(1);w.setContentSize(680,540);});await page.locator('#settings-open').click();await page.locator('#theme-setting').selectOption('dark');await page.screenshot({path:join(out,'native-settings-small-dark.png')});
 assert.deepEqual(errors,[]);await writeFile(join(out,'desktop-results.json'),JSON.stringify({version:'0.1.19',actualZoom:2,nativePickerIPC:true,previewBeforeStart:true,cancelPreserved:true,errors},null,2));console.log('public native evidence: '+out);
});
