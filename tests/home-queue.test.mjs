import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicStore } from '../src/store.mjs';

function fixture(t, count = 14) {
  const store = new MusicStore(':memory:'); t.after(() => store.db.close());
  store.db.exec("INSERT INTO artists(id,name) VALUES(1,'검사'); INSERT INTO albums(id,artist_id,title) VALUES(1,1,'검사 앨범');");
  for(let id=1;id<=count;id++) {
    store.db.prepare('INSERT INTO tracks(id,album_id,artist_id,title,duration_ms,play_count) VALUES(?,1,1,?,240000,999)').run(id,`검사 ${id}`);
    store.db.prepare("INSERT INTO audio_files(track_id,managed_path,format,file_size,checksum_sha256) VALUES(?,?,'FLAC',1,?)").run(id,`${id}.flac`,String(id));
  }
  const event=(id,at,ms=30000,completed=0)=>store.db.prepare('INSERT INTO playback_events(track_id,created_at,listened_ms,completed) VALUES(?,?,?,?)').run(id,at,ms,completed);
  return {store,event};
}
const now=Date.parse('2026-10-23T12:34:56.789Z'),stamp=ms=>new Date(ms).toISOString(),day=86400000;

test('최근7일: 누적 playCount/소장순으로 대체하지 않고 빈 기록을 반환한다',t=>{
  const {store}=fixture(t); assert.deepEqual(store.recentListening(now),[]);
});
test('최근7일: UTC 경계·미래·짧은/홀수 길이·미달 완청·서재 없는 곡 제외',t=>{
  const {store,event}=fixture(t);
  const cutoff=now-7*day;
  event(7,stamp(now-8*day)); event(7,stamp(now-29*day));
  event(1,stamp(cutoff)); event(1,stamp(cutoff-1)); event(1,stamp(cutoff+1)); event(1,stamp(now)); event(1,stamp(now+1));
  event(2,stamp(now-1),29999,1);
  store.db.prepare('UPDATE tracks SET duration_ms=20000 WHERE id=3').run(); event(3,stamp(now),10000);event(3,stamp(now),9999,1);
  store.db.prepare('UPDATE tracks SET duration_ms=20001 WHERE id=4').run(); event(4,stamp(now),10000);event(4,stamp(now),10001);
  event(5,'2026-10-23 12:34:56',30000); // Legacy SQLite timestamp is also UTC.
  store.db.prepare('DELETE FROM audio_files WHERE track_id=6').run();event(6,stamp(now));
  store.db.exec('PRAGMA foreign_keys=OFF');event(999,stamp(now));store.db.exec('PRAGMA foreign_keys=ON');
  const before=store.db.prepare('SELECT * FROM playback_events').all();
  assert.deepEqual(store.recentListening(now).map(r=>[r.id,r.segmentCount]),[[1,3],[3,1],[4,1],[5,1]]);
  assert.deepEqual(store.db.prepare('SELECT * FROM playback_events').all(),before);
});
test('최근7일: 구간 수→최근 유효시각→ID 동률 순서, 최대10개, UTC 오프셋 비교',t=>{
  const {store,event}=fixture(t);
  for(let id=1;id<=14;id++)event(id,stamp(now-day));
  event(12,stamp(now-2*day));event(13,stamp(now-3*day)); // 12/13 have more segments, even without completion.
  event(1,'2026-10-23T20:00:00+09:00',1); // Invalid newest event must not break a tie.
  event(14,'2026-10-23T20:00:00+09:00');
  const rows=store.recentListening(now);
  assert.deepEqual(rows.map(r=>r.id),[14,12,13,1,2,3,4,5,6,7]); assert.equal(rows[0].segmentCount,2);
  // The query reads existing tables only; no new schema or history write.
  const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT e.track_id FROM playback_events e JOIN tracks t ON t.id=e.track_id WHERE julianday(e.created_at)>=julianday(?) GROUP BY e.track_id').all(stamp(now-7*day));
  assert.ok(plan.some(row=>row.detail.includes('SCAN e')));
});
