import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicStore } from '../src/store.mjs';
import { MusicLibrary } from '../src/library.mjs';
import { AutoImportInbox, AutoImportControl } from '../src/auto-import.mjs';
import { playableFlac, playableOggOpus, syntheticFlac } from './fixtures.mjs';

async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cove-inbox-'));
  const store = new MusicStore(join(root, 'test.sqlite'));
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store });
  await library.init();
  let now = 1000;
  const options = { library, directory: join(root, 'inbox'), statePath: join(root, 'history.json'), settleMs: 100, now: () => now, ...overrides };
  const inbox = new AutoImportInbox(options);
  await inbox.init();
  t.after(async () => { await inbox.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, library, inbox, options, advance: (milliseconds = 101) => { now += milliseconds; } };
}

test('inbox waits for stable files, imports nested FLAC+LRC+cover, and retains originals', async t => {
  const f = await setup(t);
  const album = join(f.inbox.directory, 'Artist', 'Album');
  await mkdir(album, { recursive: true });
  const path = join(album, 'song.flac'), lrc = join(album, 'song.lrc');
  const audio = syntheticFlac();
  await writeFile(path, audio);
  await writeFile(lrc, '[00:00.00]A lyric');
  await f.inbox.scan();
  assert.equal(f.store.listTracks().length, 0);
  f.advance(); await f.inbox.scan();
  const track = f.store.getTrack(f.store.listTracks()[0].id);
  assert.equal(track.title, 'Afterglow');
  assert.ok(track.artworkPath);
  assert.equal(track.lyricsLrc, '[00:00.00]A lyric');
  assert.deepEqual(await readFile(path), audio);
  assert.deepEqual(await readFile(f.library.resolveManagedPath(track.managedPath)), audio);
  assert.equal(await readFile(f.library.resolveManagedPath(track.lyricsFilePath), 'utf8'), '[00:00.00]A lyric');
  await f.inbox.scan();
  assert.equal(f.store.listTracks().length, 1);
});

test('inbox survives restart and suppresses a second copy with the same checksum', async t => {
  const f = await setup(t);
  const audio = playableFlac({ seconds: .2 });
  await writeFile(join(f.inbox.directory, 'one.flac'), audio);
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  const restarted = new AutoImportInbox(f.options);
  await restarted.init();
  assert.equal(restarted.status().importedFiles, 1);
  await writeFile(join(f.inbox.directory, 'two.flac'), audio);
  await restarted.scan(); f.advance(); await restarted.scan();
  assert.equal(f.store.listTracks().length, 1);
  assert.equal(restarted.status().importedFiles, 2);
  await restarted.stop();
});

test('OGG stays OGG and its audio bytes are preserved', async t => {
  const f = await setup(t);
  const audio = playableOggOpus();
  await writeFile(join(f.inbox.directory, 'Silence.ogg'), audio);
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.inbox.status().error, '');
  const track = f.store.getTrack(f.store.listTracks()[0].id);
  assert.equal(track.format, 'OPUS');
  assert.ok(track.managedPath.endsWith('.ogg'));
  assert.deepEqual(await readFile(f.library.resolveManagedPath(track.managedPath)), audio);
});

test('late lyrics attach once and never replace user edits, favorites or comments', async t => {
  const f = await setup(t);
  await writeFile(join(f.inbox.directory, 'song.flac'), playableFlac({ seconds: .2 }));
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  const id = f.store.listTracks()[0].id;
  f.store.updateComments(id, 'keep my comment');
  f.store.updateFavorite(id, true);
  await writeFile(join(f.inbox.directory, 'song.lrc'), '[00:00]Late lyric');
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.store.getTrack(id).lyricsLrc, '[00:00]Late lyric');
  assert.equal(f.store.getTrack(id).memory, 'keep my comment');
  assert.equal(f.store.getTrack(id).isLifeSong, true);
  f.store.updateInfo(id, { lyricsOriginal: 'My edited lyric' });
  await writeFile(join(f.inbox.directory, 'song.lrc'), '[00:00]Replacement');
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.store.getTrack(id).lyricsOriginal, 'My edited lyric');
});

