import { ensureLyricsEditing, leaveListening, toggleManage, openComments, songMenu, openCollectionSong } from './song-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playableFlac } from './fixtures.mjs';

// Opt in separately or with the full browser suite. All data belongs to this temp root.
test('D1·D2: 저장 중 기준값 복귀와 고정 조작 사이의 키보드 포커스', { skip: !process.env.RUN_BROWSER_TESTS && !process.env.RUN_DEFECT_TESTS, timeout: 180000 }, async t => {
  const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(modulePath);
  const { expect } = await import(modulePath.startsWith('/') ? pathToFileURL(join(modulePath, '..', 'test.mjs')).href : 'playwright/test');
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-defects-'));
  const out = resolve(process.env.DEFECT_ARTIFACT_DIR || join(root, 'artifacts')); await mkdir(out, { recursive: true });
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '18317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', chunk => stderr += chunk);
  t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || '서버 시작 시간 초과')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); resolve(); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); });
  });
  const url = 'http://127.0.0.1:18317';
  const original = playableFlac({ title: 'D1 곡 A', seconds: 2 });
  const source = join(root, 'A.flac'); await writeFile(source, original);
  const lrc = Buffer.from('\uFEFF[00:00]검증 전용 가사\r\n');
  const tracks = [];
  for (const [index, bytes] of [original, playableFlac({ title: 'D1 곡 B', seconds: 2, frequency: 550 })].entries()) {
    const staged = await (await fetch(`${url}/api/stage`, { method: 'POST', headers: { 'x-file-name': `${index}.flac` }, body: bytes })).json();
    tracks.push(await (await fetch(`${url}/api/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: staged.importId, metadata: { lrcText: lrc.toString('utf8'), lrcSourceName: 'test.lrc' } }) })).json());
  }
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.screenshot({ path: join(out, 'last-state.png') }).catch(() => {}); await browser.close(); });
  await page.goto(url);
  const nav = async route => {
    await leaveListening(page);
    if (route === 'import') { await page.locator('.nav-button[data-route="library"]').click(); await page.locator('#collection-add').click(); }
    else if (route === 'queue') { await page.locator('#queue-open').click(); if (!await page.locator('#queue-extras').evaluate(el => el.open)) await page.locator('#queue-extras > summary').click(); }
    else await page.locator(`.nav-button[data-route="${route}"]`).click();
  };
  const manage = () => toggleManage(page);
  const open = async id => { await nav('library'); await openCollectionSong(page, id); };
  const tab = () => ensureLyricsEditing(page);
  const fields = ['lyricsOriginal', 'lyricsTranslation'];
  const baseline = Object.fromEntries(fields.map(field => [field, field === 'isLifeSong' ? false : `기준 ${field}`]));
  const edit = async values => {
    await tab('가사와 번역');
    for (const field of fields.slice(0, 2)) await page.locator(`[name="${field}"]`).fill(values[field]);
    await tab('해석과 나의 기록');
    for (const field of fields.slice(2, 5)) await page.locator(`[name="${field}"]`).fill(values[field]);
  };
  const assertValues = async values => {
    for (const field of fields.slice(0, 5)) await expect(page.locator(`[name="${field}"]`)).toHaveValue(values[field]);
  };
  const save = async () => { await ensureLyricsEditing(page); await page.getByRole('button', { name: '가사 저장', exact: true }).click(); };
  const draft = page.locator('[data-detail-draft]');
  const results = [];
  await open(tracks[0].id); await manage();
  await edit(baseline); await save(); await expect(draft).toBeHidden();
  for (const success of [true, false]) {
    // Isolate each field, including the checkbox, so whole-form baseline equality occurs.
    for (const field of fields) {
      const submitted = { ...baseline, [field]: field === 'isLifeSong' ? true : `제출 ${field}` };
      await edit(submitted);
      let release, held = false;
      await page.route(`**/api/tracks/${tracks[0].id}/notes`, async route => {
        const response = success ? await route.fetch() : null;
        held = true; await new Promise(resolve => { release = resolve; });
        await route.fulfill(success ? { response } : { status: 500, json: { error: 'D1 테스트 저장 실패' } });
      });
      await save(); await expect.poll(() => held).toBe(true);
      await edit(baseline); await expect(draft).toBeVisible();
      await open(tracks[1].id);
      // B's draft must survive both completion paths for A.
      await tab('해석과 나의 기록'); await page.locator('[name="lyricsTranslation"]').fill('B만의 기록');
      release(); await expect(page.locator('#toast')).toContainText(success ? '가사 저장됨' : 'D1 테스트 저장 실패');
      await page.unroute(`**/api/tracks/${tracks[0].id}/notes`);
      await open(tracks[0].id); await assertValues(baseline);
      if (success) {
        await expect(draft).toBeVisible();
        const stored = await (await page.request.get(`${url}/api/tracks/${tracks[0].id}`)).json();
        assert.equal(stored[field], submitted[field]);
        await save(); await expect(draft).toBeHidden();
      } else await expect(draft).toBeHidden();
      results.push({ defect: 'D1', field, success, latestPreserved: true });
    }
  }
  // A remains open when the response arrives: rebase and dirty state must also be correct.
  let release, held = false;
  await page.route(`**/api/tracks/${tracks[0].id}/notes`, async route => {
    const response = await route.fetch(); held = true; await new Promise(resolve => { release = resolve; }); await route.fulfill({ response });
  });
  await edit({ ...baseline, lyricsTranslation: '화면 유지 제출' }); await save(); await expect.poll(() => held).toBe(true);
  await edit(baseline); release(); await expect(page.locator('#toast')).toContainText('가사 저장됨');
  await expect(draft).toBeVisible(); await assertValues(baseline);
  await page.unroute(`**/api/tracks/${tracks[0].id}/notes`); await save(); await expect(draft).toBeHidden();
  await open(tracks[1].id); await expect(page.locator('[name="lyricsTranslation"]')).toHaveValue('B만의 기록');
  await save(); await expect(draft).toBeHidden();

  // Restore a paused queue: D2 also occurs without active playback.
  await page.evaluate(ids => localStorage.setItem('soriseojae.queue', JSON.stringify({ ids, index: 0, fadeSeconds: 0 })), tracks.map(track => track.id));
  await page.reload(); await expect(page.locator('#mini-player')).toBeVisible();
  const visibility = () => page.evaluate(() => {
    const a = document.activeElement, rect = a.getBoundingClientRect();
    const player = document.querySelector('#mini-player').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar');
    const top = getComputedStyle(sidebar).position === 'sticky' ? sidebar.getBoundingClientRect().bottom : 0;
    const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    return { target: a.id || a.textContent.trim(), rect: rect.toJSON(), top, playerTop: player.top, visible: rect.top >= top + 6 && rect.bottom <= player.top - 6 && (hit === a || a.contains(hit)), focusVisible: a.matches(':focus-visible') };
  });
  const visible = async label => {
    try { await expect.poll(async () => (await visibility()).visible, { message: label }).toBe(true); }
    catch (error) { console.log(JSON.stringify({ label, viewport: page.viewportSize(), measurement: await visibility() })); throw error; }
    const measured = await visibility(); assert.equal(measured.focusVisible, true, label);
    results.push({ defect: 'D2', viewport: page.viewportSize(), label, ...measured });
  };
  for (const [width, height] of [[320, 800], [390, 800], [756, 456], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await nav('import'); await page.locator('#choose-folder').focus();
    await page.keyboard.press('Tab'); await visible('파일 선택');
    await page.keyboard.press('Tab'); await expect(page.locator('.move-import summary')).toBeFocused(); await visible('이동 고급 옵션');
    await page.screenshot({ path: join(out, `focus-import-${width}.png`) });
    if (!await page.locator('.move-import').evaluate(element => element.open)) await page.keyboard.press('Enter');
    await page.keyboard.press('Tab'); await visible('이동 경로');
    await page.keyboard.press('Tab'); await visible('이동 확인');
    await page.keyboard.press('Shift+Tab'); await visible('이동 경로 역방향');
    await open(tracks[0].id);
    if (await page.locator('body').getAttribute('data-app-mode') !== 'edit') await manage();
    await tab('해석과 나의 기록'); await page.locator('[name="lyricsTranslation"]').focus();
    await page.keyboard.press('Tab'); await visible('감상 미리보기');
    await page.keyboard.press('Tab'); await visible('기록 저장');
    await page.screenshot({ path: join(out, `focus-notes-${width}.png`) });
    await nav('queue'); if (!await page.locator('.queue-settings').evaluate(el => el.open)) await page.locator('.queue-settings summary').click(); await page.locator('#transition-setting').focus();
    await visible('대기열 전환'); await page.keyboard.press('Tab'); await page.locator('[data-queue-play]').first().focus(); await visible('대기열 곡');
    await page.keyboard.press('Tab'); await visible('대기열 아래로');
    await page.keyboard.press('Tab'); await visible('대기열 빼기');
    await page.screenshot({ path: join(out, `focus-queue-${width}.png`) });
    // Reverse traversal from near the top must clear the sticky navigation too.
    await page.locator('[data-queue-play]').last().focus();
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); await visible(`대기열 역방향 ${i}`); }
  }
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(join(root, 'data/library', tracks[0].managedPath)), original);
  assert.deepEqual(await readFile(join(root, 'data/library', tracks[0].lyricsFilePath)), lrc);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ root, results, errors, originalsPreserved: true }, null, 2));
  console.log(JSON.stringify({ root, out, checks: results.length, errors, originalsPreserved: true }));
});
