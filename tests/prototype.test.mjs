import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseFlacBuffer } from '../src/flac.mjs';
import { qualityLabel, qualityRank } from '../src/audio-metadata.mjs';
import { DuplicateFileError, MusicLibrary, safeSegment, MAX_ARTWORK_BYTES } from '../src/library.mjs';
import { MusicStore } from '../src/store.mjs';
import { LocalImport } from '../src/local-import.mjs';
import { syntheticFlac } from './fixtures.mjs';

test('FLAC 메타데이터에서 곡 정보를 읽는다', () => {
  const file = syntheticFlac();
  const metadata = parseFlacBuffer(file);
  assert.equal(metadata.title, 'Afterglow');
  assert.equal(metadata.artist, 'Mina Vale');
  assert.equal(metadata.album, 'Blue Hours');
  assert.equal(metadata.year, 2024);
  assert.equal(metadata.trackNumber, 1);
  assert.equal(metadata.sampleRate, 96_000);
  assert.equal(metadata.bitDepth, 24);
  assert.equal(metadata.channels, 2);
});

test('가져오기, 기록 저장, 중복 검사가 하나의 흐름으로 동작한다', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-test-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const store = new MusicStore(join(root, 'data', 'test.sqlite'));
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store });
  await library.init();
  context.after(() => store.close());

  const file = syntheticFlac();
  const staged = await library.stage(Readable.from(file), '01 - Afterglow.flac');
  assert.equal(staged.metadata.title, 'Afterglow');
  assert.equal(staged.hasArtwork, true);
  const track = await library.commit(staged.importId, {
    title: 'Afterglow (소장본)', lrcText: '[00:01.00]I keep the afterglow', lrcSourceName: 'Afterglow.lrc'
  });
  assert.equal(track.title, 'Afterglow (소장본)');
  assert.equal(track.artist, 'Mina Vale');
  assert.equal(track.lyricsSourceName, 'Afterglow.lrc');
  assert.equal(track.lyricsLrc, '[00:01.00]I keep the afterglow');
  assert.ok(track.lyricsFilePath.endsWith('Afterglow (소장본).lrc'));
  assert.ok(track.artworkPath.endsWith('cover.png'));

  const savedFile = await readFile(library.resolveManagedPath(track.managedPath));
  assert.deepEqual(savedFile, file);
  const savedLrc = await readFile(library.resolveManagedPath(track.lyricsFilePath), 'utf8');
  assert.equal(savedLrc, '[00:01.00]I keep the afterglow');

  const updated = store.updateNotes(track.id, {
    lyricsOriginal: 'I keep the afterglow', lyricsTranslation: '나는 잔광을 간직해',
    meaning: '기억에 관한 곡', favoriteReason: '늦은 밤의 분위기', memory: '처음 들은 날', isLifeSong: true
  });
  assert.equal(updated.lyricsTranslation, '나는 잔광을 간직해');
  assert.equal(updated.isLifeSong, true);
  assert.equal(updated.lyricsLrc, '[00:01.00]I keep the afterglow');
  assert.equal(store.exportCollection().tracks[0].memory, '처음 들은 날');

  await assert.rejects(
    () => library.stage(Readable.from(file), 'duplicate.flac'),
    (error) => error instanceof DuplicateFileError && error.existingTrack.id === track.id
  );
});

test('파일명 경로 구분자와 제어 문자를 제거한다', () => {
  assert.equal(safeSegment('  A/B:C\\D?\u0000 Song  '), 'A B C D Song');
  assert.equal(safeSegment('...'), '제목 없음');
  assert(Buffer.byteLength(safeSegment('한글🎵'.repeat(150))) <= 180);
  assert(!safeSegment('한글🎵'.repeat(150)).includes('\uFFFD'));
});

test('수동 앨범 사진은 같은 앨범에 반영되고 이전 표지와 음원·기록은 보존된다', async context => {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-artwork-'));
  const database = join(root, 'test.sqlite');
  const store = new MusicStore(database);
  context.after(() => store.close());
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store });
  await library.init();
  const audio = syntheticFlac();
  const first = await library.stage(Readable.from(audio), 'first.flac');
  const track = await library.commit(first.importId);
  const second = await library.stage(Readable.from(Buffer.concat([audio, Buffer.from([1])])), 'second.flac');
  const sibling = await library.commit(second.importId, { title: 'Second' });
  store.updateNotes(track.id, { lyricsOriginal: '[00:01]Test', memory: 'Keep this' });
  const oldArt = await readFile(library.resolveManagedPath(track.artworkPath));
  const updated = await library.saveArtwork(track.id, Readable.from(oldArt));
  assert.notEqual(updated.artworkPath, track.artworkPath);
  assert.equal(store.getTrack(sibling.id).artworkPath, updated.artworkPath);
  assert.equal(updated.lyricsOriginal, '[00:01]Test');
  assert.equal(updated.memory, 'Keep this');
  assert.deepEqual(await readFile(library.resolveManagedPath(updated.artworkPath)), oldArt);
  assert.deepEqual(await readFile(library.resolveManagedPath(track.artworkPath)), oldArt);
  assert.deepEqual(await readFile(library.resolveManagedPath(track.managedPath)), audio);
  await assert.rejects(library.saveArtwork(track.id, Readable.from(Buffer.from('<svg>invalid</svg>'))), /JPG/);
  await assert.rejects(library.saveArtwork(track.id, Readable.from(Buffer.alloc(MAX_ARTWORK_BYTES + 1))), /10 MB/);
  assert.equal(store.getTrack(track.id).artworkPath, updated.artworkPath);
  const reopened = new MusicStore(database);
  assert.equal(reopened.getTrack(track.id).artworkPath, updated.artworkPath);
  reopened.close();
});

