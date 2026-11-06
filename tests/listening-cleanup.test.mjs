import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MusicStore } from '../src/store.mjs';
import { MusicLibrary } from '../src/library.mjs';
import { syntheticFlac } from './fixtures.mjs';
import { artistName, albumName, metadataText } from '../public/metadata-display.js';

test('미상값은 정확한 대체 문자열만 표시에서 비우고 실제 Unknown 이름은 보존', () => {
  for (const value of [null, undefined, '', '  ', '알 수 없는 아티스트']) assert.equal(artistName(value), '');
  assert.equal(albumName('알 수 없는 앨범'), '');
  for (const value of ['Unknown', 'Unknown Artist', '알 수 없는 아티스트의 노래']) assert.equal(artistName(value), value);
  assert.equal(metadataText({ artist: null, album: 'Unknown Album' }), 'Unknown Album');
  assert.equal(metadataText({ artist: '알 수 없는 아티스트', album: '알 수 없는 앨범' }), '');
  assert.equal(metadataText({ artist: '이름', album: null }), '이름');
});

test('곡명 수정은 title/갱신시각만 바꾸며 음원·표지·가사·기록·중복·재열기 보존', async t => {
  const root = await mkdtemp(join(tmpdir(), 'soriseojae-title-')), path = join(root, 'test.sqlite');
  let store = new MusicStore(path); t.after(() => store.db.close());
  const library = new MusicLibrary({ rootPath: join(root, 'library'), store }); await library.init();
  const bytes = syntheticFlac(), staged = await library.stage(Readable.from(bytes), 'original.flac');
  const track = await library.commit(staged.importId, { lrcText: '[00:00]보존', lrcSourceName: 'original.lrc' });
  store.updateNotes(track.id, { lyricsOriginal: '[00:00]기록 가사', lyricsTranslation: '번역', meaning: '의미', favoriteReason: '이유', memory: '추억', isLifeSong: true });
  store.db.prepare("UPDATE tracks SET updated_at='2000-01-01 00:00:00' WHERE id=?").run(track.id);
  const before = store.getTrack(track.id), files = await Promise.all([before.managedPath, before.artworkPath, before.lyricsFilePath].map(file => readFile(join(root, 'library', file))));
  for (const value of ['', '  ', null, 123, 'x'.repeat(301)]) assert.throws(() => store.updateTitle(track.id, value));
  assert.equal(store.updateTitle(99999, '없는 곡'), null);
  const result = store.updateTitle(track.id, '  새 이름 <안전한 텍스트>  ');
  assert.equal(result.title, '새 이름 <안전한 텍스트>');
  let after = store.getTrack(track.id);
  const omit = ({ title, updated_at, ...rest }) => rest;
  assert.deepEqual(omit(after), omit(before)); assert.notEqual(after.updated_at, before.updated_at);
  assert.equal(store.exportCollection().tracks.find(row => row.id === track.id).title, result.title);
  assert.equal(store.updateTitle(track.id, result.title).title, result.title);
  store.db.close(); store = new MusicStore(path); after = store.getTrack(track.id); assert.equal(after.title, result.title);
  assert.deepEqual(await Promise.all([after.managedPath, after.artworkPath, after.lyricsFilePath].map(file => readFile(join(root, 'library', file)))), files);
});
