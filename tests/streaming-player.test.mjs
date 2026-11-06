import test from 'node:test';
import assert from 'node:assert/strict';
import { QueuePlayer } from '../public/player.js';
import { needsStreaming } from '../public/streaming-audio.js';

class Media extends EventTarget {
  currentTime = 0; duration = 1000; readyState = 1; paused = true;
  play() { this.paused = false; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('playing')); return this.pending || Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.released = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function fixture(t, factory = () => new Media()) {
  const gains = [], media = [], decoded = [], events = [];
  const context = { currentTime: 0, destination: {}, resume: async () => {}, close() {},
    createGain() { const gain = { gain: { setValueAtTime(value) { gain.value = value; }, cancelScheduledValues() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; gains.push(gain); return gain; },
    createMediaElementSource(audio) { audio.graphConnected = true; return { connect() {}, disconnect() { audio.graphConnected = false; } }; },
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
  };
  const player = new QueuePlayer({ contextFactory: () => context, mediaFactory: () => { const audio = factory(); media.push(audio); return audio; }, loadBuffer: async id => { decoded.push(id); return { duration: 10 }; }, tick: false });
  player.tracks = [{ id: 1, durationMs: 3600_000, sampleRate: 44100 }, { id: 2, durationMs: 10000 }, { id: 3, durationMs: 3600_000 }];
  player.addEventListener('listened', event => events.push(event.detail));
  t.after(() => player.destroy());
  return { player, context, media, decoded, gains, events };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('긴/고해상도/큰 음원은 전체 PCM 디코딩 경로에 넣지 않는다', () => {
  assert.equal(needsStreaming({ durationMs: 3600_000, sampleRate: 44100, channels: 2 }), true);
  assert.equal(needsStreaming({ durationMs: 590_000, sampleRate: 96000, channels: 2 }), true);
  assert.equal(needsStreaming({ fileSize: 100 * 1024 ** 2 }), true);
  assert.equal(needsStreaming({ durationMs: 120000, sampleRate: 44100, channels: 2 }), false);
});
test('긴 음원 시작/일시정지/재개/탐색과 실제 감상 시간·음량·음소거를 보존한다', async t => {
  const { player, context, media, decoded, events, gains } = fixture(t);
  player.setQueue([1, 2]); await player.play();
  assert.deepEqual(decoded, []); assert.equal(player.status, '재생 중');
  context.currentTime = 2; media[0].currentTime = 2; player.pause();
  assert.equal(player.currentTime, 2); assert.equal(media[0].released, true);
  assert.equal(media[0].graphConnected, false); assert.equal(media[0].src, '');
  assert.deepEqual(events, [{ id: 1, listenedMs: 2000, completed: false }]);
  await player.play(); assert.equal(media[1].currentTime, 2);
  context.currentTime = 5; media[1].currentTime = 5;
  await player.seek(900); assert.equal(media[2].currentTime, 900);
  context.currentTime = 7; media[2].currentTime = 902; player.pause();
  assert.equal(events[1].listenedMs, 5000);
  player.volume = .25; assert.equal(gains[0].value, .25);
  player.muted = true; assert.equal(gains[0].value, 0);
  player.muted = false; assert.equal(gains[0].value, .25);
  assert.deepEqual(player.snapshot().ids, [1, 2]);
});
test('버퍼링·탐색 점프는 청취 시간으로 세지 않고 오류 후 재시도한다', async t => {
  const { player, context, media, events } = fixture(t);
  player.setQueue([1]); await player.play();
  context.currentTime = 2; media[0].currentTime = 2; media[0].dispatchEvent(new Event('waiting'));
  assert.equal(player.status, '불러오는 중');
  context.currentTime = 50; player.update();
  media[0].currentTime = 800; media[0].dispatchEvent(new Event('seeking')); media[0].dispatchEvent(new Event('seeked')); media[0].dispatchEvent(new Event('playing'));
  context.currentTime = 51; media[0].currentTime = 801;
  media[0].error = { code: 2 }; media[0].dispatchEvent(new Event('error'));
  assert.equal(player.paused, true); assert.match(player.status, /재생 실패/);
  assert.equal(events[0].listenedMs, 3000);
  await player.play(); assert.equal(media[1].currentTime, 801);
});
test('긴→짧은→긴 경계의 연속 전환과 마지막 종료, 긴 다음 곡 사전 디코딩 금지', async t => {
  const { player, context, media, decoded } = fixture(t);
  player.setQueue([1, 2, 3]); player.setTransition(4); await player.play();
  assert.deepEqual(decoded, []);
  context.currentTime = 1000; media[0].currentTime = 1000; media[0].dispatchEvent(new Event('ended')); await settle();
  assert.equal(player.trackId, 2); assert.equal(player.paused, false); assert.deepEqual(decoded, [2]);
  assert.equal(player.scheduled, null);
  context.currentTime = player.current.start + 10; player.current.source.onended(); await settle();
  assert.equal(player.trackId, 3); assert.equal(player.paused, false); assert.deepEqual(decoded, [2]);
  context.currentTime += 1000; media[1].currentTime = 1000; media[1].dispatchEvent(new Event('ended')); await settle();
  assert.equal(player.paused, true); assert.equal(player.status, '대기열 재생 완료'); assert.equal(player.currentTime, 1000);
});
test('긴 음원 로딩 중 선택 변경/현재 곡 빼기는 이전 요청과 출력을 해제한다', async t => {
  let release;
  const { player, media } = fixture(t, () => { const audio = new Media(); if (!release) audio.pending = new Promise(resolve => { release = resolve; }); return audio; });
  player.setQueue([1, 2]); const pending = player.play();
  await player.select(1); release(); await pending;
  assert.equal(media[0].released, true); assert.equal(media[0].graphConnected, false); assert.equal(player.trackId, 2);
  await player.select(0); player.enqueue(3, true); player.move(0, 1);
  assert.equal(player.trackId, 1); assert.equal(player.index, 1);
  player.remove(1); await settle(); assert.equal(player.trackId, 2); assert.equal(player.paused, false);
});

test('긴 음원 셔플·반복 변경은 미디어를 유지하고 자연 종료/수동 다음을 구분한다', async t => {
  const { player, context, media, decoded } = fixture(t);
  player.random = () => 0; player.setQueue([1, 2, 3, 1]); await player.play();
  const stream = player.streaming; media[0].currentTime = 77; context.currentTime = 77;
  const keys = player.queue.map(row => row.key);
  player.setShuffle(true); player.setRepeat('one'); player.setShuffle(false);
  assert.equal(player.streaming, stream); assert.equal(player.currentTime, 77); assert.equal(media[0].released, undefined);
  assert.deepEqual(player.queue.map(row => row.key), keys); assert.deepEqual(decoded, []);
  media[0].currentTime = 1000; context.currentTime = 1000; media[0].dispatchEvent(new Event('ended')); await settle();
  assert.equal(player.index, 0); assert.equal(media[1].currentTime, 0); assert.equal(player.paused, false);
  await player.next(); await settle(); assert.equal(player.trackId, 2);
  await player.select(3); player.setRepeat('all');
  media.at(-1).currentTime = 1000; context.currentTime += 1000; media.at(-1).dispatchEvent(new Event('ended')); await settle();
  assert.equal(player.index, 0); assert.equal(player.paused, false);
  player.setRepeat('off'); await player.select(3);
  media.at(-1).currentTime = 1000; context.currentTime += 1000; media.at(-1).dispatchEvent(new Event('ended')); await settle();
  assert.equal(player.status, '대기열 재생 완료'); assert.equal(player.paused, true);
});

test('전체/한 곡 반복 중 오류는 자동 재시도 폭주 없이 멈추고 수동 다음을 허용한다', async t => {
  const { player, media } = fixture(t);
  for (const mode of ['all', 'one']) {
    player.setQueue([1, 3]); player.setRepeat(mode); await player.play();
    media.at(-1).error = { code: 2 }; media.at(-1).dispatchEvent(new Event('error')); await settle();
    const count = media.length; await settle();
    assert.equal(media.length, count); assert.equal(player.paused, true); assert.match(player.status, /실패/);
    await player.next(); assert.equal(player.index, 1); assert.equal(player.paused, false);
  }
});
