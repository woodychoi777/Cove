import assert from 'node:assert/strict';
import test from 'node:test';
import { QueuePlayer } from '../public/player.js';
import { albumTracks, randomPick, rediscover, transitionPlan } from '../public/listening.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class Param {
  calls = [];
  setValueAtTime(value, at) { this.calls.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.calls.push(['ramp', value, at]); }
  cancelScheduledValues(at) { this.calls.push(['cancel', at]); }
}
class Context {
  currentTime = 0;
  destination = {};
  sources = [];
  async resume() {}
  close() {}
  createGain() { return { gain: new Param(), connect() {}, disconnect() {} }; }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(at, offset) { this.at = at; this.offset = offset; }, stop() { this.stopped = true; } };
    this.sources.push(source);
    return source;
  }
}
function fixture(t, loadBuffer = async () => ({ duration: 100 })) {
  const context = new Context();
  const player = new QueuePlayer({ contextFactory: () => context, loadBuffer, tick: false });
  player.tracks = [1, 2, 3].map(id => ({ id, durationMs: 100000 }));
  t.after(() => player.destroy());
  return { player, context };
}

test('앨범 순서, 무작위 중복 방지, 90일 지난 소장곡 재발견', () => {
  const songs = [
    { id: 1, albumId: 1, discNumber: 2, trackNumber: 1, isLifeSong: true, lastPlayedAt: '2026-06-01 00:00:00' },
    { id: 2, albumId: 1, discNumber: 1, trackNumber: 2, isLifeSong: true, lastPlayedAt: null, createdAt: '2026-01-01 00:00:00' },
    { id: 3, albumId: 1, discNumber: 1, trackNumber: 1, isLifeSong: true, lastPlayedAt: '2026-09-05T00:00:00Z' },
    { id: 4, albumId: 2, isLifeSong: false },
  ];
  assert.deepEqual(albumTracks(songs, songs[0]).map(s => s.id), [3, 2, 1]);
  assert.deepEqual(rediscover(songs, Date.parse('2026-09-06T00:00:00Z')).map(s => s.id), [2, 1]);
  assert.equal(randomPick([1, 2], 1, () => 0), 2);
  assert.equal(randomPick([1], 1), 1);
  assert.equal(randomPick([], null), null);
  assert.deepEqual(transitionPlan(10, 100, 100, 4), { start: 96, fade: 4 });
  assert.ok(transitionPlan(99, 100, 100, 6).fade < .5);
});

test('무음 없는 연결은 다음 버퍼를 앞 곡의 종료 시각에 예약한다', async t => {
  const { player, context } = fixture(t);
  player.setQueue([1, 2, 3]);
  await player.play(); await settle();
  assert.equal(player.scheduled.start, player.current.start + 100);
  const first = player.current;
  context.currentTime = player.scheduled.start;
  first.source.onended(); await settle();
  assert.equal(player.trackId, 2);
  assert.equal(player.paused, false);
  assert.equal(player.scheduled.start, player.current.start + 100);
  assert.equal(first.finished, true);
});

test('크로스페이드는 겹쳐 시작하며 다음 곡 승격 후에도 페이드인을 유지한다', async t => {
  const { player, context } = fixture(t);
  player.setQueue([1, 2, 3]); player.setTransition(4);
  await player.play(); await settle();
  const first = player.current;
  const next = player.scheduled;
  assert.equal(next.start, first.start + 96);
  assert.deepEqual(next.gain.gain.calls, [['set', 0, next.start], ['ramp', 1, next.start + 4]]);
  context.currentTime = next.start + .1;
  player.update(); await settle();
  assert.equal(player.trackId, 2);
  const correction = next.gain.gain.calls.find(call => call[0] === 'set' && call[2] === context.currentTime);
  assert.ok(correction[1] > 0 && correction[1] < .03);
  assert.ok(next.gain.gain.calls.some(call => call[0] === 'ramp' && call[2] === next.fadeInEnd));
  assert.equal(first.finished, false);
});

