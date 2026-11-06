import { isWithin as inside } from './path-safety.mjs';
import { createReadStream, watch } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { SUPPORTED_AUDIO_EXTENSIONS } from './audio-metadata.mjs';
import { DuplicateFileError } from './library.mjs';

const signature = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// An opt-in inbox, separate from managed music. Move mode cleans up only
// after database registration and independent verification of both copies.
export class AutoImportInbox {
  constructor({ library, directory, statePath, mode = 'copy', settleMs = 8000, intervalMs = 60000, now = Date.now, onChange = () => {}, createDirectory = true }) {
    if (!['copy', 'move'].includes(mode)) throw new Error('자동 추가 방식은 copy 또는 move여야 합니다.');
    Object.assign(this, { library, directory: resolve(directory), statePath, mode, settleMs, intervalMs, now, onChange, createDirectory });
    this.observed = new Map();
    this.failures = new Map();
    this.records = {};
    this.revision = 0;
    this.error = '';
    this.stopping = false;
    this.recentResults = [];
    this.resultsDirty = false;
    this.metrics = { scans: 0, fileVisits: 0 };
    this.pendingFiles = 0;
    this.processing = '';
  }

  async init() {
    const managed = await realpath(this.library.rootPath);
    if (inside(this.directory, managed) || inside(managed, this.directory) || this.directory === homedir() || this.directory === parse(this.directory).root) {
      throw new Error('자동 추가에는 음악 보관 폴더와 다른 전용 폴더를 선택해 주세요.');
    }
    if (this.createDirectory) await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink()) throw new Error('자동 추가 폴더는 바로가기가 아닌 실제 폴더여야 합니다.');
    if (!info.isDirectory()) throw new Error('음악을 가져올 폴더를 선택해 주세요.');
    // Canonicalize system aliases such as macOS /var → /private/var.
    this.directory = await realpath(this.directory);
    if ((await lstat(dirname(this.directory))).dev !== info.dev) throw new Error('디스크 전체 대신 디스크 안의 전용 음악 폴더를 선택해 주세요.');
    if (inside(this.directory, managed) || inside(managed, this.directory) || this.directory === await realpath(homedir()) || this.directory === parse(this.directory).root) {
      throw new Error('자동 추가에는 음악 보관 폴더와 다른 전용 폴더를 선택해 주세요.');
    }
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (saved.directory === this.directory) { this.records = saved.records || {}; this.recentResults = (saved.recentResults || []).slice(0, 20); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  status() {
    const summary = { added: 0, duplicate: 0, unsupported: 0, failed: 0 };
    for (const result of this.recentResults) { if (result.status === 'partial') summary.failed++; else if (result.status in summary) summary[result.status]++; }
    return { enabled: true, directory: this.directory, mode: this.mode, revision: this.revision, error: this.error, importedFiles: Object.keys(this.records).length, pendingFiles: this.pendingFiles, processing: this.processing, summary, recentResults: this.recentResults }; 
  }

  start() {
    this.timer = setInterval(() => { void this.scan(); }, this.intervalMs);
    this.timer.unref();
    try {
      this.watcher = watch(this.directory, { recursive: true }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { void this.scan(); }, 250);
        this.debounce.unref();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      this.watcher.unref();
    } catch { /* Reconcile on the periodic scan when filesystem watching is unavailable. */ }
    void this.scan();
  }

  settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { void this.scan(); }, this.settleMs + 100);
    this.settleTimer.unref();
  }

  report(path, status, message = '') {
    const name = relative(this.directory, path);
    const previous = this.recentResults.find(row => row.name === name);
    if (previous?.status === status && previous.message === message) return;
    this.resultsDirty = true;
    this.recentResults = [{ name, status, message }, ...this.recentResults.filter(row => row.name !== name)].slice(0, 20);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    clearTimeout(this.settleTimer);
    this.watcher?.close();
    await this.running;
  }

  async scan() {
    if (this.stopping) return;
    if (this.running) return this.running;
    this.running = this.scanFiles().catch(error => { this.error = error.message; }).finally(() => {
      this.running = null;
      if (!this.stopping && this.pendingFiles) this.settle();
    });
    return this.running;
  }

  async collectFiles() {
    this.metrics.scans++;
    let rootInfo;
    try { rootInfo = await lstat(this.directory); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('감지 폴더를 찾지 못했습니다. 디스크를 다시 연결한 뒤 ‘다시 확인’을 누르거나 폴더를 변경해 주세요.');
      throw error;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(this.directory) !== this.directory) throw new Error('자동 추가 폴더가 변경되었습니다.');
    const files = new Map();
    let visited = 0;
    const walk = async (directory, depth = 0) => {
      if (depth > 8) throw new Error('하위 폴더는 8단계까지 확인합니다. 더 안쪽의 음악 폴더를 지정해 주세요.');
      for (const item of await readdir(directory, { withFileTypes: true })) {
        this.metrics.fileVisits++;
        if (++visited > 10000) throw new Error('자동 추가 폴더는 10,000개 항목까지 확인합니다. 더 작은 음악 폴더를 지정해 주세요.');
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const path = join(directory, item.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || await realpath(path) !== path) continue;
        if (info.isDirectory()) await walk(path, depth + 1);
        else if (info.isFile() && info.size && (SUPPORTED_AUDIO_EXTENSIONS.has(extname(path).toLowerCase()) || extname(path).toLowerCase() === '.lrc')) {
          files.set(path, { stamp: signature(info), info });
        } else if (info.isFile() && /\.(wav|aiff?|ape|mflac|qmc\w*)$/i.test(path)) this.report(path, 'unsupported', '지원하는 형식은 FLAC·ALAC·M4A·MP3·AAC·Ogg입니다.');
      }
    };
    await walk(this.directory);
    return files;
  }

  async scanFiles() {
    const files = await this.collectFiles();
    this.pendingFiles = 0;
    this.error = '';
    const now = this.now();
    for (const [path, file] of files) {
      const previous = this.observed.get(path);
      this.observed.set(path, { stamp: file.stamp, since: previous?.stamp === file.stamp ? previous.since : now,
        retryAfter: previous?.stamp === file.stamp ? previous.retryAfter : 0 });
    }
    for (const path of this.observed.keys()) if (!files.has(path)) { this.observed.delete(path); this.failures.delete(path); }
    const candidates = new Map([...files].filter(([path]) => SUPPORTED_AUDIO_EXTENSIONS.has(extname(path).toLowerCase())));
    if (this.mode === 'move') {
      // Audio may already have moved when QM Unlock finishes fetching its LRC.
      for (const [key, record] of Object.entries(this.records)) {
        const path = resolve(this.directory, key);
        if (!inside(path, this.directory) || !SUPPORTED_AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) continue;
        const lyricPath = path.slice(0, -extname(path).length) + '.lrc';
        if (!files.has(path) && files.has(lyricPath)) candidates.set(path, { stamp: record.stamp, absent: true });
      }
    }
    for (const [path, file] of candidates) {
      if (this.stopping) break;
      const key = relative(this.directory, path);
      const lyricPath = path.slice(0, -extname(path).length) + '.lrc';
      const lyric = files.get(lyricPath);
      const lyricObserved = this.observed.get(lyricPath);
      const observed = this.observed.get(path) || lyricObserved;
      if (!file.absent && now - observed.since < this.settleMs || lyricObserved && now - lyricObserved.since < this.settleMs) { this.pendingFiles++; continue; }
      const record = this.records[key];
      const needsMove = this.mode === 'move' && (!file.absent || lyric && !record?.lyricMoved);
      if (record?.stamp === file.stamp && (!lyric || record.lyricStamp === lyric.stamp) && !needsMove) continue;
      // Back off failed files until changed, or retry after one minute.
      if (Math.min(observed.retryAfter || 0, lyricObserved?.retryAfter ?? observed.retryAfter ?? 0) > now) continue;
      let staged;
      this.processing = key;
      try {
        let lyrics = '';
        let lyricBytes;
        let lyricError = '';
        if (lyric) {
          try {
            if (lyric.info.size > 2 * 1024 * 1024) throw new Error('LRC 파일은 2 MB 이하여야 합니다.');
            lyricBytes = await readFile(lyricPath);
            lyrics = new TextDecoder('utf-8', { fatal: true }).decode(lyricBytes);
            if (!lyrics.trim()) throw new Error('LRC 가사 파일이 비어 있습니다.');
            if (signature(await lstat(lyricPath)) !== lyric.stamp) continue;
          } catch (error) { lyricError = '가사 연결 실패: ' + error.message; lyrics = ''; lyricBytes = undefined; }
        }
        let track;
        let owned = record?.stamp === file.stamp && record.owned || false;
        if (record?.stamp === file.stamp) track = this.library.store.getTrack(record.trackId);
        if (file.absent && !track) throw new Error('보관된 음원을 찾지 못해 가사를 원래 위치에 남겼습니다.');
        if (!track) {
          try {
            staged = await this.library.stage(createReadStream(path), basename(path));
          } catch (error) {
            if (!(error instanceof DuplicateFileError)) throw error;
            track = this.library.store.getTrack(error.existingTrack.id);
          }
          if (signature(await lstat(path)) !== file.stamp || await realpath(path) !== path) {
            if (staged) await this.library.discard(staged.importId);
            continue;
          }
          if (staged) {
            if (lyricBytes) this.library.staged.get(staged.importId).lyricBytes = lyricBytes;
            track = await this.library.commit(staged.importId, { lrcText: lyrics, lrcSourceName: lyrics ? basename(lyricPath) : '' });
            owned = true;
            this.changed();
          }
        }
        // A sidecar can arrive after audio. Never replace the user's edited lyrics.
        if ((owned || this.mode === 'move') && lyrics && !track.lyricsOriginal && !track.lyricsLrc) {
          if (await this.library.attachAutomaticLyrics(track.id, lyrics, basename(lyricPath), lyricBytes)) {
            track = this.library.store.getTrack(track.id);
            this.changed();
          }
        }
        const next = { stamp: file.stamp, trackId: track.id, owned, lyricStamp: lyricError ? '' : lyric?.stamp || '', audioMoved: Boolean(file.absent), lyricMoved: !lyric };
        this.records[key] = next;
        // Persist recovery information before removing any source file.
        try { await this.persist(); }
        catch (error) {
          if (record) this.records[key] = record;
          else delete this.records[key];
          throw error;
        }
        if (lyricError) throw new Error((this.mode === 'move' ? '보관 완료·이동 미완료. ' : '음악 보관 완료. ') + lyricError);
        if (this.mode === 'move') {
          const moves = [];
          if (!file.absent) moves.push({ path, stamp: file.stamp, managed: track.managedPath, checksum: track.checksum, field: 'audioMoved' });
          if (lyric) moves.push({ path: lyricPath, stamp: lyric.stamp, managed: track.lyricsFilePath, field: 'lyricMoved' });
          // A mismatching sidecar or missing/corrupt managed file preserves inputs.
          for (const move of moves) await this.verifyMove(move);
          for (const move of moves) {
            await this.assertSource(move.path, move.stamp);
            await unlink(move.path);
            next[move.field] = true;
          }
          await this.persist();
        }
        this.failures.delete(path);
        this.report(path, owned ? 'added' : 'duplicate');
      } catch (error) {
        if (staged) await this.library.discard(staged.importId).catch(() => {});
        observed.retryAfter = now + 60000;
        if (lyricObserved) lyricObserved.retryAfter = now + 60000;
        this.failures.set(path, `${basename(path)}: ${error.message}`);
        this.report(path, this.records[key]?.trackId ? 'partial' : 'failed', error.message);
      } finally { this.processing = ''; }
    }
    this.error = [...this.failures.values()].join('\n').slice(0, 2000);
    if (this.resultsDirty) await this.persist();
  }

  changed() {
    this.revision++;
    this.onChange();
  }

  async assertSource(path, stamp) {
    const info = await lstat(path);
    if (!inside(path, this.directory) || !info.isFile() || info.isSymbolicLink() || signature(info) !== stamp || await realpath(path) !== path) {
      throw new Error('준비 후 파일이 변경되어 원래 위치에 남겼습니다.');
    }
  }

  async verifyMove(move) {
    await this.assertSource(move.path, move.stamp);
    if (!move.managed) throw new Error('일치하는 보관본이 없어 원래 위치에 남겼습니다.');
    const destination = this.library.resolveManagedPath(move.managed);
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(destination) !== destination) throw new Error('보관본을 확인하지 못해 원래 위치에 남겼습니다.');
    const [sourceHash, managedHash] = await Promise.all([checksum(move.path), checksum(destination)]);
    if (sourceHash !== managedHash || move.checksum && sourceHash !== move.checksum) throw new Error('보관본 체크섬이 달라 원래 위치에 남겼습니다.');
    await this.assertSource(move.path, move.stamp);
  }

  async persist() {
    const temporary = this.statePath + '.tmp';
    await writeFile(temporary, JSON.stringify({ directory: this.directory, records: this.records, recentResults: this.recentResults }, null, 2));
    await rename(temporary, this.statePath);
    this.resultsDirty = false;
  }
}

