import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadingCue } from '../public/loading-cue.js';

function fixture() {
  let clock = 0, next = 0, changes = 0; const timers = new Map();
  const cue = new LoadingCue({ schedule: (fn, delay) => { const id = next++; timers.set(id, { fn, at: clock + delay }); return id; }, cancel: id => timers.delete(id), onChange: () => changes++ });
  const advance = ms => { clock += ms; for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); } };
  return { cue, advance, timers, changes: () => changes };
}
test('짧은 로딩과 waiting/playing 반복은 상태 문구를 노출하지 않는다', () => {
  const { cue, advance, changes } = fixture();
  for (let i = 0; i < 5; i++) { assert.equal(cue.update(true, 'song'), false); advance(200); assert.equal(cue.update(false, 'song'), false); }
  advance(1000); assert.equal(cue.visible, false); assert.equal(changes(), 0);
});
test('지속 로딩은 600ms 후 한 번 노출하며 같은 곡의 tick은 타이머를 늦추지 않는다', () => {
  const { cue, advance, changes } = fixture();
  cue.update(true, 'song'); advance(300); cue.update(true, 'song'); advance(299); assert.equal(cue.visible, false);
  advance(1); assert.equal(cue.visible, true); assert.equal(changes(), 1);
  cue.update(true, 'song'); advance(1000); assert.equal(changes(), 1);
  cue.update(false, 'song'); assert.equal(cue.visible, false);
});
test('곡 전환·일시정지·오류·빈 큐는 이전 노출 타이머를 취소한다', () => {
  const { cue, advance, changes, timers } = fixture();
  cue.update(true, 'first'); advance(500); cue.update(true, 'second'); advance(100); assert.equal(cue.visible, false);
  cue.update(false, 'second'); assert.equal(timers.size, 0); advance(1000); assert.equal(changes(), 0);
  cue.update(true, 'third'); advance(600); assert.equal(cue.visible, true); cue.reset(); assert.equal(cue.visible, false); assert.equal(timers.size, 0);
});
