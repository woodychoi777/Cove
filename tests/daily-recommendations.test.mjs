import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDailyRecommendations, createDailyRecommendations, localDateKey, DAILY_RECOMMENDATIONS_KEY } from '../public/daily-recommendations.js';
const day = 86400000, now = new Date(2026, 9, 24, 12).getTime();
const song = (id, days = 100, favorite = true) => ({ id, isLifeSong: favorite, createdAt: new Date(now - days * day).toISOString() });
const select = (tracks, prior = null, options = {}) => selectDailyRecommendations(tracks, prior, { now, random: () => 0, ...options });
const memory = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };

test('오래 안 들은 곡이 없으면 최애곡만 최대4곡, 한 곡이라도 있으면 기존2곡을 유지한다', () => {
  for (let count = 0; count <= 6; count++) {
    const tracks = Array.from({ length: count }, (_, i) => song(i + 1, 1));
    const before = structuredClone(tracks), result = select([...tracks, song(99, 1, false)]);
    assert.equal(result.favorites.length, Math.min(count, 4));
    assert.equal(new Set(result.favorites).size, result.favorites.length);
    assert(!result.favorites.includes(99)); assert.deepEqual(result.rediscovery, []);
    assert.deepEqual(tracks, before);
  }
  const tracks = [1, 2, 3, 4, 5].map(id => song(id, 1));
  const withOld = select([...tracks, song(99, 100, false)]);
  assert.equal(withOld.favorites.length, 2); assert.deepEqual(withOld.rediscovery, [99]);
  const played = [...tracks, { ...song(99, 100, false), lastPlayedAt: new Date(now).toISOString() }];
  assert.deepEqual(select(played, withOld), withOld);
  assert.equal(select(played, withOld, { now: now + day }).favorites.length, 4);
});

test('기존2곡을 앞에 둔4곡 확장·재실행 유지·해제 시 빈 자리만 보충·다음 날2곡 복귀', () => {
  const tracks = [1, 2, 3, 4, 5, 6].map(id => song(id, 1));
  const storage = memory(), old = { version: 1, date: localDateKey(now), favorites: [5, 2], rediscovery: [] };
  storage.setItem(DAILY_RECOMMENDATIONS_KEY, JSON.stringify(old));
  const first = createDailyRecommendations({ storage, now: () => now, random: () => 0 }).update(tracks);
  const ids = first.favorites.map(track => track.id);
  assert.equal(ids.length, 4); assert.deepEqual(ids.slice(0, 2), old.favorites);
  const restarted = createDailyRecommendations({ storage, now: () => now, random: () => { throw Error('재추첨 금지'); } });
  assert.deepEqual(restarted.update(tracks.slice().reverse()), first);
  const saved = JSON.parse(storage.getItem(DAILY_RECOMMENDATIONS_KEY));
  const changed = tracks.map(track => track.id === ids[0] ? { ...track, isLifeSong: false } : track);
  const updated = select(changed, saved);
  assert.deepEqual(updated.favorites.slice(0, 3), ids.slice(1)); assert.equal(updated.favorites.length, 4);
  assert(!updated.favorites.includes(ids[0]));
  const next = select([...tracks, song(99, 100, false)], saved, { now: now + day });
  assert.equal(next.favorites.length, 2); assert.deepEqual(next.rediscovery, [99]);
});

test('0/1/2/여러 후보: 세 영역 정책은 별개이며 블록 내부 중복과 임의 소장곡 채움을 막는다', () => {
  assert.deepEqual(select([]).favorites, []); assert.deepEqual(select([]).rediscovery, []);
  const one = select([song(1)]); assert.deepEqual(one.favorites, [1]); assert.deepEqual(one.rediscovery, [1]);
  const two = select([song(1), song(2)]); assert.equal(two.favorites.length, 2); assert.equal(two.rediscovery.length, 2);
  const current = select([song(1, 1), song(2, 0), song(3, 100, false), song(4, 101, false)]);
  assert.deepEqual(current.favorites.slice().sort(), [1, 2]); assert.deepEqual(current.rediscovery.slice().sort(), [3, 4]);
  assert.deepEqual(select([song(1, 1, false)]).favorites, []); assert.deepEqual(select([song(1, 1)]).rediscovery, []);
});

test('매일 추출은 후보의 ID/오래된 순서가 아닌 균등 Fisher-Yates 결과를 사용한다', () => {
  const counts = new Map([1, 2, 3].map(id => [id, 0]));
  for (let first = 0; first < 3; first++) for (let second = 0; second < 2; second++) {
    const randoms = [(first + .5) / 3, (second + .5) / 2]; let index = 0;
    const result = select([song(1), song(2), song(3)], null, { random: () => randoms[index++] });
    result.favorites.forEach(id => counts.set(id, counts.get(id) + 1));
  }
  assert.deepEqual([...counts.values()], [4, 4, 4]);
  assert.notDeepEqual(select([song(1), song(2), song(3), song(4)]).favorites, [1, 2]);
});

