import { isWithin } from './path-safety.mjs';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MusicStore, PlaylistError } from './store.mjs';
import { LocalImport } from './local-import.mjs';
import { randomUUID } from 'node:crypto';
import { DuplicateFileError, MusicLibrary } from './library.mjs';
import { openAutoImportInbox } from './auto-import.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, '..');
const publicRoot = join(projectRoot, 'public');
const dataRoot = resolve(process.env.SORISEOJAE_DATA_DIR || join(projectRoot, 'data'));
const libraryRoot = join(dataRoot, 'library');
const port = Number(process.env.PORT || 4317);

await mkdir(dataRoot, { recursive: true });
const store = new MusicStore(join(dataRoot, 'soriseojae.sqlite'));
const library = new MusicLibrary({ rootPath: libraryRoot, store });
await library.init();
const localImport = new LocalImport(library);
const autoImport = await openAutoImportInbox({ library, dataRoot });
const localToken = randomUUID();
let localBusy = false;
// Retain outcomes in this server session so a lost response can be checked safely.
const importOutcomes = new Map();
async function commitImport(id, action) {
  const previous = importOutcomes.get(id);
  if (previous?.status === 'committed') return previous.track;
  if (previous?.status === 'processing') throw new Error('아직 보관 중입니다. 완료 여부를 다시 확인해 주세요.');
  importOutcomes.set(id, { status: 'processing' });
  try {
    const track = await action();
    importOutcomes.set(id, { status: 'committed', track });
    return track;
  } catch (error) {
    importOutcomes.delete(id);
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const path = url.pathname;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(request.headers.host) || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) return json(response, 403, { error: '로컬 앱에서만 요청할 수 있습니다.' });

    if (request.method === 'POST' && path.startsWith('/api/local-')) {
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '새로고침 후 다시 시도해 주세요.' });
      if (localBusy) return json(response, 409, { error: '다른 가져오기가 진행 중입니다. 잠시 후 다시 시도해 주세요.' });
      localBusy = true;
      try {
        const body = await readJson(request);
        if (path === '/api/local-stage') return json(response, 200, await localImport.stage(body.paths));
        if (path === '/api/local-lyrics') return json(response, 200, await localImport.attachLyrics(body.importId, body.path));
        if (path === '/api/local-commit' && body.confirmMove === true) return json(response, 201, await commitImport(body.importId, () => localImport.commit(body.importId, body.metadata)));
        return json(response, 400, { error: '이동 확인이 필요합니다.' });
      } catch (error) { return json(response, 400, { error: error.message }); }
      finally { localBusy = false; }
    }

    if (request.method === 'GET' && path === '/api/health') {
      return json(response, 200, { app: 'cove', libraryRoot });
    }

    if (request.method === 'GET' && path === '/api/auto-import') {
      return json(response, 200, autoImport?.status() || { enabled: false, revision: 0 });
    }

    if (request.method === 'PUT' && path === '/api/auto-import') {
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '새로고침 후 다시 시도해 주세요.' });
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || ('enabled' in body && typeof body.enabled !== 'boolean') || ('directory' in body && typeof body.directory !== 'string') || ('mode' in body && !['copy', 'move'].includes(body.mode))) return json(response, 400, { error: '자동 추가 설정을 확인해 주세요.' });
      try { return json(response, 200, await autoImport.configure(Object.fromEntries(Object.entries(body).filter(([key]) => ['enabled', 'directory', 'mode'].includes(key))))); }
      catch (error) { return json(response, 400, { error: error.message }); }
    }

    if (request.method === 'POST' && ['/api/auto-import/preview', '/api/auto-import/retry'].includes(path)) {
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '설정을 다시 열어 주세요.' });
      try {
        const body = await readJson(request);
        return json(response, 200, path.endsWith('/preview') ? await autoImport.preview(body?.directory) : await autoImport.retryFailed());
      } catch (error) { return json(response, 400, { error: error.message }); }
    }

    if (request.method === 'GET' && path === '/api/state') {
      return json(response, 200, { tracks: store.listTracks(), recentListening: store.recentListening(), stats: store.stats(), libraryRoot, queues: store.listQueues(), playlists: store.listPlaylists(), localToken });
    }

    const playlistMatch = path.match(/^\/api\/playlists(?:\/(\d+))?$/);
    if (playlistMatch) {
      const id = playlistMatch[1] ? Number(playlistMatch[1]) : null;
      if (request.method === 'GET') return json(response, 200, id ? store.getPlaylist(id) : store.listPlaylists());
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '새로고침 후 다시 시도해 주세요.' });
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(response, 400, { error: '목록 변경 내용을 확인해 주세요.' });
      if (!id && request.method === 'POST') return json(response, 201, store.createPlaylist(body.name));
      if (id && request.method === 'PATCH') return json(response, 200, store.updatePlaylist(id, body));
      if (id && request.method === 'DELETE') return json(response, 200, store.deletePlaylist(id, body.revision));
      return json(response, 405, { error: '지원하지 않는 요청입니다.' });
    }

    const importStatus = path.match(/^\/api\/imports\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'GET' && importStatus) {
      const known = importOutcomes.get(importStatus[1]);
      if (known) return json(response, 200, known);
      if (library.staged.has(importStatus[1])) return json(response, 200, { status: 'ready' });
      const checksum = url.searchParams.get('checksum');
      const existing = /^[a-f0-9]{64}$/.test(checksum || '') ? store.findByChecksum(checksum) : null;
      return json(response, 200, existing ? { status: 'committed', track: store.getTrack(existing.id), recovered: true } : { status: 'missing' });
    }

    if (request.method === 'POST' && path === '/api/queues') {
      try { return json(response, 201, store.saveQueue(await readJson(request))); }
      catch (error) { return json(response, 400, { error: error.message }); }
    }

    if (request.method === 'POST' && path === '/api/stage') {
      const encodedName = request.headers['x-file-name'];
      if (!encodedName) return json(response, 400, { error: '파일 이름이 필요합니다.' });
      const originalName = decodeURIComponent(String(encodedName));
      const staged = await library.stage(request, originalName);
      return json(response, 201, staged);
    }

    if (request.method === 'POST' && path === '/api/commit') {
      const body = await readJson(request);
      if (library.staged.get(body.importId)?.source) return json(response, 400, { error: '이동 준비 파일은 이동 확인 버튼으로 소장해 주세요.' });
      const track = await commitImport(body.importId, () => library.commit(body.importId, body.metadata));
      return json(response, 201, track);
    }

    if (request.method === 'POST' && path === '/api/discard') {
      const body = await readJson(request);
      const discarded = await library.discard(body.importId);
      return json(response, 200, { discarded });
    }

    const trackMatch = path.match(/^\/api\/tracks\/(\d+)$/);
    if (request.method === 'GET' && trackMatch) {
      const track = store.getTrack(Number(trackMatch[1]));
      return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
    }

    if (request.method === 'DELETE' && trackMatch) {
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '새로고침 후 다시 시도해 주세요.' });
      const body = await readJson(request);
      if (body.confirmDeleteFile !== true) return json(response, 400, { error: '음원 파일 삭제 확인이 필요합니다.' });
      try {
        const result = await library.deleteTrack(Number(trackMatch[1]));
        return result ? json(response, 200, result) : json(response, 404, { error: '이미 삭제되었거나 찾을 수 없는 곡입니다.' });
      } catch (error) { return json(response, 400, { error: error.message || '삭제하지 못했습니다.' }); }
    }

    const infoMatch = path.match(/^\/api\/tracks\/(\d+)\/info$/);
    if (request.method === 'PUT' && infoMatch) {
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '새로고침 후 다시 시도해 주세요.' });
      try {
        const track = await library.saveTrackInfo(Number(infoMatch[1]), await readJson(request, 16 * 1024 * 1024));
        return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
      } catch (error) { return json(response, 400, { error: error.message || '곡 정보를 저장하지 못했습니다.' }); }
    }

    const titleMatch = path.match(/^\/api\/tracks\/(\d+)\/title$/);
    if (request.method === 'PUT' && titleMatch) {
      if (request.headers['x-local-token'] !== localToken) return json(response, 403, { error: '새로고침 후 다시 시도해 주세요.' });
      try {
        const body = await readJson(request);
        const track = store.updateTitle(Number(titleMatch[1]), body.title);
        return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }

    const noteMatch = path.match(/^\/api\/tracks\/(\d+)\/notes$/);
    if (request.method === 'PUT' && noteMatch) {
      const track = store.updateNotes(Number(noteMatch[1]), await readJson(request));
      return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
    }

    const commentMatch = path.match(/^\/api\/tracks\/(\d+)\/comments$/);
    if (request.method === 'PUT' && commentMatch) {
      try {
        const { comment } = await readJson(request);
        const track = store.updateComments(Number(commentMatch[1]), comment);
        return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }

    const favoriteMatch = path.match(/^\/api\/tracks\/(\d+)\/favorite$/);
    if (request.method === 'PUT' && favoriteMatch) {
      try {
        const { isLifeSong } = await readJson(request);
        const track = store.updateFavorite(Number(favoriteMatch[1]), isLifeSong);
        return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }

    const playbackMatch = path.match(/^\/api\/tracks\/(\d+)\/playback$/);
    if (request.method === 'POST' && playbackMatch) {
      const body = await readJson(request);
      const track = store.recordPlayback(Number(playbackMatch[1]), Number(body.listenedMs || 0), Boolean(body.completed));
      return track ? json(response, 200, track) : json(response, 404, { error: '곡을 찾을 수 없습니다.' });
    }

    const audioMatch = path.match(/^\/api\/tracks\/(\d+)\/audio$/);
    if (request.method === 'GET' && audioMatch) {
      const track = store.getTrack(Number(audioMatch[1]));
      if (!track) return json(response, 404, { error: '곡을 찾을 수 없습니다.' });
      return streamAudio(request, response, await library.describeFile(track));
    }

    const artworkMatch = path.match(/^\/api\/tracks\/(\d+)\/artwork$/);
    if (request.method === 'PUT' && artworkMatch) {
      const id = Number(artworkMatch[1]);
      if (!store.getTrack(id)) return json(response, 404, { error: '곡을 찾을 수 없습니다.' });
      try {
        return json(response, 200, await library.saveArtwork(id, request));
      } catch (error) {
        return json(response, 400, { error: error.message || '사진을 저장하지 못했습니다.' });
      }
    }
    if (request.method === 'GET' && artworkMatch) {
      const track = store.getTrack(Number(artworkMatch[1]));
      if (!track?.artworkPath) return empty(response, 404);
      const artworkPath = library.resolveManagedPath(track.artworkPath);
      const artworkExtension = extname(artworkPath).toLowerCase();
      const type = artworkExtension === '.png' ? 'image/png' : artworkExtension === '.webp' ? 'image/webp' : 'image/jpeg';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
      pipeFile(artworkPath, response);
      return;
    }

    if (request.method === 'GET' && path === '/api/export') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="soriseojae-collection.json"'
      });
      response.end(JSON.stringify(store.exportCollection(), null, 2));
      return;
    }

    if (request.method === 'GET' && !path.startsWith('/api/')) return serveStatic(path, response);
    return json(response, 404, { error: '요청한 기능을 찾을 수 없습니다.' });
  } catch (error) {
    if (error instanceof PlaylistError) return json(response, error.status, { error: error.message, code: error.code, current: error.current });
    if (error instanceof DuplicateFileError) {
      return json(response, 409, { error: error.message, existingTrack: error.existingTrack });
    }
    console.error(error);
    return json(response, 500, { error: error.message || '처리 중 오류가 발생했습니다.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`소리서재 프로토타입: http://127.0.0.1:${port}`);
  console.log(`라이브러리: ${libraryRoot}`);
  process.parentPort?.postMessage({ type: 'ready', port, libraryRoot });
});

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function empty(response, status) {
  response.writeHead(status);
  response.end();
}

async function readJson(request, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('요청 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function streamAudio(request, response, file) {
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { 'Content-Type': audioMime(file.path), 'Content-Length': file.size, 'Accept-Ranges': 'bytes' });
    pipeFile(file.path, response);
    return;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return empty(response, 416);
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= file.size) return empty(response, 416);
  response.writeHead(206, {
    'Content-Type': audioMime(file.path), 'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Accept-Ranges': 'bytes'
  });
  pipeFile(file.path, response, { start, end });
}

function pipeFile(path, response, options) {
  void pipeline(createReadStream(path, options), response).catch(error => {
    if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ABORT_ERR'].includes(error.code)) console.error('음원/사진 읽기 실패:', error);
  });
}

function audioMime(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.flac') return 'audio/flac';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.ogg') return 'audio/ogg';
  return 'audio/mp4';
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolute = resolve(publicRoot, requested);
  if (!isWithin(absolute, publicRoot)) return empty(response, 403);
  try {
    const fileStat = await stat(absolute);
    if (!fileStat.isFile()) return empty(response, 404);
    const content = await readFile(absolute);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    response.writeHead(200, { 'Content-Type': types[extname(absolute)] || 'application/octet-stream' });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return empty(response, 404);
    throw error;
  }
}

async function shutdown() {
  await autoImport?.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.parentPort?.on('message', ({ data }) => {
  if (data?.type === 'shutdown') shutdown();
});
