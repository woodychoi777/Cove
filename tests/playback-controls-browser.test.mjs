import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';
import { openCollectionSong, navigateTo } from './song-ui.mjs';

test('방향키·미디어 제어와 입력·팝업·탭 보호', { skip: !process.env.RUN_BROWSER_TESTS, timeout: 120000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright', { chromium } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const temp = await mkdtemp(join(tmpdir(), 'cove-info-browser-'));
  const out = resolve(process.env.INFO_ARTIFACT_DIR || join(temp, 'evidence')); await mkdir(out, { recursive: true });
  const url = 'http://127.0.0.1:45331';
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '45331', SORISEOJAE_DATA_DIR: join(temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk);
  await new Promise((ok, no) => { const timer = setTimeout(() => no(Error(stderr || 'server timeout')), 10000); server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); ok(); } }); server.on('exit', () => { clearTimeout(timer); no(Error(stderr)); }); });
  const tracks = [];
  for (let i=0;i<3;i++) {
    const bytes = playableFlac({ title: `단축키 ${i}`, seconds: 30 });
    const staged = await (await fetch(`${url}/api/stage`, { method:'POST', headers:{'x-file-name':`${i}.flac`}, body:bytes })).json();
    tracks.push(await (await fetch(`${url}/api/commit`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({importId:staged.importId})})).json());
  }
  tracks.reverse(); // Collection defaults to newest first.
  const browser = await chromium.launch({headless:true,channel:'chrome',args:['--mute-audio']}); t.after(()=>browser.close());
  const page = await browser.newPage(); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.testMediaActions={}; const media=navigator.mediaSession, set=media.setActionHandler.bind(media); media.setActionHandler=(name,fn)=>{window.testMediaActions[name]=fn;set(name,fn);};});
  await page.goto(url); await navigateTo(page,'library'); await openCollectionSong(page,tracks[1].id);
  const current = () => page.evaluate(()=>{const q=JSON.parse(localStorage.getItem('soriseojae.queue')); return q.ids[q.index];});
  const blur = () => page.evaluate(()=>document.activeElement?.blur()); await blur();
  const slider=page.locator('#mini-volume-inline'); const initial=Number(await slider.inputValue());
  await page.keyboard.press('ArrowDown'); await expect(slider).toHaveValue(String(Math.round((initial-.05)*100)/100));
  await page.keyboard.press('ArrowUp'); await expect(slider).toHaveValue(String(initial));
  await page.keyboard.down('ArrowRight'); await expect.poll(current).toBe(tracks[2].id); await page.keyboard.down('ArrowRight'); await page.keyboard.up('ArrowRight'); assert.equal(await current(),tracks[2].id);
  await page.keyboard.press('ArrowLeft'); await expect.poll(current).toBe(tracks[1].id);
  await navigateTo(page,'library'); await blur(); await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-route','detail');
  await expect(page.locator('#notes-form')).toHaveAttribute('data-track-id',String(tracks[1].id));
  await page.evaluate(()=>window.testMediaActions.previoustrack()); await expect.poll(current).toBe(tracks[0].id);
  await page.evaluate(()=>window.testMediaActions.nexttrack()); await expect.poll(current).toBe(tracks[1].id);
  await page.evaluate(()=>window.testMediaActions.pause()); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','재생');
  await page.evaluate(()=>window.testMediaActions.play()); await expect(page.locator('#mini-play')).toHaveAttribute('aria-label','일시정지');
  await expect.poll(()=>page.evaluate(()=>navigator.mediaSession.metadata.title)).toBe(tracks[1].title);
  await navigateTo(page,'library'); await page.locator('#search-input').fill('단축키'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowDown'); assert.equal(await current(),tracks[1].id);
  await page.locator('#settings-open').click(); await page.keyboard.press('ArrowRight'); assert.equal(await current(),tracks[1].id);
  await page.screenshot({path:join(out,'settings-key-protection.png')}); await page.keyboard.press('Escape');
  await page.locator('[role="tab"]').first().focus(); await page.keyboard.press('ArrowRight'); assert.equal(await current(),tracks[1].id);
  assert.deepEqual(errors,[]);
});