test('다음에 듣기·순서 변경·삭제는 현재 곡을 보존하고 예약을 바꾼다', async t => {
  const { player } = fixture(t);
  player.setQueue([1, 2]); await player.play(); await settle();
  const oldNext = player.scheduled;
  const current = player.current;
  player.enqueue(3, true); await settle();
  assert.deepEqual(player.snapshot().ids, [1, 3, 2]);
  assert.equal(oldNext.source.stopped, true);
  assert.equal(player.scheduled.entry.trackId, 3);
  player.move(2, 0); await settle();
  assert.equal(player.index, 1);
  assert.equal(player.current, current);
  player.remove(0); await settle();
  assert.equal(player.index, 0);
  assert.equal(player.trackId, 1);
  player.enqueue(1); await settle();
  assert.deepEqual(player.snapshot().ids, [1, 3, 1]);
  player.remove(0); await settle();
  assert.equal(player.trackId, 3);
  assert.equal(player.paused, false);
});

test('구간 이동은 실제 들은 시간만 기록하고 일시정지 시 저장한다', async t => {
  const { player, context } = fixture(t);
  const events = [];
  player.addEventListener('listened', event => events.push(event.detail));
  player.setQueue([1, 2]); await player.play(); await settle();
  context.currentTime = player.current.start + 2;
  await player.seek(90); await settle();
  context.currentTime = player.current.start + 3;
  player.pause();
  assert.equal(player.currentTime, 93);
  assert.equal(player.nodes.size, 0);
  assert.deepEqual(events, [{ id: 1, listenedMs: 5000, completed: false }]);
  player.pause();
  assert.equal(events.length, 1);
  await player.play(); await settle();
  assert.equal(player.current.offset, 93);
});

test('불러오는 중 곡을 바꾸면 이전 요청의 결과가 재생되지 않는다', async t => {
  let resolveFirst;
  const pending = new Promise(resolve => { resolveFirst = resolve; });
  const { player, context } = fixture(t, id => id === 1 ? pending : Promise.resolve({ duration: 100 }));
  player.setQueue([1, 2]); const starting = player.play(); await settle();
  await player.select(1); await settle();
  resolveFirst({ duration: 100 }); await starting; await settle();
  assert.equal(player.trackId, 2);
  assert.equal(context.sources.length, 1);
});

test('다음 곡 준비 실패는 현재 재생을 끊지 않고 재생 오류를 안내한다', async t => {
  const { player, context } = fixture(t, async id => { if (id === 2) throw new Error('broken'); return { duration: 100 }; });
  const errors = [];
  player.addEventListener('error', event => errors.push(event.detail));
  player.setQueue([1, 2]); await player.play(); await settle();
  assert.equal(player.paused, false);
  assert.match(player.status, /다음 곡 준비 실패/);
  context.currentTime = player.current.start + 100;
  player.current.source.onended(); await settle();
  assert.equal(player.trackId, 2);
  assert.equal(player.paused, true);
  assert.equal(errors.length, 1);
});

test('마지막 곡 종료와 빈 대기열을 안전하게 처리한다', async t => {
  const { player, context } = fixture(t);
  player.setQueue([1]); await player.play(); await settle();
  context.currentTime = player.current.start + 100;
  player.current.source.onended();
  assert.equal(player.paused, true);
  assert.match(player.status, /완료/);
  await player.play(); await settle();
  assert.equal(player.current.offset, 0);
  player.remove(0); await settle();
  assert.equal(player.trackId, null);
  assert.equal(player.nodes.size, 0);
  assert.equal(player.paused, true);
});

test('재생 중 마지막 구간으로 이동하면 다음 곡으로 넘어가고 마지막 곡에서는 멈춘다', async t => {
  const { player } = fixture(t);
  player.setQueue([1, 2]); await player.play(); await settle();
  await player.seek(100); await settle();
  assert.equal(player.trackId, 2);
  assert.equal(player.paused, false);
  await player.seek(100); await settle();
  assert.equal(player.trackId, 2);
  assert.equal(player.paused, true);
  assert.equal(player.currentTime, 100);
});

