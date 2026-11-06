import { isWithin as inside } from './path-safety.mjs';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { SUPPORTED_AUDIO_EXTENSIONS, qualityRank } from './audio-metadata.mjs';

const MAX_LRC = 2 * 1024 * 1024;
const stem = path => basename(path, extname(path)).normalize('NFC').toLowerCase()
  .replace(/^\d{1,3}(?:-\d{1,3})?[\s._-]+/, '')
  .replace(/[\s._-]*(?:\(?(?:flac|alac|lossless|320k|320kbps|无损|极高音质)\)?)$/i, '').trim();
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Only paths explicitly submitted by the local user are scanned. Symlinks are rejected.
export class LocalImport {
  constructor(library) { this.library = library; }
  async safePath(value) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('전체 파일 경로를 입력해 주세요.');
    const path = resolve(value);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('일반 파일 또는 폴더만 선택할 수 있습니다.');
    const canonical = await realpath(path);
    const libraryRoot = await realpath(this.library.rootPath);
    if (inside(canonical, libraryRoot) || inside(libraryRoot, canonical) || canonical === homedir() || canonical === parse(canonical).root) {
      throw new Error('라이브러리·홈 전체 대신 가져올 음악 전용 폴더를 선택해 주세요.');
    }
    return { path: canonical, info };
  }
  async source(path) {
    const { path: canonical, info } = await this.safePath(path);
    if (!info.isFile()) throw new Error('파일을 선택해 주세요.');
    return { path: canonical, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, checksum: await checksum(canonical) };
  }
  async assertUnchanged(source) {
    const info = await lstat(source.path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(source.path) !== source.path
      || info.dev !== source.dev || info.ino !== source.ino || info.size !== source.size || info.mtimeMs !== source.mtimeMs
      || await checksum(source.path) !== source.checksum) throw new Error('준비 후 원본 파일이 변경되어 원래 위치에 남겼습니다. 다시 선택해 주세요.');
  }
  async stage(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) throw new Error('음악 폴더나 파일 경로를 한 줄에 하나씩 입력하세요.');
    const files = new Set();
    let visited = 0;
    const walk = async (path, depth = 0) => {
      if (++visited > 10000 || depth > 16) throw new Error('범위가 너무 넓습니다. 더 작은 음악 폴더를 선택해 주세요.');
      const item = await this.safePath(path);
      if (item.info.isDirectory()) {
        for (const child of await readdir(item.path, { withFileTypes: true })) {
          if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
          if (child.isDirectory() || SUPPORTED_AUDIO_EXTENSIONS.has(extname(child.name).toLowerCase()) || extname(child.name).toLowerCase() === '.lrc') await walk(join(item.path, child.name), depth + 1);
        }
      } else files.add(item.path);
    };
    for (const path of paths) await walk(path);
    const audio = [...files].filter(path => SUPPORTED_AUDIO_EXTENSIONS.has(extname(path).toLowerCase()));
    if (!audio.length || audio.length > 500) throw new Error('한 번에 음원 1~500개가 있는 폴더를 선택해 주세요.');
    // Single-file selection also discovers same-directory LRC files.
    for (const dir of new Set(audio.map(dirname))) {
      for (const file of await readdir(dir, { withFileTypes: true })) if (file.isFile() && extname(file.name).toLowerCase() === '.lrc') files.add(join(dir, file.name));
    }
    const report = { duplicates: 0, errors: [], alternatives: 0, lrcCount: 0, excluded: [] };
    const groups = new Map();
    const seenChecksums = new Set();
    for (const path of audio) {
      let staged;
      try {
        const source = await this.source(path);
        if (seenChecksums.has(source.checksum)) { report.duplicates++; report.excluded.push(`${basename(path)}: 이번 선택에 포함된 동일 파일`); continue; }
        staged = await this.library.stage(createReadStream(path), basename(path));
        if (staged.checksum !== source.checksum) throw new Error('분석 중 원본이 변경되었습니다.');
        this.library.staged.get(staged.importId).source = source;
        const key = dirname(path) + '/' + stem(path);
        const row = { staged, file: { name: basename(path) }, sourcePath: path, move: true, lrcText: '', lrcSourceName: '' };
        groups.set(key, [...(groups.get(key) || []), row]);
        seenChecksums.add(source.checksum);
      } catch (error) {
        if (staged) await this.library.discard(staged.importId);
        if (error.name === 'DuplicateFileError') { report.duplicates++; report.excluded.push(`${basename(path)}: 이미 소장한 동일 파일`); }
        else report.errors.push(`${basename(path)}: ${error.message}`);
      }
    }
    const selected = [];
    for (const rows of groups.values()) {
      rows.sort((a,b) => qualityRank(b.staged.metadata) - qualityRank(a.staged.metadata));
      const preferred = rows[0];
      for (const row of rows.slice(1)) { report.excluded.push(`${row.file.name}: 더 높은 음질의 같은 이름 후보 선택`); await this.library.discard(row.staged.importId); report.alternatives++; }
      const matches = [...files].filter(path => extname(path).toLowerCase() === '.lrc' && dirname(path) === dirname(preferred.sourcePath)
        && (stem(path) === stem(preferred.sourcePath) || stem(path) === stem(preferred.staged.metadata.title + '.lrc')));
      if (matches.length === 1) {
        try { Object.assign(preferred, await this.attachLyrics(preferred.staged.importId, matches[0])); report.lrcCount++; }
        catch (error) { report.errors.push(`${basename(matches[0])}: ${error.message}`); }
      }
      selected.push(preferred);
    }
    return { selected, report };
  }
  async attachLyrics(importId, path) {
    const staged = this.library.staged.get(importId);
    if (!staged?.source) throw new Error('이동 준비 중인 음원을 먼저 선택해 주세요.');
    if (path === null) {
      delete staged.lyricSource; delete staged.lyricBytes;
      staged.localLyrics = { lrcText: '', lrcSourceName: '' };
      return { ...staged.localLyrics, lrcPath: '' };
    }
    if (extname(path).toLowerCase() !== '.lrc') throw new Error('LRC 가사 파일을 선택해 주세요.');
    const source = await this.source(path);
    if (source.size > MAX_LRC) throw new Error('LRC는 2 MB 이하만 지원합니다.');
    const bytes = await readFile(source.path);
    // Fatal decode avoids silently corrupting a legacy-encoded lyric file.
    let lrcText;
    try { lrcText = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('가사 파일을 UTF-8 인코딩으로 저장한 뒤 다시 연결해 주세요.'); }
    if (!lrcText.trim()) throw new Error('가사 파일이 비어 있습니다.');
    if (createHash('sha256').update(bytes).digest('hex') !== source.checksum) throw new Error('가사 파일이 변경되었습니다.');
    staged.lyricSource = source;
    staged.lyricBytes = bytes;
    staged.localLyrics = { lrcText, lrcSourceName: basename(path) };
    return { ...staged.localLyrics, lrcPath: source.path };
  }
  async commit(importId, edits) {
    const staged = this.library.staged.get(importId);
    if (!staged?.source) throw new Error('이동할 원본을 다시 선택해 주세요.');
    await this.assertUnchanged(staged.source);
    if (staged.lyricSource) await this.assertUnchanged(staged.lyricSource);
    const track = await this.library.commit(importId, { ...edits, ...staged.localLyrics });
    const warnings = [];
    const moved = [];
    for (const [source, managed] of [[staged.source, track.managedPath], [staged.lyricSource, track.lyricsFilePath]]) {
      if (!source) continue;
      try {
        if (!managed || await checksum(this.library.resolveManagedPath(managed)) !== source.checksum) throw new Error('보관본 검증 실패');
        await this.assertUnchanged(source);
        await unlink(source.path);
        moved.push(source.path);
      } catch (error) { warnings.push(`${basename(source.path)}: 소장은 완료했지만 원본은 남겼습니다 (${error.message}).`); }
    }
    return { ...track, moved, moveWarnings: warnings };
  }
}