export class AutoImportControl {
  constructor({ library, dataRoot, inboxOptions = {} }) {
    Object.assign(this, { library, dataRoot, inboxOptions });
    this.config = { enabled: false, directory: join(dataRoot, 'Auto Import'), mode: 'copy' };
    this.inbox = null;
    this.revision = 0;
    this.error = '';
    this.changes = Promise.resolve();
    this.configured = false;
  }

  async init() {
    try { this.config = { ...this.config, ...JSON.parse(await readFile(join(this.dataRoot, 'auto-import.json'), 'utf8')) }; this.configured = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.config.enabled) {
      this.inbox = await this.prepare();
      this.inbox.start();
    }
  }

  async prepare(config = this.config, createDirectory = !this.configured && config.directory === join(this.dataRoot, 'Auto Import')) {
    if (typeof config.directory !== 'string' || !isAbsolute(config.directory)) throw new Error('자동 추가 폴더의 전체 경로가 필요합니다.');
    const inbox = new AutoImportInbox({ ...this.inboxOptions, library: this.library, directory: config.directory, mode: config.mode || 'copy', createDirectory,
      statePath: join(this.dataRoot, 'auto-import-state.json'), onChange: () => { this.revision++; } });
    await inbox.init();
    return inbox;
  }

  status() {
    const current = this.inbox?.status() || this.lastStatus || {};
    return { ...current, configured: this.configured, enabled: Boolean(this.config.enabled), directory: this.config.directory,
      mode: this.config.mode || 'copy', revision: this.revision, error: this.error || current.error || '' };
  }

