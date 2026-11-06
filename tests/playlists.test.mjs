import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicStore } from '../src/store.mjs';

function fixture(t, file = ':memory:') {
  const store = new MusicStore(file); t.after(() => { try { store.close(); } catch {} });
  store.db.exec("INSERT INTO artists(id,name) VALUES(1,'검사'); INSERT INTO albums(id,artist_id,title) VALUES(1,1,'검사');");
  for (let id = 1; id <= 4; id++) {
    store.db.prepare('INSERT INTO tracks(id,album_id,artist_id,title,lyrics_original,lyrics_lrc,memory) VALUES(?,1,1,?,?,?,?)').run(id, id < 3 ? '같은 제목' : `검사 ${id}`, '[00:01]가사', '[00:01]원본', '개인 기록');
    store.db.prepare("INSERT INTO audio_files(track_id,managed_path,format,file_size,checksum_sha256,lossless) VALUES(?,?,'FLAC',1,?,1)").run(id, `${id}.flac`, String(id));
  }
  store.saveQueue({ name: '중복 큐', trackIds: [1, 2, 1] });
  return store;
}
const rejects = (action, code, status) => assert.throws(action, error => error.code === code && error.status === status);

test('플레이리스트 이름·빈 생성·같은 이름·NFC·공백·길이·ID 불변', t => {
  const s = fixture(t);
  for (const name of ['', '   ', 'x'.repeat(101), null]) rejects(() => s.createPlaylist(name), 'INVALID_NAME', 400);
  const a = s.createPlaylist('  새 플레이리스트  ');
  assert.equal(a.name, '새 플레이리스트'); assert.deepEqual(a.trackIds, []); assert.equal(a.revision, 1);
  rejects(() => s.createPlaylist('새 플레이리스트'), 'NAME_EXISTS', 409);
  s.createPlaylist('Cafe'); rejects(() => s.createPlaylist('CAFE'), 'NAME_EXISTS', 409);
  s.createPlaylist('한글'); rejects(() => s.createPlaylist('한글'.normalize('NFD')), 'NAME_EXISTS', 409);
  const renamed = s.updatePlaylist(a.id, { revision: a.revision, name: '새 이름' });
  assert.equal(renamed.id, a.id); assert.equal(renamed.revision, 2);
  rejects(() => s.updatePlaylist(a.id, { revision: 2, name: 'Cafe' }), 'NAME_EXISTS', 409);
  assert.equal(s.getPlaylist(a.id).name, '새 이름');
});

test('추가는 ID로 중복 방지·앞선 순서 보존·동일 제목 다른 곡 허용·원자적 실패', t => {
  const s = fixture(t); let a = s.createPlaylist('목록');
  a = s.updatePlaylist(a.id, { revision: a.revision, addTrackIds: [2, 1, 2] }); assert.deepEqual(a.trackIds, [2, 1]);
  a = s.updatePlaylist(a.id, { revision: a.revision, addTrackIds: [3, 1, 4] }); assert.deepEqual(a.trackIds, [2, 1, 3, 4]);
  for (const body of [{ addTrackIds: [999] }, { trackIds: [1, 1] }, { trackIds: null }, { addTrackIds: ['1'] }, { addTrackIds: [1], trackIds: [] }]) {
    assert.throws(() => s.updatePlaylist(a.id, { revision: a.revision, name: '잘못된 갱신', ...body })); assert.deepEqual(s.getPlaylist(a.id), a);
  }
  const plan = s.db.prepare('EXPLAIN QUERY PLAN SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position').all(a.id);
  assert.ok(plan.some(row => /INDEX/.test(row.detail))); assert.ok(!plan.some(row => /TEMP B-TREE/.test(row.detail)));
});