test('changing/partial files settle again; links and encrypted inputs are ignored; errors retry after change', async t => {
  const f = await setup(t);
  const path = join(f.inbox.directory, 'song.flac');
  const audio = playableFlac({ seconds: .2 });
  await writeFile(path, audio.subarray(0, 8));
  await f.inbox.scan(); f.advance();
  await writeFile(path, audio);
  await f.inbox.scan();
  assert.equal(f.store.listTracks().length, 0);
  f.advance(); await f.inbox.scan();
  await symlink(path, join(f.inbox.directory, 'link.flac'));
  await writeFile(join(f.inbox.directory, 'encrypted.mflac'), audio);
  await writeFile(join(f.inbox.directory, 'bad.flac'), 'broken audio');
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.store.listTracks().length, 1);
  assert.match(f.inbox.status().error, /bad.flac/);
  assert.deepEqual(await readdir(f.library.incomingPath), []);
  await writeFile(join(f.inbox.directory, 'bad.flac'), playableFlac({ title: 'Recovered', seconds: .2 }));
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.store.listTracks().length, 2);
});

test('inbox rejects managed library roots and directory aliases', async t => {
  const f = await setup(t);
  const nested = new AutoImportInbox({ ...f.options, directory: join(f.library.rootPath, 'inbox') });
  await assert.rejects(nested.init(), /전용 폴더/);
  const alias = join(f.root, 'alias');
  await symlink(f.inbox.directory, alias);
  await assert.rejects(new AutoImportInbox({ ...f.options, directory: alias }).init(), /실제 폴더/);
});

test('move mode removes audio and BOM/CRLF LRC only after registration and byte verification', async t => {
  const f = await setup(t, { mode: 'move' });
  const path = join(f.inbox.directory, 'song.flac'), lrc = join(f.inbox.directory, 'song.lrc');
  const audio = syntheticFlac(), lyrics = Buffer.from('\uFEFF[00:00]Moving lyric\r\n');
  await writeFile(path, audio); await writeFile(lrc, lyrics);
  await f.inbox.scan();
  assert.deepEqual(await readFile(path), audio);
  f.advance(); await f.inbox.scan();
  assert.equal(f.inbox.status().error, '');
  assert.equal(f.inbox.status().mode, 'move');
  const track = f.store.getTrack(f.store.listTracks()[0].id);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await assert.rejects(readFile(lrc), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.library.resolveManagedPath(track.managedPath)), audio);
  assert.deepEqual(await readFile(f.library.resolveManagedPath(track.lyricsFilePath)), lyrics);
  assert.ok(track.artworkPath);
});

test('move mode cleans historical copies and duplicate audio after restart without adding tracks', async t => {
  const f = await setup(t);
  const audio = playableFlac({ seconds: .2 });
  await writeFile(join(f.inbox.directory, 'original.flac'), audio);
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  const restarted = new AutoImportInbox({ ...f.options, mode: 'move' });
  await restarted.init();
  await writeFile(join(f.inbox.directory, 'duplicate.flac'), audio);
  await restarted.scan(); f.advance(); await restarted.scan();
  assert.equal(restarted.status().error, '');
  assert.deepEqual(await readdir(restarted.directory), []);
  assert.equal(f.store.listTracks().length, 1);
  await restarted.stop();
});

test('LRC arriving after audio moved is attached and moved; conflicting edited lyrics remain intact', async t => {
  const f = await setup(t, { mode: 'move' });
  const path = join(f.inbox.directory, 'song.flac'), lrc = join(f.inbox.directory, 'song.lrc');
  await writeFile(path, playableFlac({ seconds: .2 }));
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const id = f.store.listTracks()[0].id;
  const lyrics = Buffer.from('\uFEFF[00:00]Late moving lyric\r\n');
  await writeFile(lrc, lyrics);
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.inbox.status().error, '');
  await assert.rejects(readFile(lrc), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.library.resolveManagedPath(f.store.getTrack(id).lyricsFilePath)), lyrics);
  f.store.updateInfo(id, { lyricsOriginal: 'My edit' });
  await writeFile(lrc, '[00:00]Different lyrics');
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.store.getTrack(id).lyricsOriginal, 'My edit');
  assert.equal(await readFile(lrc, 'utf8'), '[00:00]Different lyrics');
  assert.ok(f.inbox.status().error);
});

test('failed database commit keeps source audio and lyrics', async t => {
  const f = await setup(t, { mode: 'move' });
  const path = join(f.inbox.directory, 'song.flac'), lrc = join(f.inbox.directory, 'song.lrc');
  const audio = playableFlac({ seconds: .2 });
  await writeFile(path, audio); await writeFile(lrc, '[00:00]Keep');
  f.library.commit = async () => { throw Error('simulated commit failure'); };
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.equal(f.store.listTracks().length, 0);
  assert.deepEqual(await readFile(path), audio);
  assert.equal(await readFile(lrc, 'utf8'), '[00:00]Keep');
  assert.deepEqual(await readdir(f.library.incomingPath), []);
});

