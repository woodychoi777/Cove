import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MusicStore } from '../src/store.mjs';

function seed(store, title) {
  store.db.prepare("INSERT INTO artists(id,name) VALUES(1,'알 수 없는 아티스트')").run();
  store.db.prepare('INSERT INTO albums(id,artist_id,title,artwork_path) VALUES(1,1,?,?)').run(title, 'old-cover.jpg');
  for (const id of [1, 2]) {
    store.db.prepare('INSERT INTO tracks(id,album_id,artist_id,title,memory) VALUES(?,1,1,?,?)').run(id, `곡 ${id}`, '기억');
    store.db.prepare("INSERT INTO audio_files(track_id,managed_path,format,file_size,checksum_sha256) VALUES(?,?,'FLAC',1,?)").run(id, `${id}.flac`, `checksum-${id}`);
  }
}

test('앨범 미상·빈 앨범은 곡별 사진을 유지하고 다른 곡과 기존 표지를 보존한다', () => {
  for (const title of ['알 수 없는 앨범', '  알 수 없는 앨범  ', '', '   ']) {
    const store = new MusicStore(':memory:');
    try {
      seed(store, title);
      const before = store.getTrack(1);
      store.updateArtwork(1, 'first.jpg');
      store.updateArtwork(2, 'second.jpg');
      store.updateArtwork(1, 'first-replaced.jpg');
      assert.deepEqual(store.listTracks().map(t => t.artworkPath), ['second.jpg', 'first-replaced.jpg']);
      assert.equal(store.getTrack(1).artworkPath, 'first-replaced.jpg');
      assert.equal(store.getTrack(2).artworkPath, 'second.jpg');
      assert.equal(store.db.prepare('SELECT artwork_path FROM albums').get().artwork_path, 'old-cover.jpg');
      for (const key of ['title', 'albumId', 'artistId', 'memory', 'managedPath', 'checksum', 'durationMs']) assert.equal(store.getTrack(1)[key], before[key]);
      assert.equal(store.exportCollection().tracks.find(t => t.id === 2).artworkPath, 'second.jpg');
      assert.throws(() => store.updateArtwork(999, 'bad.jpg'), /곡을 찾을 수 없습니다/);
    } finally { store.close(); }
  }
});

test('기존 DB 마이그레이션 후 사진은 유지되고 이름 있는 앨범은 모든 곡에 반영된다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-track-artwork-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'store.sqlite');
  let store = new MusicStore(path);
  seed(store, 'Unknown Pleasures');
  store.db.exec('ALTER TABLE tracks DROP COLUMN artwork_path');
  store.close();
  store = new MusicStore(path);
  assert.equal(store.getTrack(1).artworkPath, 'old-cover.jpg');
  store.updateArtwork(1, 'album.jpg');
  assert.equal(store.getTrack(2).artworkPath, 'album.jpg');
  store.db.prepare('UPDATE albums SET title = ?').run('알 수 없는 앨범');
  store.updateArtwork(1, 'individual.jpg');
  store.close();
  store = new MusicStore(path);
  try {
    assert.equal(store.getTrack(1).artworkPath, 'individual.jpg');
    assert.equal(store.getTrack(2).artworkPath, 'album.jpg');
  } finally { store.close(); }
});
