import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicStore } from '../src/store.mjs';
import { MusicLibrary } from '../src/library.mjs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { playableFlac } from './fixtures.mjs';

function seed(store) {
  store.db.exec("INSERT INTO artists(id,name) VALUES(1,'공유 가수'); INSERT INTO albums(id,artist_id,title) VALUES(1,1,'공유 앨범')");
  for (const id of [1, 2]) {
    store.db.prepare('INSERT INTO tracks(id,album_id,artist_id,title,memory,is_life_song,lyrics_original) VALUES(?,1,1,?,?,1,?)').run(id, `곡 ${id}`, '기록 보존', '[00:00]원문');
    store.db.prepare("INSERT INTO audio_files(track_id,managed_path,format,file_size,checksum_sha256) VALUES(?,?,'FLAC',1,?)").run(id, `${id}.flac`, `hash-${id}`);
  }
}
test('통합 편집은 선택 곡의 가수만 변경하고 원본 경로·앨범·다른 곡·기록을 보존한다', t => {
  const store = new MusicStore(':memory:'); t.after(() => store.close()); seed(store);
  const sibling = store.getTrack(2), before = store.getTrack(1);
  const after = store.updateInfo(1, { title: ' 새 제목 ', artist: ' 새 가수 ', lyricsOriginal: '[00:00]새 가사', lyricsTranslation: '번역' });
  assert.equal(after.title, '새 제목'); assert.equal(after.artist, '새 가수');
  assert.equal(after.lyricsOriginal, '[00:00]새 가사'); assert.equal(after.lyricsTranslation, '번역');
  for (const key of ['managedPath', 'checksum', 'albumId', 'memory', 'isLifeSong', 'lyricsFilePath']) assert.equal(after[key], before[key]);
  assert.deepEqual(store.getTrack(2), sibling);
  assert.equal(store.db.prepare('SELECT name FROM artists WHERE id=1').get().name, '공유 가수');
  assert.equal(store.updateInfo(1, { artist: '' }).artist, '');
  assert.equal(store.updateInfo(1, { artist: '공유 가수' }).artistId, sibling.artistId);
  assert.equal(store.updateInfo(999, { title: '없음' }), null);
});
test('통합 편집은 검증 실패·DB 오류 시 제목/가사/가수와 앨범 사진을 모두 보존한다', t => {
  const store = new MusicStore(':memory:'); t.after(() => store.close()); seed(store);
  const before = store.exportCollection();
  for (const changes of [{ title: '' }, { artist: 3 }, { title: 'x'.repeat(301) }, { lyricsOriginal: null }, null, []]) assert.throws(() => store.updateInfo(1, changes, 'new.png'));
  store.db.exec("CREATE TRIGGER reject_artist BEFORE UPDATE OF artist_id ON tracks BEGIN SELECT RAISE(ABORT,'검사 실패'); END;");
  assert.throws(() => store.updateInfo(1, { title: '실패 제목', artist: '실패 가수', lyricsOriginal: '실패 가사' }, 'new.png'), /검사 실패/);
  assert.deepEqual(store.exportCollection().tracks, before.tracks);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM artists WHERE name='실패 가수'").get().count, 0);
});
test('사진은 통합 저장 때만 적용하며 잘못된 정보면 새 이미지 파일도 정리한다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cove-info-'));
  const store = new MusicStore(join(root, 'store.sqlite')); t.after(() => store.close());
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store }); await library.init();
  const bytes = playableFlac({ seconds: 1 }), staged = await library.stage(Readable.from(bytes), 'original.flac');
  const track = await library.commit(staged.importId, { lrcText: '[00:00]원본', lrcSourceName: 'original.lrc' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const files = await readdir(library.rootPath, { recursive: true });
  await assert.rejects(library.saveTrackInfo(track.id, { changes: { title: '' }, artwork: png.toString('base64') }));
  assert.deepEqual(await readdir(library.rootPath, { recursive: true }), files);
  for (const artwork of ['!!!!', 'dGVzdA==', null]) await assert.rejects(library.saveTrackInfo(track.id, { changes: { title: '실패' }, artwork }));
  assert.equal(store.getTrack(track.id).title, track.title);
  const after = await library.saveTrackInfo(track.id, { changes: { artist: '새 가수' }, artwork: png.toString('base64') });
  assert.equal(after.artist, '새 가수'); assert(after.artworkPath);
  assert.deepEqual(await readFile(join(library.rootPath, after.artworkPath)), png);
  assert.deepEqual(await readFile(join(library.rootPath, after.managedPath)), bytes);
  assert.equal(await readFile(join(library.rootPath, after.lyricsFilePath), 'utf8'), '[00:00]원본');
});