test('source changed during commit is preserved; managed corruption cannot delete the good source', async t => {
  for (const defect of ['source-change', 'managed-corruption']) {
    const f = await setup(t, { mode: 'move' });
    const path = join(f.inbox.directory, 'song.flac'), audio = playableFlac({ seconds: .2 });
    await writeFile(path, audio);
    const commit = f.library.commit.bind(f.library);
    f.library.commit = async (...args) => {
      const track = await commit(...args);
      if (defect === 'source-change') await writeFile(path, Buffer.concat([audio, Buffer.from([1])]));
      else await writeFile(f.library.resolveManagedPath(track.managedPath), 'corrupt');
      return track;
    };
    await f.inbox.scan(); f.advance(); await f.inbox.scan();
    assert.ok(f.inbox.status().error);
    assert.deepEqual(await readFile(path), defect === 'source-change' ? Buffer.concat([audio, Buffer.from([1])]) : audio);
  }
});

test('failed recovery-state write preserves input and can retry without duplicating the committed track', async t => {
  const f = await setup(t, { mode: 'move' });
  const path = join(f.inbox.directory, 'song.flac'), audio = playableFlac({ seconds: .2 });
  await writeFile(path, audio);
  const persist = f.inbox.persist.bind(f.inbox);
  f.inbox.persist = async () => { throw Error('simulated full disk'); };
  await f.inbox.scan(); f.advance(); await f.inbox.scan();
  assert.deepEqual(await readFile(path), audio);
  assert.equal(f.store.listTracks().length, 1);
  f.inbox.persist = persist;
  f.advance(60001); await f.inbox.scan();
  assert.equal(f.inbox.status().error, '');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.equal(f.store.listTracks().length, 1);
});

test('disabled configuration does not access the inbox; off/on persists folder and move mode', async t => {
  const f = await setup(t);
  const path = join(f.root, 'auto-import.json');
  const config = { enabled: false, directory: f.inbox.directory, mode: 'move' };
  await writeFile(path, JSON.stringify(config));
  const moved = f.inbox.directory + '-unavailable';
  await rename(f.inbox.directory, moved);
  const control = new AutoImportControl({ library: f.library, dataRoot: f.root, inboxOptions: { intervalMs: 10, settleMs: 10 } });
  t.after(() => control.stop());
  await control.init();
  assert.equal(control.status().enabled, false);
  assert.equal(control.inbox, null);
  await rename(moved, f.inbox.directory);
  await control.setEnabled(true);
  assert.equal(control.status().enabled, true);
  await control.setEnabled(false);
  assert.equal(control.inbox, null);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
  const restarted = new AutoImportControl({ library: f.library, dataRoot: f.root });
  await restarted.init();
  assert.equal(restarted.status().enabled, false);
  await restarted.stop();
});

test('turning off finishes the current import, leaves queued audio untouched and imports it when enabled again', async t => {
  const f = await setup(t);
  await writeFile(join(f.root, 'auto-import.json'), JSON.stringify({ enabled: false, directory: f.inbox.directory, mode: 'move' }));
  const one = join(f.inbox.directory, 'one.flac'), two = join(f.inbox.directory, 'two.flac');
  await writeFile(one, playableFlac({ title: 'One', seconds: .2 }));
  await writeFile(two, playableFlac({ title: 'Two', seconds: .2 }));
  const control = new AutoImportControl({ library: f.library, dataRoot: f.root, inboxOptions: { intervalMs: 10, settleMs: 10 } });
  await control.init();
  t.after(() => control.stop());
  const commit = f.library.commit.bind(f.library);
  let release, started;
  const gate = new Promise(ok => { release = ok; });
  const importing = new Promise(ok => { started = ok; });
  f.library.commit = async (...args) => { started(); await gate; return commit(...args); };
  await control.setEnabled(true);
  await Promise.race([importing, new Promise((_, no) => setTimeout(() => no(Error('Import did not start')), 2000).unref())]);
  const off = control.setEnabled(false);
  while (JSON.parse(await readFile(join(f.root, 'auto-import.json'), 'utf8')).enabled) await new Promise(ok => setTimeout(ok, 5));
  release(); await off;
  assert.equal(f.store.listTracks().length, 1);
  await readFile(two);
  await new Promise(ok => setTimeout(ok, 50));
  assert.equal(f.store.listTracks().length, 1);
  f.library.commit = commit;
  await control.setEnabled(true);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && f.store.listTracks().length < 2) await new Promise(ok => setTimeout(ok, 10));
  assert.equal(f.store.listTracks().length, 2);
  await control.setEnabled(false);
});

