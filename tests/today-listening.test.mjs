import test from 'node:test';
import assert from 'node:assert/strict';
import { rediscover } from '../public/listening.js';
import { longTrackLabel } from '../public/metadata-display.js';
import { MusicStore } from '../src/store.mjs';
const now=Date.parse('2026-10-23T12:00:00Z'),day=86400000,stamp=days=>new Date(now-days*day).toISOString(),ids=rows=>rediscover(rows,now).map(t=>t.id);
test('재발견: 전체 소장곡의90일 경계·UTC/오프셋·기존 체크 무관·최대2곡',()=>{
 const rows=[{id:8,lastPlayedAt:stamp(89),isLifeSong:true},{id:3,lastPlayedAt:stamp(90),isLifeSong:false},{id:2,lastPlayedAt:stamp(91),isLifeSong:false},{id:1,lastPlayedAt:stamp(91),isLifeSong:true}];
 const saved=structuredClone(rows);assert.deepEqual(ids(rows),[1,2]);assert.deepEqual(rows,saved);
 assert.deepEqual(ids(rows.slice(0,2)),[3]);assert.deepEqual(ids(rows.slice(0,1)),[]);assert.deepEqual(ids([]),[]);
 assert.deepEqual(ids([{id:1,lastPlayedAt:'2026-07-25 12:00:00'},{id:2,lastPlayedAt:'2026-07-25T21:00:00+09:00'},{id:3,lastPlayedAt:'2026-07-25T12:00:00.001Z'}]),[1,2]);
});
test('재발견: 미감상 소장일90일·실제 감상 우선·날짜 누락/오류 제외',()=>{
 assert.deepEqual(ids([{id:1,createdAt:stamp(91),lastPlayedAt:null},{id:2,createdAt:stamp(90),lastPlayedAt:''},{id:3,createdAt:stamp(89)},{id:4,createdAt:stamp(0)},{id:5,createdAt:stamp(200),lastPlayedAt:stamp(1)}]),[1,2]);
 for(const bad of[null,undefined,'','nonsense','2026-02-30 00:00:00','2026-13-01 00:00:00','2026-01-01T24:00:00Z','2026-01-01T00:61:00Z',123])assert.deepEqual(ids([{id:1,createdAt:bad}]),[]);
 assert.deepEqual(ids([{id:1,lastPlayedAt:'bad',createdAt:stamp(200)}]),[]);
});
test('컬렉션 긴 음원:10분 경계·시 단위·누락/음수/무한·제목과 분리',()=>{
 for(const value of[null,undefined,0,-1,599999,NaN,Infinity,'600000'])assert.equal(longTrackLabel(value),'');
 assert.equal(longTrackLabel(600000),'긴 음악');assert.equal(longTrackLabel(754999),'긴 음악');assert.equal(longTrackLabel(5025000),'긴 음악');
});
test('소장일 별칭은 기존 데이터·체크·기록을 바꾸지 않고 제공한다',t=>{
 const store=new MusicStore(':memory:');t.after(()=>store.db.close());
 store.db.exec("INSERT INTO artists(id,name) VALUES(1,'가수'); INSERT INTO albums(id,artist_id,title) VALUES(1,1,'앨범'); INSERT INTO tracks(id,album_id,artist_id,title,created_at,is_life_song,memory) VALUES(1,1,1,'곡','2026-01-01 00:00:00',0,'보존'); INSERT INTO audio_files(track_id,managed_path,format,file_size,checksum_sha256) VALUES(1,'test.flac','FLAC',1,'x')");
 const before=store.db.prepare('SELECT * FROM tracks').all(),rows=store.listTracks();assert.equal(rows[0].createdAt,'2026-01-01 00:00:00');assert.deepEqual(ids(rows),[1]);assert.deepEqual(store.db.prepare('SELECT * FROM tracks').all(),before);
});

