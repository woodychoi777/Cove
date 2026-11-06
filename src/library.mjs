import { isWithin } from './path-safety.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { analyzeAudioFile, SUPPORTED_AUDIO_EXTENSIONS } from './audio-metadata.mjs';

const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

export function artworkExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('JPG, PNG 또는 WebP 사진을 선택해 주세요.');
}

export class DuplicateFileError extends Error {
  constructor(existingTrack) {
    super('이미 소장한 동일한 파일입니다.');
    this.name = 'DuplicateFileError';
    this.existingTrack = existingTrack;
  }
}

export class MusicLibrary {
  constructor({ rootPath, store }) {
    this.rootPath = resolve(rootPath);
    this.musicPath = join(this.rootPath, '음악');
    this.incomingPath = join(this.rootPath, '.incoming');
    this.store = store;
    this.staged = new Map();
  }

  async init() {
    await mkdir(this.musicPath, { recursive: true });
    await mkdir(this.incomingPath, { recursive: true });
    // macOS /tmp and /var are system aliases. Compare managed descendants
    // against the canonical root, while still rejecting links inside it.
    this.rootPath = await realpath(this.rootPath);
    this.musicPath = join(this.rootPath, '음악');
    this.incomingPath = join(this.rootPath, '.incoming');
    const stale = await readdir(this.incomingPath, { withFileTypes: true });
    await Promise.all(stale.filter((entry) => entry.isFile()).map((entry) => rm(join(this.incomingPath, entry.name), { force: true })));
  }

  async stage(readable, originalName) {
    const extension = extname(originalName).toLowerCase();
    if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
      throw new Error('FLAC, ALAC/M4A, MP3, AAC, OGG 파일을 선택해 주세요.');
    }

    const importId = randomUUID();
    const tempPath = join(this.incomingPath, `${importId}.part`);
    const output = createWriteStream(tempPath, { flags: 'wx' });
    const hash = createHash('sha256');
    let fileSize = 0;