test('같은 이름 후보는 무손실을 우선하며 낮거나 미상인 비트레이트도 허용한다', () => {
  const flac = { format: 'FLAC', lossless: true, bitDepth: 16, sampleRate: 44_100 };
  const alac = { format: 'ALAC', lossless: true, bitDepth: 24, sampleRate: 96_000 };
  const mp3 = { format: 'MP3', lossless: false, bitrate: 320_000 };
  const lowMp3 = { format: 'MP3', lossless: false, bitrate: 256_000 };
  assert.ok(qualityRank(alac) > qualityRank(flac));
  assert.ok(qualityRank(flac) > qualityRank(mp3));
  assert.equal(qualityRank(lowMp3), 256_000);
  assert.equal(qualityRank({ format: 'AAC', lossless: false, bitrate: 128_000 }), 128_000);
  assert.equal(qualityRank({ format: 'AAC', lossless: false, bitrate: null }), 0);
  assert.ok(qualityRank(mp3) > qualityRank(lowMp3));
  assert.equal(qualityLabel(mp3), 'MP3 320 kbps');
});

test('관심 단계·소장 자동 연결·대기열 저장·재시작·감상 이력', async context => {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-listening-'));
  const database = join(root, 'test.sqlite');
  const store = new MusicStore(database);
  context.after(() => store.close());
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store });
  await library.init();
  let interest = store.saveInterest({ title: 'Afterglow', artist: 'Mina Vale' });
  assert.equal(interest.stage, 'discovered');
  interest = store.saveInterest({ ...interest, stage: 'listening' }, interest.id);
  assert.equal(interest.stage, 'listening');
  interest = store.saveInterest({ ...interest, stage: 'planned' }, interest.id);
  assert.equal(interest.stage, 'planned');
  assert.throws(() => store.saveInterest({ ...interest, stage: 'owned' }, interest.id), /가져오세요/);
  assert.throws(() => store.saveInterest({ ...interest, stage: 'invalid' }), /확인/);
  const staged = await library.stage(Readable.from(syntheticFlac()), 'Afterglow.flac');
  const track = await library.commit(staged.importId);
  interest = store.listInterests()[0];
  assert.equal(interest.stage, 'owned');
  assert.equal(interest.trackId, track.id);
  assert.ok(store.listTracks()[0].albumId);
  assert.ok(store.listTracks()[0].artistId);
  const queue = store.saveQueue({ name: '밤의 음악', trackIds: [track.id, track.id] });
  assert.deepEqual(queue.trackIds, [track.id, track.id]);
  assert.throws(() => store.saveQueue({ name: '빈 목록', trackIds: [] }), /유효한/);
  assert.throws(() => store.saveQueue({ name: '없는 곡', trackIds: [999] }), /유효한/);
  store.recordPlayback(track.id, 1000, true);
  assert.equal(store.getTrack(track.id).playCount, 0);
  assert.equal(store.getTrack(track.id).lastPlayedAt, null);
  store.recordPlayback(track.id, 30000, false);
  assert.equal(store.getTrack(track.id).playCount, 1);
  assert.ok(store.getTrack(track.id).lastPlayedAt);
  const reopened = new MusicStore(database);
  assert.deepEqual(reopened.listQueues()[0], queue);
  assert.deepEqual(reopened.listInterests()[0], interest);
  assert.equal(reopened.exportCollection().queues.length, 1);
  assert.equal(reopened.exportCollection().interests.length, 1);
  reopened.close();
});

async function moveFixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-move-'));
  const source = join(root, 'source');
  await mkdir(source);
  const store = new MusicStore(join(root, 'test.sqlite'));
  context.after(() => store.close());
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store });
  await library.init();
  const audio = join(source, 'Afterglow.flac');
  const lrc = join(source, 'Afterglow.lrc');
  await writeFile(audio, syntheticFlac());
  await writeFile(lrc, '\ufeff[00:01.00]가사를 보관합니다\r\n');
  return { root, source, store, library, audio, lrc, importer: new LocalImport(library) };
}

