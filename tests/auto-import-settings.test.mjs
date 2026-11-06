import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('settings switch stops polling, persists off across restart, resumes import and recovers a failed save', { skip: !process.env.RUN_DESKTOP_TESTS, timeout: 60000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { _electron } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'cove-settings-'));
  const data = join(root, 'data'), inbox = join(root, 'inbox');
  const evidence = resolve(process.env.SETTINGS_ARTIFACT_DIR || join(root,'evidence')); await mkdir(evidence,{recursive:true});
  await mkdir(data); await mkdir(inbox);
  await writeFile(join(data, 'auto-import.json'), JSON.stringify({ enabled: true, directory: inbox, mode: 'move' }));
  let desktop, page, address;
  async function launch() {
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [resolve('desktop/main.cjs')],
      env: { ...process.env, COVE_DATA_DIR: data, COVE_PROFILE_DIR: join(root, 'profile') } });
    page = await desktop.firstWindow();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    address = new URL(page.url()).origin;
    await page.locator('.nav-button[data-route="library"]').click();
    await page.locator('#settings-open').click();
  }
  async function close() {
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy()));
    await desktop.close(); desktop = null;
  }
  t.after(async () => { if (desktop) await close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await launch();
  // Stub only the OS folder launch; the real preload, trusted IPC and configured path run.
  await desktop.evaluate(({ shell }) => { globalThis.__folderCalls=[]; shell.openPath=async path => { globalThis.__folderCalls.push(path); return ''; }; });
  const openFolder = page.getByRole('button', { name: '지정 폴더 열기', exact: true });
  await openFolder.click(); await expect(openFolder).toBeEnabled();
  assert.equal((await desktop.evaluate(() => globalThis.__folderCalls))[0].replace('/private/var/', '/var/'), inbox.replace('/private/var/', '/var/')); 
  const more = page.locator('.settings-more');
  await expect(more.locator('a[href="/api/export"]')).toBeHidden();
  await expect(page.locator('#library-path')).toBeHidden();
  await more.locator('summary').click();
  await expect(more.locator('a[href="/api/export"]')).toBeVisible();
  await expect(page.locator('#library-path')).toBeVisible();
  const exported = await (await page.request.get(address + '/api/export')).json(); assert(Array.isArray(exported.tracks));
  await more.locator('summary').click();
  await rm(inbox,{recursive:true}); await openFolder.click();
  await expect(page.locator('#auto-import-setting-error')).toContainText('지정 폴더를 찾지 못했습니다');
  await mkdir(inbox); await openFolder.click(); await expect(page.locator('#auto-import-setting-error')).toBeHidden();
  let toggle = page.getByRole('switch', { name: '폴더에서 음악 가져오기', exact: true });
  await expect(toggle).toBeChecked();
  await page.locator('#theme-setting').selectOption('light');
  await page.screenshot({ path: join(evidence, 'auto-import-settings-light.png') });
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  assert.equal(JSON.parse(await readFile(join(data, 'auto-import.json'), 'utf8')).enabled, false);
  await close(); await launch();
  toggle = page.getByRole('switch', { name: '폴더에서 음악 가져오기', exact: true });
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  await page.locator('#settings-dialog [data-dialog-close]').click();
  let statusRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/auto-import')) statusRequests++; });
  await writeFile(join(inbox, 'pending.flac'), playableFlac({ title: 'Switch test', seconds: .2 }));
  await new Promise(ok => setTimeout(ok, 10500)); // Longer than the production stability window.
  assert.equal((await (await page.request.get(address + '/api/state')).json()).tracks.length, 0);
  assert.equal(statusRequests, 0);
  await readFile(join(inbox, 'pending.flac'));
  await page.locator('#settings-open').click();
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(page.locator('#auto-import-preview')).toBeVisible();
  await page.locator('#auto-import-preview-confirm').click();
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  await expect.poll(async () => (await (await page.request.get(address + '/api/state')).json()).tracks.length, { timeout: 16000 }).toBe(1);
  assert.equal((await (await page.request.get(address + '/api/auto-import')).json()).mode, 'move');
  await expect.poll(async () => { try { await readFile(join(inbox, 'pending.flac')); return true; } catch { return false; } }).toBe(false);
  await page.route('**/api/auto-import', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: '설정을 저장하지 못했습니다.' } }) : route.continue());
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  await expect(page.locator('#auto-import-setting-error')).toBeVisible();
  assert.equal(JSON.parse(await readFile(join(data, 'auto-import.json'), 'utf8')).enabled, true);
  await page.unroute('**/api/auto-import');
  await page.locator('#theme-setting').selectOption('dark');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(680, 540));
  await expect(toggle).toBeInViewport();
  await expect(page.locator('#settings-dialog [data-dialog-close]')).toBeInViewport();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(evidence, 'auto-import-settings-dark-small.png') });
});
