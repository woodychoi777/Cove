import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MusicStore } from '../src/store.mjs';
import { MusicLibrary } from '../src/library.mjs';
import { playableFlac } from './fixtures.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cove-delete-'));
  const store = new MusicStore(join(root, 'db.sqlite'));
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store }); await library.init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  async function add(title) {
    const staged = await library.stage(Readable.from(playableFlac({ title, seconds: 1 })), `${title}.flac`);
    return library.commit(staged.importId, { lrcText: '[00:00]가사', lrcSourceName: 'lyrics.lrc' });
  }
  const a = await add('A'), b = await add('B');
  return { root, store, library, a, b, add, path: track => join(library.rootPath, track.managedPath) };
}
test('실제 음원 삭제, 기록·목록 정리, 다른 곡·가사 보존과 삭제 ID 재사용 방지', async t => {
  const { store, library, a, b, add, path } = await fixture(t);
  const before = await readFile(path(a));
  const playlist = store.createPlaylist('목록'); store.updatePlaylist(playlist.id, { revision: playlist.revision, trackIds: [a.id, b.id] });
  store.saveQueue({ name: '큐', trackIds: [a.id, b.id] });
  store.recordPlayback(b.id, 1000, true);
  store.db.prepare('INSERT INTO music_interests(title,artist,track_id) VALUES (?,?,?)').run('B','', b.id);
  assert.deepEqual(await library.deleteTrack(b.id), { deleted: true, cleanupPending: false });
  await assert.rejects(access(path(b)), { code: 'ENOENT' });
  assert.equal(store.getTrack(b.id), null);
  assert.deepEqual(await readFile(path(a)), before);
  await access(join(library.rootPath, b.lyricsFilePath));
  assert.deepEqual(store.getPlaylist(playlist.id).trackIds, [a.id]);
  assert.deepEqual(store.listQueues()[0].trackIds, [a.id]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM playback_events WHERE track_id=?').get(b.id).n, 0);
  assert.equal(store.db.prepare('SELECT track_id FROM music_interests').get().track_id, null);
  assert.equal(await library.deleteTrack(b.id), null);
  assert((await add('C')).id > b.id);
});
test('DB 삭제 실패 시 파일과 기록 복구, 외부 심볼릭 링크 거절', async t => {
  const { store, library, a, path, root } = await fixture(t);
  const before = await readFile(path(a));
  store.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT,'failure'); END;");
  await assert.rejects(library.deleteTrack(a.id), /failure/);
  assert(store.getTrack(a.id)); assert.deepEqual(await readFile(path(a)), before);
  store.db.exec('DROP TRIGGER fail_delete');
  const outside = join(root, 'original.flac'); await rename(path(a), outside); await symlink(outside, path(a));
  await assert.rejects(library.deleteTrack(a.id), /파일 경로/);
  assert(store.getTrack(a.id)); assert.deepEqual(await readFile(outside), before);
});
test('음원 파일이 이미 없는 곡도 컬렉션에서 삭제할 수 있다', async t => {
  const { library, store, a, path } = await fixture(t); await rm(path(a));
  assert.equal((await library.deleteTrack(a.id)).deleted, true); assert.equal(store.getTrack(a.id), null);
});