test('a failed preference write leaves the previous watcher active and can be retried', async t => {
  const f = await setup(t);
  await writeFile(join(f.root, 'auto-import.json'), JSON.stringify({ enabled: true, directory: f.inbox.directory, mode: 'move' }));
  const control = new AutoImportControl({ library: f.library, dataRoot: f.root });
  await control.init(); t.after(() => control.stop());
  await mkdir(join(f.root, 'auto-import.json.tmp'));
  await assert.rejects(control.setEnabled(false));
  assert.equal(control.status().enabled, true);
  assert.equal(control.inbox.stopping, false);
  await rm(join(f.root, 'auto-import.json.tmp'), { recursive: true });
  await control.setEnabled(false);
  assert.equal(control.status().enabled, false);
});

test('folder preview and switching preserve the old config on validation/write failure', async t => {
  const f = await setup(t);
  const control = new AutoImportControl({ library: f.library, dataRoot: f.root });
  t.after(() => control.stop()); await control.init();
  const nested = join(f.inbox.directory, '가수', '앨범'); await mkdir(nested, { recursive: true });
  const audio = playableFlac({ seconds: .2 }); await writeFile(join(nested, '곡.flac'), audio);
  const preview = await control.preview(f.inbox.directory);
  assert.equal(preview.fileCount, 1); assert.equal(preview.totalBytes, audio.length);
  await control.configure({ directory: f.inbox.directory, enabled: true, mode: 'copy' });
  const before = await readFile(join(f.root, 'auto-import.json'), 'utf8');
  await assert.rejects(control.configure({ directory: f.library.rootPath, enabled: true }));
  assert.equal(await readFile(join(f.root, 'auto-import.json'), 'utf8'), before);
  const other = join(f.root, 'other'); await mkdir(other);
  await mkdir(join(f.root, 'auto-import.json.tmp'));
  await assert.rejects(control.configure({ directory: other, enabled: true }));
  assert.equal(control.inbox.stopping, false);
  assert.equal(control.status().directory, f.inbox.directory);
  await rm(join(f.root, 'auto-import.json.tmp'), { recursive: true });
  await control.configure({ directory: other, enabled: true });
  assert.equal(control.status().directory, await realpath(other));
});

test('missing configured folder is never recreated and resumes after reconnect/retry', async t => {
  const f = await setup(t);
  await writeFile(join(f.root, 'auto-import.json'), JSON.stringify({ enabled: true, directory: f.inbox.directory, mode: 'copy' }));
  const away = f.inbox.directory + '-away'; await rename(f.inbox.directory, away);
  const { openAutoImportInbox } = await import('../src/auto-import.mjs');
  const control = await openAutoImportInbox({ library: f.library, dataRoot: f.root });
  t.after(() => control.stop());
  assert(control.status().error); await assert.rejects(readFile(f.inbox.directory), { code: 'ENOENT' });
  await rename(away, f.inbox.directory); await control.retryFailed();
  assert.equal(control.status().error, ''); assert(control.inbox);
});

test('bad LRC does not block audio; move mode retains both originals until lyrics are safe', async t => {
  for (const mode of ['copy', 'move']) {
    const f = await setup(t, { mode });
    const audio = playableFlac({ seconds: .2 });
    const path = join(f.inbox.directory, 'bad-가사.flac'), lyric = join(f.inbox.directory, 'bad-가사.lrc');
    await writeFile(path, audio); await writeFile(lyric, Buffer.from([0xff, 0xfe, 0xfd]));
    await f.inbox.scan(); f.advance(); await f.inbox.scan();
    assert.equal(f.store.listTracks().length, 1);
    assert.deepEqual(await readFile(path), audio); await readFile(lyric);
    assert.equal(f.inbox.status().recentResults[0].status, 'partial');
    if (mode === 'move') assert.match(f.inbox.status().error, /이동 미완료/);
    await writeFile(lyric, '[00:00]수정된 가사');
    await f.inbox.scan(); f.advance(); await f.inbox.scan();
    assert.equal(f.store.listTracks().length, 1); assert.equal(f.inbox.status().error, '');
    assert.match(f.store.getTrack(f.store.listTracks()[0].id).lyricsOriginal, /수정된 가사/);
    if (mode === 'move') await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});

test('unsupported input is visible and stable scans do not rewrite history', async t => {
  const f = await setup(t); await writeFile(join(f.inbox.directory, 'song.wav'), 'unsupported');
  await f.inbox.scan(); assert.equal(f.inbox.status().summary.unsupported, 1);
  let writes = 0; const persist = f.inbox.persist.bind(f.inbox);
  f.inbox.persist = async () => { writes++; return persist(); };
  await f.inbox.scan(); await f.inbox.scan(); assert.equal(writes, 0);
});
