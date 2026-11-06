import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('backend restart preserves the window and draft, refreshes authorization, and writes diagnostics', { skip: !process.env.RUN_DESKTOP_TESTS, timeout: 45000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { _electron } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'cove-recovery-'));
  const data = join(root, 'data');
  const packaged = Boolean(process.env.COVE_TEST_PACKAGED);
  const desktop = await _electron.launch({
    executablePath: resolve(packaged ? 'dist/Cove.app/Contents/MacOS/Cove' : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: packaged ? [] : [resolve('desktop/main.cjs')],
    env: { ...process.env, COVE_DATA_DIR: data, COVE_PROFILE_DIR: join(root, 'profile') }
  });
  t.after(async () => {
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    await desktop.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const page = await desktop.firstWindow();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  const address = new URL(page.url()).origin;
  const original = await (await page.request.get(address + '/api/state')).json();
  await page.locator('.nav-button[data-route="library"]').click();
  await page.locator('#collection-add').click();
  await page.locator('.move-import summary').click();
  const draft = join(root, 'unsent-music-folder');
  await page.locator('#local-paths').fill(draft);
  const pid = await desktop.evaluate(({ app }) => app.getAppMetrics().find(item => item.name === 'Cove Music Library').pid);
  await desktop.evaluate((_electron, pid) => process.kill(pid, 'SIGTERM'), pid);
  await expect.poll(async () => {
    try { return (await (await page.request.get(address + '/api/state', { timeout: 1000 })).json()).localToken || original.localToken; }
    catch { return original.localToken; }
  }, { timeout: 15000 }).not.toBe(original.localToken);
  await expect(page.locator('#toast')).toHaveText('음악 서재에 다시 연결했습니다.');
  assert.equal(new URL(page.url()).origin, address);
  await expect(page.locator('#local-paths')).toHaveValue(draft);
  const response = page.waitForResponse(response => response.url() === address + '/api/local-stage');
  await page.locator('#local-import-form button').click();
  assert.equal((await response).status(), 400); // Valid refreshed token; deliberately absent folder.
  const log = await readFile(join(data, 'service.log'), 'utf8');
  assert.match(log, /Library service exited/);
  assert.match(log, /Library service reconnected/);
});