  async preview(directory) {
    const candidate = await this.prepare({ ...this.config, directory }, false);
    const files = await candidate.collectFiles();
    const audio = [...files].filter(([path]) => SUPPORTED_AUDIO_EXTENSIONS.has(extname(path).toLowerCase()));
    return { directory: candidate.directory, fileCount: audio.length, totalBytes: audio.reduce((sum, [, file]) => sum + file.info.size, 0), includesSubfolders: true };
  }

  setEnabled(enabled) { return this.configure({ enabled }); }

  configure(values, force = false) {
    const change = this.changes.then(async () => {
      if (this.closed) throw new Error('음악 서재를 종료하는 중입니다.');
      const config = { ...this.config, ...values };
      if (typeof config.enabled !== 'boolean' || !['copy', 'move'].includes(config.mode)) throw new Error('자동 추가 설정을 확인해 주세요.');
      if (!force && config.enabled === this.config.enabled && config.directory === this.config.directory && config.mode === this.config.mode) return this.status();
      const candidate = config.enabled || values.directory !== undefined ? await this.prepare(config) : null;
      const previous = this.inbox;
      if (candidate) config.directory = candidate.directory;
      const path = join(this.dataRoot, 'auto-import.json');
      // Persist before draining so disabling is durable while the current file finishes.
      await writeFile(path + '.tmp', JSON.stringify(config, null, 2) + '\n');
      await rename(path + '.tmp', path);
      const sameDirectory = config.directory === this.config.directory;
      this.config = config;
      this.configured = true;
      await previous?.stop();
      if (candidate && sameDirectory && previous) {
        candidate.records = previous.records;
        candidate.recentResults = previous.recentResults;
      }
      this.lastStatus = sameDirectory ? previous?.status() || this.lastStatus : null;
      this.inbox = config.enabled ? candidate : null;
      if (this.inbox) this.inbox.start();
      this.error = '';
      return this.status();
    });
    this.changes = change.catch(() => {});
    return change;
  }

  async retryFailed() {
    await this.changes;
    if (!this.config.enabled) return this.status();
    await this.configure({}, true);
    for (const observed of this.inbox.observed.values()) observed.retryAfter = 0;
    await this.inbox.scan();
    return this.status();
  }

  async stop() {
    this.closed = true;
    await this.changes;
    await this.inbox?.stop();
  }
}

export async function openAutoImportInbox(options) {
  const control = new AutoImportControl(options);
  try { await control.init(); }
  catch (error) {
    control.error = error.message;
    console.error('자동 추가를 시작하지 못했습니다:', error.message);
  }
  return control;
}