test('순서·빼기·삭제는 원본/가사/기록/중복 저장큐와 독립적', t => {
  const s = fixture(t), before = s.exportCollection(); let a = s.createPlaylist('목록');
  a = s.updatePlaylist(a.id, { revision: a.revision, addTrackIds: [1, 2, 3] });
  a = s.updatePlaylist(a.id, { revision: a.revision, trackIds: [3, 1] }); assert.deepEqual(a.trackIds, [3, 1]);
  s.updateTitle(1, '바뀐 곡명'); assert.deepEqual(s.getPlaylist(a.id).trackIds, [3, 1]); s.updateTitle(1, before.tracks.find(t => t.id === 1).title);
  const next = s.createPlaylist('다른 목록'); s.updatePlaylist(next.id, { revision: next.revision, addTrackIds: [1] });
  s.deletePlaylist(a.id, a.revision); rejects(() => s.getPlaylist(a.id), 'NOT_FOUND', 404);
  assert.deepEqual(s.exportCollection().tracks.map(({updated_at,...row})=>row), before.tracks.map(({updated_at,...row})=>row));
  assert.deepEqual(s.listQueues(), before.queues); assert.deepEqual(s.getPlaylist(next.id).trackIds, [1]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlist_id=?').get(a.id).count, 0);
  const newer = s.createPlaylist('목록'); assert.notEqual(newer.id, a.id);
});

test('수정/삭제의 오래된 revision과 누락 ID를 구별하고 충돌은 현재값을 반환한다', t => {
  const s = fixture(t); const a = s.createPlaylist('목록'), b = s.updatePlaylist(a.id, { revision: a.revision, addTrackIds: [2] });
  for (const action of [() => s.updatePlaylist(a.id, { revision: a.revision, trackIds: [1] }), () => s.deletePlaylist(a.id, a.revision)]) {
    assert.throws(action, error => error.status === 409 && error.code === 'REVISION_CONFLICT' && error.current.revision === b.revision);
    assert.deepEqual(s.getPlaylist(a.id), b);
  }
  s.deletePlaylist(a.id, b.revision);
  rejects(() => s.updatePlaylist(a.id, { revision: b.revision, trackIds: [] }), 'NOT_FOUND', 404);
  rejects(() => s.deletePlaylist(a.id, b.revision), 'NOT_FOUND', 404);
});

test('파일 접근 실패는 목록 연결을 지우지 않고 전체/빈 순서도 영구 저장한다', t => {
  const s = fixture(t); let a = s.createPlaylist('목록');
  a = s.updatePlaylist(a.id, { revision: 1, trackIds: [4, 1] });
  s.db.prepare("UPDATE audio_files SET availability='missing' WHERE track_id=4").run();
  assert.deepEqual(s.getPlaylist(a.id).trackIds, [4, 1]);
  a = s.updatePlaylist(a.id, { revision: a.revision, trackIds: [] }); assert.deepEqual(a.trackIds, []);
});

test('기존 DB 추가 마이그레이션·재시작·내보내기 v2는 기존 tracks/queues와 순서를 보존한다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cove-playlists-'));
  let s;
  t.after(async () => {
    if (s?.db.isOpen) s.close();
    await rm(root, { recursive: true, force: true });
  });
  s = fixture(t, join(root, 'store.sqlite'));
  const original = s.exportCollection();
  // Simulate the previous schema with its existing records and queues.
  s.db.exec('DROP TABLE playlist_tracks; DROP TABLE playlists;'); s.close();
  s = new MusicStore(join(root, 'store.sqlite'));
  assert.deepEqual(s.exportCollection().tracks, original.tracks); assert.deepEqual(s.listQueues(), original.queues);
  const a = s.createPlaylist('보존 목록'); const saved = s.updatePlaylist(a.id, { revision: 1, trackIds: [3, 1, 2] }); s.close();
  s = new MusicStore(join(root, 'store.sqlite'));
  assert.deepEqual(s.getPlaylist(a.id), saved);
  const exported = s.exportCollection(); assert.equal(exported.schemaVersion, 2); assert.deepEqual(exported.playlists, [saved]); assert.deepEqual(exported.queues[0].trackIds, [1, 2, 1]);
});