test('같은 날 재렌더·소장곡 정렬·재실행은 선정과 순서를 유지하고 난수를 다시 쓰지 않는다', () => {
  const storage = memory(), tracks = [1, 2, 3, 4, 5].map(id => song(id));
  const a = createDailyRecommendations({ storage, now: () => now, random: () => 0 });
  const first = a.update(tracks, { refreshDate: true }); const saved = storage.getItem(DAILY_RECOMMENDATIONS_KEY);
  assert.deepEqual(a.update(tracks.slice().reverse()), first); assert.equal(storage.getItem(DAILY_RECOMMENDATIONS_KEY), saved);
  const b = createDailyRecommendations({ storage, now: () => now, random: () => { throw Error('다시 추첨하면 안 됨'); } });
  assert.deepEqual(b.update(tracks, { refreshDate: true }), first);
});

test('로컬 날짜와 활성화: 자정 후 일반 갱신은 그대로, 오늘 진입/활성화에서만 재선정', () => {
  const tracks = [1, 2, 3, 4, 5].map(id => song(id));
  const before = new Date(2026, 9, 24, 23, 59).getTime(), after = new Date(2026, 9, 25, 0, 1).getTime();
  assert.equal(localDateKey(before), '2026-10-24'); assert.equal(localDateKey(after), '2026-10-25');
  const snapshot = select(tracks, null, { now: before });
  assert.deepEqual(select(tracks, snapshot, { now: after, refreshDate: false }), snapshot);
  const next = select(tracks, snapshot, { now: after, random: () => .999 });
  assert.equal(next.date, '2026-10-25'); assert.notDeepEqual(next.favorites, snapshot.favorites);
});

test('해제/삭제는 해당 추천만 빼고 빈 자리만 채우며 새 최애 추가는 유효 추천을 흔들지 않는다', () => {
  const tracks = [1, 2, 3, 4, 5].map(id => song(id)); const snapshot = select(tracks);
  assert.deepEqual(select([...tracks, song(6)], snapshot).favorites, snapshot.favorites);
  const removed = snapshot.favorites[0], remaining = snapshot.favorites[1];
  const changed = tracks.map(track => track.id === removed ? { ...track, isLifeSong: false } : track);
  const next = select(changed, snapshot); assert.equal(next.favorites[0], remaining); assert(!next.favorites.includes(removed));
  const deleted = snapshot.rediscovery[0]; const after = select(tracks.filter(track => track.id !== deleted), snapshot);
  assert.equal(after.rediscovery[0], snapshot.rediscovery[1]); assert(!after.rediscovery.includes(deleted));
});

test('재발견은 최초 추출 시 두 최애곡과 겹치지 않는 적격곡을 우선하고 부족할 때만 겹친다', () => {
  const enough = select([1, 2, 3, 4, 5].map(id => song(id)));
  assert(enough.rediscovery.every(id => !enough.favorites.includes(id)));
  const short = select([song(1), song(2), song(3)]);
  assert.equal(short.rediscovery.length, 2); assert.equal(short.rediscovery.filter(id => short.favorites.includes(id)).length, 1);
});

test('90일 실경과·미감상 소장일·UTC/오프셋·잘못된 날짜를 기존 기준으로 판정한다', () => {
  const edge = now - 90 * day;
  const tracks = [
    { id: 1, lastPlayedAt: new Date(edge).toISOString() }, { id: 2, lastPlayedAt: new Date(edge + 1).toISOString() },
    { id: 3, createdAt: new Date(edge).toISOString() }, { id: 4, createdAt: new Date(edge - 1).toISOString(), lastPlayedAt: new Date(now).toISOString() },
    { id: 5, createdAt: '1970-01-01 00:00:00', lastPlayedAt: 'bad' }, { id: 6, createdAt: '2026-02-30 00:00:00' }
  ];
  assert.deepEqual(select(tracks).rediscovery.slice().sort(), [1, 3]);
  assert.deepEqual(select([{ id: 1 }, { id: 2, createdAt: null }, { id: 3, createdAt: '' }]).rediscovery, []);
});

test('선정 뒤 유효 감상을 저장해도 오늘 재발견은 남고 다음 날짜부터 새 감상 시각을 적용한다', () => {
  const tracks = [song(1, 100, false), song(2, 101, false)]; const before = structuredClone(tracks), snapshot = select(tracks);
  const played = tracks.map(track => ({ ...track, lastPlayedAt: new Date(now).toISOString() }));
  assert.deepEqual(select(played, snapshot), snapshot);
  assert.deepEqual(select(played, snapshot, { now: now + day }).rediscovery, []); assert.deepEqual(tracks, before);
});

test('깨진 저장값은 복구하며 저장이 차단되어도 세션 내 선정은 안정적이고 다른 창의 같은 날 선정은 읽는다', () => {
  const tracks = [1, 2, 3, 4].map(id => song(id)); const storage = memory(); storage.setItem(DAILY_RECOMMENDATIONS_KEY, '{bad');
  const a = createDailyRecommendations({ storage, now: () => now, random: () => 0 }); a.update(tracks);
  const external = select(tracks, null, { random: () => .999 }); storage.setItem(DAILY_RECOMMENDATIONS_KEY, JSON.stringify(external));
  assert.deepEqual(a.update(tracks).favorites.map(t => t.id), external.favorites);
  const blocked = createDailyRecommendations({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } }, now: () => now, random: () => 0 });
  assert.deepEqual(blocked.update(tracks), blocked.update(tracks.slice().reverse()));
  for (const value of [{ version: 1, date: localDateKey(now), favorites: [1, 1], rediscovery: [] }, { version: 1, date: 'bad', favorites: [], rediscovery: [] }]) assert.equal(new Set(select(tracks, value).favorites).size, 2);
});
