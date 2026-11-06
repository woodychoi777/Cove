import test from 'node:test';
import assert from 'node:assert/strict';
import { QueuePlayer } from '../public/player.js';
import { playDisplayedList } from '../public/listening.js';
import { TrackDrafts, noteValues } from '../public/drafts.js';

test('표시 목록 중간부터 재생하고 검색 목록 변경에도 활성 큐는 유지한다', async t => {
  const player = new QueuePlayer({ tick: false });
  t.after(() => player.destroy());
  player.ensureContext = () => {};
  player.play = async () => { player.paused = false; };
  const tracks = [{ id: 7, albumId: 1 }, { id: 3, albumId: 2 }, { id: 5, albumId: 3 }];
  player.tracks = tracks.slice();
  await playDisplayedList(player, tracks, { source: '검색 결과', startId: 3 });
  assert.deepEqual(player.snapshot().ids, [7, 3, 5]);
  assert.equal(player.trackId, 3);
  assert.equal(player.source, '검색 결과');
  tracks.splice(0, 2);
  assert.deepEqual(player.snapshot().ids, [7, 3, 5]);
  await playDisplayedList(player, [], { source: '빈 결과' });
  assert.equal(player.trackId, 3);
});

test('명시적 토글 옵션은 현재 곡의 큐와 위치를 유지하며 일시정지·재개한다', async t => {
  const player = new QueuePlayer({ tick: false });
  t.after(() => player.destroy());
  player.ensureContext = () => {};
  player.play = async () => { player.paused = false; };
  player.tracks = [{ id: 1 }, { id: 2 }];
  await playDisplayedList(player, player.tracks, { source: '내 컬렉션' });
  player.offset = 12;
  await playDisplayedList(player, [{ id: 1 }], { source: '다른 목록', toggleCurrent: true });
  assert.equal(player.paused, true);
  assert.equal(player.offset, 12);
  assert.deepEqual(player.snapshot().ids, [1, 2]);
  await playDisplayedList(player, [{ id: 1 }], { source: '다른 목록', toggleCurrent: true });
  assert.equal(player.paused, false);
  assert.equal(player.source, '내 컬렉션');
  await playDisplayedList(player, [{ id: 1 }], { source: '검색 결과' });
  assert.deepEqual(player.snapshot().ids, [1]);
  assert.equal(player.offset, 0);
});

test('곡별 초안과 저장 도중 추가 입력은 다른 곡 저장으로 삭제되지 않는다', () => {
  const drafts = new TrackDrafts();
  const baseline = noteValues({});
  const first = { ...baseline, memory: '첫 곡의 기록', isLifeSong: true };
  const second = { ...baseline, lyricsOriginal: '[00:01]둘째 곡', meaning: '의미' };
  drafts.update(1, first, baseline); drafts.update(2, second, baseline);
  drafts.saved(1, first);
  assert.equal(drafts.get(1), undefined);
  assert.deepEqual(drafts.get(2), second);
  drafts.update(1, { ...first, memory: '저장 중 더 작성' }, baseline);
  drafts.saved(1, first);
  assert.equal(drafts.get(1).memory, '저장 중 더 작성');
  drafts.update(1, first, first);
  assert.equal(drafts.size, 1);
});

for (const field of ['lyricsOriginal', 'lyricsTranslation', 'meaning', 'favoriteReason', 'memory', 'isLifeSong']) {
  for (const outcome of ['success', 'failure']) {
    test(`D1: ${field}의 저장 중 기준값 복귀·다른 곡 이동·${outcome}`, () => {
      const drafts = new TrackDrafts();
      const baseline = noteValues({ [field]: field === 'isLifeSong' ? false : '이전 저장값' });
      const submitted = { ...baseline, [field]: field === 'isLifeSong' ? true : '제출한 저장값' };
      drafts.open(1, baseline);
      drafts.update(1, submitted);
      drafts.startSave(1, submitted);
      drafts.update(1, baseline);
      assert.deepEqual(drafts.get(1), baseline, '응답 전 기준값으로 돌아와도 최신 편집을 보존');
      // Opening another song or reopening with a GET after the PUT must not overwrite it.
      drafts.open(2, noteValues({ memory: '다른 곡' }));
      assert.deepEqual(drafts.open(1, submitted), baseline);
      if (outcome === 'success') {
        drafts.saved(1, submitted);
        assert.deepEqual(drafts.get(1), baseline);
        assert.deepEqual(drafts.open(1, submitted), baseline);
        drafts.startSave(1, baseline); drafts.saved(1, baseline);
      } else {
        drafts.failed(1);
      }
      assert.equal(drafts.get(1), undefined, '실제 저장 기준과 같아졌을 때만 정리');
      assert.deepEqual(drafts.open(1, baseline), baseline);
    });
  }
}

test('행 재선택은 현재 곡을 정지하거나 큐/위치를 바꾸지 않고 멈춘 경우에만 재개한다', async () => {
  const player = new QueuePlayer({ tick: false });
  let starts = 0, pauses = 0;
  player.ensureContext = () => {};
  player.play = async () => { starts++; player.paused = false; };
  player.pause = () => { pauses++; player.paused = true; };
  player.tracks = [{ id: 1 }, { id: 2 }];
  await playDisplayedList(player, player.tracks, { source: '원래 목록' }); player.offset = 25;
  const keys = player.queue.map(row => row.key);
  await playDisplayedList(player, [{ id: 1 }], { source: '검색 결과', resumeCurrent: true });
  assert.equal(starts, 1); assert.equal(pauses, 0); assert.equal(player.currentTime, 25); assert.equal(player.source, '원래 목록'); assert.deepEqual(player.queue.map(row=>row.key), keys);
  player.paused = true;
  await playDisplayedList(player, [{ id: 1 }], { source: '검색 결과', resumeCurrent: true });
  assert.equal(starts, 2); assert.equal(pauses, 0); assert.equal(player.currentTime, 25); assert.deepEqual(player.snapshot().ids, [1, 2]);
});