test('셔플은 현재 출력·위치·지난 항목·중복을 유지하고 남은 원래 순서를 복원한다', async t => {
  const { player, context } = fixture(t);
  player.random = () => 0;
  player.setQueue([1, 2, 1, 3, 2], 1); await player.play(); await settle();
  context.currentTime = player.current.start + 7;
  const current = player.current, session = player.session, keys = player.queue.map(row => row.key);
  const scheduled = player.scheduled;
  player.setShuffle(true); await settle();
  assert.deepEqual(player.queue.slice(0, 2).map(row => row.key), keys.slice(0, 2));
  assert.notDeepEqual(player.queue.slice(2).map(row => row.key), keys.slice(2));
  assert.equal(player.current, current); assert.equal(player.session, session);
  assert.equal(player.currentTime, 7); assert.equal(current.source.stopped, undefined);
  assert.equal(scheduled.source.stopped, true);
  assert.deepEqual(player.queue.map(row => row.key).sort(), [...keys].sort());
  player.setShuffle(false); await settle();
  assert.deepEqual(player.queue.map(row => row.key), keys);
  assert.equal(player.current, current); assert.equal(player.paused, false);
  // After advancing, shuffle-off restores only the remaining relative order.
  player.setShuffle(true); await settle(); await player.next(); await settle();
  const past = player.queue.slice(0, player.index + 1).map(row => row.key);
  player.setShuffle(false); await settle();
  assert.deepEqual(player.queue.slice(0, player.index + 1).map(row => row.key), past);
  const rest = player.queue.slice(player.index + 1).map(row => keys.indexOf(row.key));
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
});

test('셔플 원순서·설정은 중복 항목과 함께 복원하고 자동 재생하지 않는다', async t => {
  const { player } = fixture(t);
  assert.equal(player.shuffle, false); assert.equal(player.repeat, 'off');
  player.random = () => 0; player.setQueue([1, 2, 1, 3]); player.setShuffle(true); player.setRepeat('all'); player.setTransition(4);
  const snapshot = player.snapshot();
  player.restore(snapshot);
  assert.deepEqual(player.snapshot(), snapshot);
  assert.equal(player.paused, true); assert.equal(player.context, undefined); assert.equal(player.currentTime, 0);
  player.setShuffle(false);
  assert.deepEqual(player.snapshot().ids, [1, 2, 1, 3]);
  player.restore({ ids: [2, 1, 2], index: 1, repeat: 'invalid' });
  assert.equal(player.repeat, 'off'); assert.equal(player.shuffle, false);
  assert.deepEqual(player.snapshot().ids, [2, 1, 2]);
  player.restore({ ids: [], shuffle: true, repeat: 'one' });
  assert.equal(player.hasNext, false); player.setShuffle(false); await player.next();
});

test('셔플 중 추가·이동·삭제는 항목별 원순서와 현재 출력 보존', async t => {
  const { player } = fixture(t);
  player.random = () => 0; player.setQueue([1, 2, 3, 1]); await player.play(); await settle();
  const current = player.current; player.setShuffle(true);
  player.enqueue(2, true); player.enqueue(3);
  const inserted = player.queue[1].key;
  player.move(player.queue.length - 1, 2);
  player.remove(player.queue.findIndex(row => row.trackId === 3 && row.key !== inserted));
  const expected = player.originalOrder.filter(key => key !== player.queue[0].key);
  player.setShuffle(false); await settle();
  assert.deepEqual(player.queue.slice(1).map(row => row.key), expected);
  assert.equal(player.queue[1].key, inserted); assert.equal(player.current, current);
  assert.equal(new Set(player.queue.map(row => row.key)).size, player.queue.length);
});

test('전체 반복은 마지막→첫 곡 예약, 한 곡 반복은 자연 종료만 반복하며 다음 조작 허용', async t => {
  const { player, context } = fixture(t);
  player.setQueue([1, 2, 1], 2); player.setRepeat('all'); await player.play(); await settle();
  assert.equal(player.scheduled.entry.key, player.queue[0].key); assert.equal(player.hasNext, true);
  context.currentTime = player.scheduled.start; player.current.source.onended(); await settle();
  assert.equal(player.index, 0); assert.equal(player.paused, false);
  player.setTransition(4); player.setRepeat('one'); await settle();
  assert.equal(player.scheduled.entry.key, player.queue[0].key);
  assert.equal(player.scheduled.start, player.current.start + 100); // same song finishes before repeating
  const session = player.session;
  context.currentTime = player.scheduled.start; player.current.source.onended(); await settle();
  assert.equal(player.index, 0); assert.notEqual(player.session, session);
  await player.next(); await settle(); assert.equal(player.index, 1);
  player.setRepeat('off'); await settle(); assert.equal(player.scheduled.entry.key, player.queue[2].key);
  await player.select(2); await settle(); assert.equal(player.scheduled, null); assert.equal(player.hasNext, false);
});