test('로컬 음원·LRC는 보관본 검증 후 이동되며 내장 표지와 가사 원본 바이트를 보존한다', async context => {
  const f = await moveFixture(context);
  const audioBytes = await readFile(f.audio), lrcBytes = await readFile(f.lrc);
  const result = await f.importer.stage([f.source]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.report.lrcCount, 1);
  await access(f.audio); await access(f.lrc); // preparation never deletes originals
  const track = await f.importer.commit(result.selected[0].staged.importId, {});
  assert.equal(track.moveWarnings.length, 0);
  assert.equal(track.moved.length, 2);
  await assert.rejects(access(f.audio), { code: 'ENOENT' });
  await assert.rejects(access(f.lrc), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.library.resolveManagedPath(track.managedPath)), audioBytes);
  assert.deepEqual(await readFile(f.library.resolveManagedPath(track.lyricsFilePath)), lrcBytes);
  await access(f.library.resolveManagedPath(track.artworkPath));
  await access(f.source); // original folders are never deleted
});

test('경로 이동도 낮거나 미상인 AAC 비트레이트를 제외하지 않고 원본 바이트를 보존한다', async context => {
  for (const bitrate of [128_000, null]) {
    const f = await moveFixture(context);
    const audioBytes = await readFile(f.audio), lrcBytes = await readFile(f.lrc);
    // Isolate candidate selection from parsing with real staged file storage.
    const stage = f.library.stage.bind(f.library);
    f.library.stage = async (...args) => {
      const result = await stage(...args);
      Object.assign(result.metadata, { format: 'AAC', lossless: false, bitrate });
      return result;
    };
    const { selected, report } = await f.importer.stage([f.source]);
    assert.equal(selected.length, 1);
    assert.deepEqual(report.excluded, []);
    await access(f.audio); await access(f.lrc);
    const track = await f.importer.commit(selected[0].staged.importId, {});
    assert.deepEqual(await readFile(f.library.resolveManagedPath(track.managedPath)), audioBytes);
    assert.deepEqual(await readFile(f.library.resolveManagedPath(track.lyricsFilePath)), lrcBytes);
    await assert.rejects(access(f.audio), { code: 'ENOENT' });
  }
});

test('원본 변경·취소·중복 파일은 원래 위치에 남긴다', async context => {
  const f = await moveFixture(context);
  let result = await f.importer.stage([f.audio]);
  await writeFile(f.audio, Buffer.concat([syntheticFlac(), Buffer.from([1])]));
  await assert.rejects(f.importer.commit(result.selected[0].staged.importId, {}), /변경/);
  await access(f.audio); await access(f.lrc);
  await f.library.discard(result.selected[0].staged.importId);
  await access(f.audio);
  result = await f.importer.stage([f.audio]);
  await f.importer.commit(result.selected[0].staged.importId, {});
  await writeFile(f.audio, Buffer.concat([syntheticFlac(), Buffer.from([1])]));
  result = await f.importer.stage([f.audio]);
  assert.equal(result.report.duplicates, 1);
  assert.equal(result.selected.length, 0);
  await access(f.audio);
});

test('이름이 다른 LRC를 직접 연결하며 변경된 가사는 이동을 중단한다', async context => {
  const f = await moveFixture(context);
  const other = join(f.source, '번역 포함.lrc');
  await writeFile(other, '[00:01]직접 선택한 가사');
  const result = await f.importer.stage([f.audio]);
  const id = result.selected[0].staged.importId;
  const lyrics = await f.importer.attachLyrics(id, other);
  assert.equal(lyrics.lrcSourceName, '번역 포함.lrc');
  await writeFile(other, '[00:02]다른 가사로 수정');
  await assert.rejects(f.importer.commit(id, {}), /변경/);
  await access(f.audio); await access(other);
  await f.importer.attachLyrics(id, other);
  const track = await f.importer.commit(id, {});
  assert.equal(track.lyricsOriginal, '[00:02]다른 가사로 수정');
  await access(f.lrc); // replaced automatic association was not moved
  await assert.rejects(access(other), { code: 'ENOENT' });
});

test('저장 실패·심볼릭 링크·라이브러리 재가져오기는 원본 삭제로 이어지지 않는다', async context => {
  const f = await moveFixture(context);
  await assert.rejects(f.importer.stage([f.library.rootPath]), /라이브러리/);
  const link = join(f.source, 'link.flac');
  await symlink(f.audio, link);
  await assert.rejects(f.importer.stage([link]), /일반 파일/);
  const result = await f.importer.stage([f.source]);
  const save = f.store.saveImportedTrack;
  f.store.saveImportedTrack = () => { throw new Error('저장 실패'); };
  await assert.rejects(f.importer.commit(result.selected[0].staged.importId, {}), /저장 실패/);
  await access(f.audio); await access(f.lrc);
  f.store.saveImportedTrack = save;
  const track = await f.importer.commit(result.selected[0].staged.importId, {});
  assert.equal(track.moved.length, 2);
});

test('가사 연결을 해제하면 가사는 원래 위치에 남기고 음원만 이동한다', async context => {
  const f = await moveFixture(context);
  const { selected } = await f.importer.stage([f.audio]);
  const id = selected[0].staged.importId;
  const result = await f.importer.attachLyrics(id, null);
  assert.equal(result.lrcPath, '');
  const track = await f.importer.commit(id, {});
  assert.equal(track.moved.length, 1);
  assert.equal(track.lyricsOriginal, '');
  await access(f.lrc);
});
