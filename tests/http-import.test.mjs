import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syntheticFlac, playableFlac, playableOggOpus } from './fixtures.mjs';

// Run explicitly: RUN_HTTP_TESTS=1 npm test (needs a local listening socket).
test('이동 API: 외부 요청 차단, 명시적 확인, 음원·가사 소장 완료', { skip: !process.env.RUN_HTTP_TESTS }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-http-'));
  const source = join(root, 'source');
  await mkdir(source);
  const audio = join(source, 'Afterglow.flac'), lrc = join(source, 'Afterglow.lrc');
  await writeFile(audio, syntheticFlac()); await writeFile(lrc, '[00:01]test');
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '14317', SORISEOJAE_DATA_DIR: join(root, 'data') }, stdio: ['ignore','pipe','pipe'] });
  t.after(() => server.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('서버 시작 시간 초과')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timeout); resolve(); } });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`서버 종료 ${code}`)); });
    server.on('error', reject);
  });
  const url = 'http://127.0.0.1:14317';
  const state = await (await fetch(url + '/api/state')).json();
  const setting = (body, token = state.localToken, origin = url) => fetch(url + '/api/auto-import', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-local-token': token, Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await setting({ enabled: true }, 'invalid')).status, 403);
  assert.equal((await setting({ enabled: true }, state.localToken, 'https://example.com')).status, 403);
  assert.equal((await setting({ enabled: 'false' })).status, 400);
  assert.equal((await (await setting({ enabled: true })).json()).enabled, true);
  assert.equal((await (await setting({ enabled: false })).json()).enabled, false);
  assert.equal(JSON.parse(await readFile(join(root, 'data/auto-import.json'), 'utf8')).enabled, false);
  const post = (path, body, token = state.localToken, origin = url) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-local-token': token, Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post('/api/local-stage', { paths: [source] }, 'invalid')).status, 403);
  assert.equal((await post('/api/local-stage', { paths: [source] }, state.localToken, 'https://example.com')).status, 403);
  const response = await post('/api/local-stage', { paths: [source] });
  assert.equal(response.status, 200);
  const { selected } = await response.json();
  assert.equal(selected.length, 1);
  const importId = selected[0].staged.importId;
  assert.equal((await post('/api/local-commit', { importId })).status, 400);
  await access(audio); await access(lrc);
  const committed = await post('/api/local-commit', { importId, confirmMove: true });
  assert.equal(committed.status, 201);
  const result = await committed.json();
  assert.equal(result.moved.length, 2);
  assert.equal(result.moveWarnings.length, 0);
  const status = await (await fetch(`${url}/api/imports/${importId}`)).json();
  assert.equal(status.status, 'committed');
  assert.equal(status.track.id, result.id);
  const retryMove = await (await post('/api/local-commit', { importId, confirmMove: true })).json();
  assert.deepEqual(retryMove, result);
  await assert.rejects(access(audio)); await assert.rejects(access(lrc));
  assert.equal((await (await fetch(url + '/api/state')).json()).tracks.length, 1);
  assert.equal((await post('/api/interests', { title: 'unused' })).status, 404);

  const bytes = playableFlac({ title: '복사 검증', seconds: 1 });
  const copySource = join(source, 'copy.flac');
  await writeFile(copySource, bytes);
  const staged = await (await fetch(`${url}/api/stage`, { method: 'POST', headers: { 'x-file-name': 'copy.flac' }, body: bytes })).json();
  assert.equal((await (await fetch(`${url}/api/imports/${staged.importId}`)).json()).status, 'ready');
  const copyBody = { importId: staged.importId, metadata: { lrcText: '\uFEFF[00:00]복사 가사\r\n', lrcSourceName: 'copy.lrc' } };
  const copy = await (await post('/api/commit', copyBody)).json();
  assert.ok(copy.id);
  assert.deepEqual(await readFile(copySource), bytes);
  assert.deepEqual(await readFile(join(root, 'data/library', copy.managedPath)), bytes);
  assert.equal(await readFile(join(root, 'data/library', copy.lyricsFilePath), 'utf8'), copyBody.metadata.lrcText);
  assert.equal((await (await post('/api/commit', copyBody)).json()).id, copy.id);
  assert.equal((await (await fetch(url + '/api/state')).json()).tracks.length, 2);
  const recovered = await (await fetch(`${url}/api/imports/previous-session?checksum=${staged.checksum}`)).json();
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.track.id, copy.id);
  assert.equal((await (await fetch(`${url}/api/imports/not-present`)).json()).status, 'missing');
});

test('configured move inbox registers stable audio, exposes OGG playback, and removes only inbox copies', { skip: !process.env.RUN_HTTP_TESTS }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cove-inbox-http-'));
  const inbox = join(root, 'inbox'), data = join(root, 'data');
  await mkdir(inbox); await mkdir(data);
  await writeFile(join(data, 'auto-import.json'), JSON.stringify({ enabled: true, directory: inbox, mode: 'move' }));
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '14318', SORISEOJAE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill('SIGTERM'));
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error('Server did not start')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('프로토타입:')) { clearTimeout(timer); ok(); } });
    server.on('exit', code => { clearTimeout(timer); no(Error(`Server exit ${code}`)); });
    server.on('error', no);
  });
  const url = 'http://127.0.0.1:14318';
  const status = await (await fetch(url + '/api/auto-import')).json();
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'move');
  await writeFile(join(inbox, 'song.flac'), playableFlac({ title: 'Automatic song', seconds: .2 }));
  await writeFile(join(inbox, 'song.lrc'), '[00:00]Automatic lyric');
  const ogg = playableOggOpus();
  await writeFile(join(inbox, 'silence.ogg'), ogg);
  let tracks = [];
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    tracks = (await (await fetch(url + '/api/state')).json()).tracks;
    if (tracks.length === 2) break;
    await new Promise(ok => setTimeout(ok, 250));
  }
  assert.equal(tracks.length, 2);
  const oggTrack = tracks.find(track => track.format === 'OPUS');
  const response = await fetch(`${url}/api/tracks/${oggTrack.id}/audio`);
  assert.equal(response.headers.get('content-type'), 'audio/ogg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), ogg);
  const detail = await (await fetch(`${url}/api/tracks/${tracks.find(track => track.title === 'Automatic song').id}`)).json();
  assert.equal(detail.lyricsLrc, '[00:00]Automatic lyric');
  assert.equal((await (await fetch(url + '/api/auto-import')).json()).revision, 2);
  // Registration is observable before verified source cleanup finishes.
  const cleanupDeadline = Date.now() + 4000;
  while (Date.now() < cleanupDeadline) {
    try { await access(join(inbox, 'silence.ogg')); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    await new Promise(ok => setTimeout(ok, 100));
  }
  await assert.rejects(access(join(inbox, 'song.flac')), { code: 'ENOENT' });
  await assert.rejects(access(join(inbox, 'song.lrc')), { code: 'ENOENT' });
  await assert.rejects(access(join(inbox, 'silence.ogg')), { code: 'ENOENT' });
});