test('반복 예약 변경과 빠른 토글은 현재 곡을 유지하고 지난 예약은 출력하지 않는다', async t => {
  let resolveNext;
  const { player } = fixture(t, id => id === 2 ? new Promise(resolve => { resolveNext = resolve; }) : Promise.resolve({ duration: 100 }));
  player.setQueue([1, 2]); await player.play(); await settle();
  const current = player.current;
  player.setRepeat('one'); player.setShuffle(true); player.setShuffle(false); await settle();
  resolveNext({ duration: 100 }); await settle();
  assert.equal(player.current, current); assert.equal(player.scheduled.entry.key, player.queue[0].key);
  player.setRepeat('off'); await settle(); assert.equal(player.scheduled.entry.trackId, 2);
});

test('이미 출력이 시작된 예약 곡의 다음 클릭은 그 다음 항목으로 한 번에 이동한다', async t => {
  const {player,context}=fixture(t);
  player.setQueue([1,2,3]);await player.play();await settle();
  const first=player.current,scheduled=player.scheduled,keys=player.queue.map(row=>row.key);
  context.currentTime=scheduled.start+.05; // Audio clock has crossed; UI tick has not.
  assert.equal(player.index,0);
  await player.next();await settle();
  assert.equal(player.index,2);assert.equal(player.current.entry.key,keys[2]);
  assert.equal(first.source.stopped,true);assert.equal(scheduled.source.stopped,true);
  assert.deepEqual(player.queue.map(row=>row.key),keys);
});

test('이전은5초 경과와 중복 곡ID에 무관하게 표시 큐의 이전 항목으로 이동한다',async t=>{
 const {player,context}=fixture(t);player.setQueue([1,2,2],2);await player.play();await settle();
 const keys=player.queue.map(row=>row.key);context.currentTime=player.current.start+6;
 await player.previous();await settle();assert.equal(player.index,1);assert.equal(player.current.entry.key,keys[1]);assert.equal(player.current.offset,0);
 for(const repeat of ['off','one']){
  player.setRepeat(repeat);await player.select(0);context.currentTime=player.current.start+6;
  const current=player.current;assert.equal(player.hasPrevious,false);await player.previous();assert.equal(player.current,current);assert.equal(player.currentTime,6);
  await player.select(2);assert.equal(player.hasNext,false);const last=player.current;await player.next();assert.equal(player.current,last);
 }
 player.setRepeat('all');await player.select(0);await player.previous();await settle();assert.equal(player.index,2);
 player.setQueue([1]);player.setRepeat('off');assert.equal(player.hasPrevious,false);assert.equal(player.hasNext,false);
 player.setRepeat('all');assert.equal(player.hasPrevious,true);assert.equal(player.hasNext,true);await player.play();const current=player.current;await player.previous();assert.notEqual(player.current,current);assert.equal(player.index,0);
});

test('로딩 중 빠른 이전·다음은 최종 항목과 셔플 순서를 보존한다',async t=>{
 let release;const {player}=fixture(t,id=>id===2?new Promise(ok=>release=ok):Promise.resolve({duration:100}));
 player.setQueue([1,2,3]);player.shuffle=true;const keys=player.queue.map(row=>row.key);
 await player.play();await settle();const pending=player.next();await settle();await player.next();await settle();release({duration:100});await pending;await settle();
 assert.equal(player.index,2);assert.equal(player.current.entry.key,keys[2]);assert.deepEqual(player.queue.map(row=>row.key),keys);
 player.pause();await player.previous();await settle();assert.equal(player.index,1);assert.equal(player.paused,false); // existing manual-select policy
});
