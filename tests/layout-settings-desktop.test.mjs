import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

test('packaged settings and actual fullscreen/200% keep content, collapsed export and folder access', { skip: !process.env.RUN_DESKTOP_TESTS, timeout: 60000 }, async t => {
  const module = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { _electron } = await import(module);
  const { expect } = await import(module.startsWith('/') ? pathToFileURL(join(module, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'cove-layout-settings-'));
  const out = resolve(process.env.LAYOUT_SETTINGS_ARTIFACT_DIR || join(root, 'evidence'));
  await mkdir(out, { recursive: true });
  const desktop = await _electron.launch({ executablePath: resolve(process.env.COVE_TEST_APP || 'dist/Cove.app/Contents/MacOS/Cove'), args: ['--mute-audio'],
    env: { ...process.env, COVE_DATA_DIR: join(root, 'data'), COVE_PROFILE_DIR: join(root, 'profile') } });
  t.after(async () => {
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {});
    await desktop.close().catch(() => {});
  });
  const page = await desktop.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  const url = new URL(page.url()).origin;
  for (let i = 0; i < 4; i++) {
    const staged = await (await page.request.post(url + '/api/stage', { headers: { 'x-file-name': `${i}.flac` }, data: playableFlac({ title: `감상 검사 ${i + 1}`, seconds: 4 }) })).json();
    const track = await (await page.request.post(url + '/api/commit', { data: { importId: staged.importId } })).json();
    await page.request.put(`${url}/api/tracks/${track.id}/favorite`, { data: { isLifeSong: true } });
    await page.request.post(`${url}/api/tracks/${track.id}/playback`, { data: { listenedMs: 6000 } });
  }
  await page.reload();
  await expect(page.locator('#favorites-list .rediscovery-card')).toHaveCount(4);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const wide = await page.locator('[data-view="home"]').evaluate(el => ({ width: el.clientWidth, x: el.getBoundingClientRect().x,
    available: el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) * 2,
    columns: getComputedStyle(document.querySelector('#favorites-list')).gridTemplateColumns.split(' ').length }));
  assert(wide.x <= 196); assert.equal(wide.columns, wide.available >= 1500 ? 4 : wide.available >= 520 ? 2 : 1);
  await page.screenshot({ path: join(out, 'native-fullscreen-today.png') });
  await page.locator('.nav-button[data-route="library"]').click(); await page.locator('#settings-open').click();
  await expect(page.locator('.settings-signature')).toHaveText('made by woodychoi');
  await expect(page.locator('#settings-dialog a[href="/api/export"]')).toBeHidden();
  await page.getByRole('button', { name: '지정 폴더 열기', exact: true }).click();
  await expect(page.locator('#auto-import-setting-error')).toContainText('설정되지 않았습니다');
  await page.screenshot({ path: join(out, 'native-settings.png') });
  await desktop.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setFullScreen(false); w.webContents.setZoomFactor(2); });
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(2);
  await page.locator('.settings-more > summary').click();
  const exportLink = page.locator('#settings-dialog a[href="/api/export"]');
  await exportLink.focus();
  await expect.poll(() => exportLink.evaluate(el => {
    const r = el.getBoundingClientRect(), body = el.closest('.dialog-body').getBoundingClientRect();
    return r.top >= body.top + 3 && r.bottom <= body.bottom - 3 && r.left >= 3 && r.right <= innerWidth - 3;
  })).toBe(true);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await writeFile(join(out, 'native-200-settings.png'), Buffer.from(await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64'));
  await page.locator('#settings-dialog [data-dialog-close]').click();
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ version: '0.1.15', wide, actualZoom: 2, errors, temporaryData: root }, null, 2));
});