    try {
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        fileSize += chunk.length;
        if (fileSize > MAX_IMPORT_BYTES) return callback(new Error('파일이 프로토타입의 4 GB 제한을 넘었습니다.'));
        hash.update(chunk);
        callback(null, chunk);
      } });
      // pipeline observes destination errors immediately, including ENOSPC
      // while waiting for the next source chunk, and propagates backpressure.
      await pipeline(readable, meter, output);
    } catch (error) {
      output.destroy();
      await rm(tempPath, { force: true });
      throw error;
    }

    const checksum = hash.digest('hex');
    const duplicate = this.store.findByChecksum(checksum);
    if (duplicate) {
      await rm(tempPath, { force: true });
      throw new DuplicateFileError(duplicate);
    }

    let parsed;
    try {
      parsed = await analyzeAudioFile(tempPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }

    const fallbackTitle = basename(originalName, extension).replace(/^\d{1,3}(?:-\d{1,3})?\s*[-_.]\s*/, '');
    const staged = {
      importId, tempPath, originalName, fileSize, checksum,
      metadata: {
        title: parsed.title || fallbackTitle || '제목 없음',
        artist: parsed.artist || '알 수 없는 아티스트',
        album: parsed.album || '알 수 없는 앨범',
        year: parsed.year,
        genre: parsed.genre || '',
        trackNumber: parsed.trackNumber,
        discNumber: parsed.discNumber,
        durationMs: parsed.durationMs,
        sampleRate: parsed.sampleRate,
        bitDepth: parsed.bitDepth,
        channels: parsed.channels,
        bitrate: parsed.bitrate,
        format: parsed.format,
        lossless: parsed.lossless
      },
      artwork: parsed.artwork
    };
    this.staged.set(importId, staged);
    return { importId, originalName, fileSize, checksum, metadata: staged.metadata, hasArtwork: Boolean(staged.artwork) };
  }

  async commit(importId, edits = {}) {
    const staged = this.staged.get(importId);
    if (!staged) throw new Error('가져오기 준비 파일을 찾을 수 없습니다. 다시 선택해 주세요.');

    const metadata = {
      ...staged.metadata,
      title: requiredText(edits.title ?? staged.metadata.title, '곡명'),
      artist: requiredText(edits.artist ?? staged.metadata.artist, '아티스트'),
      album: requiredText(edits.album ?? staged.metadata.album, '앨범'),
      year: nullableInteger(edits.year ?? staged.metadata.year),
      genre: String(edits.genre ?? staged.metadata.genre ?? '').trim(),
      trackNumber: nullableInteger(edits.trackNumber ?? staged.metadata.trackNumber),
      discNumber: nullableInteger(edits.discNumber ?? staged.metadata.discNumber),
      lrcText: String(edits.lrcText ?? ''),
      lrcSourceName: String(edits.lrcSourceName ?? '').trim()
    };

    const artistFolder = safeSegment(metadata.artist);
    const albumPrefix = metadata.year ? `${metadata.year} - ` : '';
    const albumFolder = safeSegment(`${albumPrefix}${metadata.album}`);
    const destinationDirectory = join(this.musicPath, artistFolder, albumFolder);
    await mkdir(destinationDirectory, { recursive: true });

    const discPrefix = metadata.discNumber && metadata.discNumber > 1 ? `${metadata.discNumber}-` : '';
    const trackPrefix = metadata.trackNumber ? `${discPrefix}${String(metadata.trackNumber).padStart(2, '0')} - ` : '';
    const destinationExtension = staged.metadata.format === 'FLAC' ? '.flac'
      : staged.metadata.format === 'ALAC' || staged.metadata.format === 'AAC' ? '.m4a'
        : staged.metadata.format === 'VORBIS' || staged.metadata.format === 'OPUS' ? '.ogg' : '.mp3';
    const desiredName = `${trackPrefix}${safeSegment(metadata.title)}${destinationExtension}`;
    const destinationPath = await availablePath(destinationDirectory, desiredName);
    await rename(staged.tempPath, destinationPath);

    let artworkPath = null;
    let lrcPath = null;
    let absoluteLrcPath = null;
    let lrcCreated = false;
    try {
      const verification = await hashFile(destinationPath);
      if (verification !== staged.checksum) throw new Error('복사본 체크섬이 원본과 일치하지 않습니다.');

      if (staged.artwork?.data) {
        const artworkExtension = staged.artwork.mime === 'image/png' ? 'png' : staged.artwork.mime === 'image/webp' ? 'webp' : 'jpg';
        const absoluteArtworkPath = join(destinationDirectory, `cover.${artworkExtension}`);
        try {
          await writeFile(absoluteArtworkPath, staged.artwork.data, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          artworkPath = relative(this.rootPath, absoluteArtworkPath);
        } catch { /* Artwork failure must not fail audio preservation. */ }
      }

      if (metadata.lrcText) {
        absoluteLrcPath = join(destinationDirectory, `${basename(destinationPath, extname(destinationPath))}.lrc`);
        await writeFile(absoluteLrcPath, staged.lyricBytes || metadata.lrcText, { encoding: 'utf8', flag: 'wx' });
        lrcCreated = true;
        lrcPath = relative(this.rootPath, absoluteLrcPath);
      }

      const track = this.store.saveImportedTrack({
        ...metadata,
        artworkPath,
        lrcPath,
        managedPath: relative(this.rootPath, destinationPath),
        originalName: staged.originalName,
        format: staged.metadata.format,
        fileSize: staged.fileSize,
        checksum: staged.checksum,
        bitrate: staged.metadata.bitrate,
        lossless: staged.metadata.lossless
      });
      this.staged.delete(importId);
      return track;
    } catch (error) {
      await rename(destinationPath, staged.tempPath).catch(() => {});
      if (lrcCreated) await rm(absoluteLrcPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async discard(importId) {
    const staged = this.staged.get(importId);
    if (!staged) return false;
    await rm(staged.tempPath, { force: true });
    this.staged.delete(importId);
    return true;
  }

  async attachAutomaticLyrics(id, text, sourceName, bytes = text) {
    const track = this.store.getTrack(id);
    if (!track || track.lyricsOriginal || track.lyricsLrc) return false;
    const path = join(dirname(this.resolveManagedPath(track.managedPath)), `${basename(track.managedPath, extname(track.managedPath))}-lyrics-${randomUUID()}.lrc`);
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx' });
    try {
      if (this.store.attachAutomaticLyrics(id, { text, sourceName, path: relative(this.rootPath, path) })) return true;
      await rm(path, { force: true });
      return false;
    } catch (error) { await rm(path, { force: true }); throw error; }
  }

  async saveArtwork(id, readable) {
    const track = this.store.getTrack(id);
    if (!track) throw new Error('곡을 찾을 수 없습니다.');
    const chunks = [];
    let size = 0;
    for await (const chunk of readable) {
      size += chunk.length;
      if (size > MAX_ARTWORK_BYTES) throw new Error('앨범 사진은 10 MB 이하로 선택해 주세요.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const extension = artworkExtension(bytes);
    const directory = dirname(this.resolveManagedPath(track.managedPath));
    const path = join(directory, `cover-manual-${randomUUID()}.${extension}`);
    await writeFile(path, bytes, { flag: 'wx' });
    try {
      return this.store.updateArtwork(id, relative(this.rootPath, path));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async saveTrackInfo(id, body) {
    const track = this.store.getTrack(id);
    if (!track) return null;
    let path;
    try {
      if (body?.artwork !== undefined) {
        const encoded = body.artwork;
        if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_ARTWORK_BYTES / 3) * 4 || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('앨범 사진을 다시 선택해 주세요.');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw new Error('앨범 사진을 다시 선택해 주세요.');
        if (bytes.length > MAX_ARTWORK_BYTES) throw new Error('앨범 사진은 10 MB 이하로 선택해 주세요.');
        const extension = artworkExtension(bytes);
        path = join(dirname(this.resolveManagedPath(track.managedPath)), `cover-manual-${randomUUID()}.${extension}`);
        await writeFile(path, bytes, { flag: 'wx' });
      }
      const result = this.store.updateInfo(id, body?.changes, path ? relative(this.rootPath, path) : undefined);
      if (!result && path) await rm(path, { force: true });
      return result;
    } catch (error) {
      if (path) await rm(path, { force: true });
      throw error;
    }
  }

  async deleteTrack(id) {
    this.deleting ||= new Set();
    if (this.deleting.has(id)) throw new Error('삭제 중입니다.');
    const track = this.store.getTrack(id);
    if (!track) return null;
    this.deleting.add(id);
    let moved = false;
    const path = this.resolveManagedPath(track.managedPath);
    const temporary = `${path}.deleting-${randomUUID()}`;
    try {
      // Never follow a symlink outside the managed collection.
      try {
        const canonical = await realpath(path);
        if (canonical !== path || !(await stat(path)).isFile()) throw new Error('안전하게 삭제할 수 없는 파일 경로입니다.');
        await rename(path, temporary); moved = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { this.store.deleteTrack(id); }
      catch (error) { if (moved) await rename(temporary, path); throw error; }
      let cleanupPending = false;
      if (moved) try { await rm(temporary); } catch { cleanupPending = true; }
      return { deleted: true, cleanupPending };
    } finally { this.deleting.delete(id); }
  }

  resolveManagedPath(managedPath) {
    const absolute = resolve(this.rootPath, managedPath);
    if (!isWithin(absolute, this.rootPath)) throw new Error('잘못된 파일 경로입니다.');
    return absolute;
  }

  async describeFile(track) {
    const path = this.resolveManagedPath(track.managedPath);
    const info = await stat(path);
    return { path, size: info.size };
  }
}

export function safeSegment(value) {
  const cleaned = String(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '제목 없음')
    .replace(/[. ]+$/, '');
  // Leave room for track/disc prefixes, collision suffixes, and sidecar extensions.
  // Count UTF-8 bytes without splitting a Korean character or an emoji.
  let segment = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(segment + character, 'utf8') > 180) break;
    segment += character;
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) segment = '_' + segment;
  return segment || '제목 없음';
}

async function availablePath(directory, desiredName) {
  const extension = extname(desiredName);
  const stem = basename(desiredName, extension);
  for (let index = 1; index < 10_000; index += 1) {
    const name = index === 1 ? desiredName : `${stem} (${index})${extension}`;
    const candidate = join(directory, name);
    try {
      await stat(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('사용할 수 있는 파일명을 만들 수 없습니다.');
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label}을 입력해 주세요.`);
  return text;
}

function nullableInteger(value) {
  if (value === '' || value == null) return null;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
