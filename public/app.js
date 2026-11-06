import { buildLyrics, activeLyricIndex } from './lyrics.js';
import { QueuePlayer } from './player.js';
import { albumTracks, playDisplayedList } from './listening.js';
import { setupListeningUI } from './listening-ui.js';
import { TrackDrafts } from './drafts.js';
import { setupComments } from './comments.js';
import { setupTheme } from './theme.js';
import { setupAlarmUI } from './alarm-ui.js';
import { setupPlaybackControls } from './playback-controls.js';
import { setupAutoImportSettings } from './auto-import-settings.js';
import { setupFocusVisibility } from './focus-visibility.js';
import { mainScroller, contentPosition, scrollContent } from './scroll.js';
import { longTrackLabel, artistName, albumName, joined, metadataText } from './metadata-display.js';
import { setupTrackEditor } from './track-editor.js';
import { setupPlaylists } from './playlists.js';
import { icon, hydrateIcons } from './icons.js';
import { openDialog, setupDialog, bindMenus, bindContextMenus, closeMenus, retainFocus, bindRowPlayback } from './ui.js';

const state = { tracks: [], stats: {}, libraryRoot: '', staged: [], selectedTrack: null, importedTracks: [], importReport: null };
state.appMode = 'listen';
state.route = 'home';
let lyricsView;
let artworkEditor;
let detailModes;
let listeningUI;
let playlists;
let queueRestored = false;
let detailRequest = 0;
let followingRequest = false;
let followTarget = null;
let previewDetail = false;
let stateRequest = 0;
let displayedTracks = [];
let detailOrigin = null;
const drafts = new TrackDrafts(['lyricsOriginal', 'lyricsTranslation']);
let comments;
let trackEditor;
let alarmUI;
const savesInFlight = new Set();
const favoritesInFlight = new Set();
let autoImportEnabled = false;
const autoImportSettings = setupAutoImportSettings({ getToken: () => state.localToken, onStatus: status => { autoImportEnabled = status.enabled; } });
hydrateIcons();
document.querySelectorAll('dialog').forEach(setupDialog);
document.querySelector('#settings-open').addEventListener('click', event => { openDialog(document.querySelector('#settings-dialog'), event.currentTarget); void autoImportSettings.refresh(); });
const settingsDialog = document.querySelector('#settings-dialog');
let settingsBackdropDown = false;
const outsideSettings = event => {
  const box = settingsDialog.getBoundingClientRect();
  return event.target === settingsDialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
};
settingsDialog.addEventListener('pointerdown', event => { settingsBackdropDown = outsideSettings(event); });
settingsDialog.addEventListener('click', event => {
  if (settingsBackdropDown && outsideSettings(event)) settingsDialog.requestClose();
  settingsBackdropDown = false;
});
settingsDialog.addEventListener('close', () => { settingsBackdropDown = false; });
setupTheme(document.querySelector('#theme-setting'));
setupFocusVisibility();
const player = new QueuePlayer({ persist: value => { try { localStorage.setItem('soriseojae.queue', JSON.stringify(value)); } catch {} } });
let observedTrackId = player.trackId;
player.addEventListener('change', () => {
  if (observedTrackId === player.trackId) return;
  observedTrackId = player.trackId;
  previewDetail = false;
  cancelDetailFollow();
  if (isLyricsListening()) detailRequest += 1;
  followTarget = isLyricsListening() ? player.trackId : null;
  followPlayingTrack();
});
// Only overlay/focus transitions retry a deferred switch, never playback ticks.
document.addEventListener('beforetoggle', event => {
  if (event.newState === 'open') cancelDetailFollow();
}, true);
for (const eventName of ['toggle', 'close', 'focusout']) {
  document.addEventListener(eventName, () => queueMicrotask(followPlayingTrack), true);
}
player.addEventListener('error', event => showToast(event.detail));
player.addEventListener('listened', event => {
  recordPlayback(event.detail.id, event.detail.listenedMs, event.detail.completed).catch(() => showToast('감상 이력을 저장하지 못했습니다.'));
});
window.addEventListener('pagehide', () => player.stop(true));
window.addEventListener('beforeunload', event => {
  if (alarmUI?.hasUnsaved() || drafts.size || comments?.hasUnsaved() || trackEditor?.hasUnsaved() || playlists?.hasUnsaved() || state.importBusy || state.staged.length) {
    event.preventDefault(); event.returnValue = '';
  }
});

const views = [...document.querySelectorAll('[data-view]')];
const navButtons = [...document.querySelectorAll('.nav-button[data-route]')];
const importError = document.querySelector('#import-error');
let toastTimer;

document.querySelectorAll('button[data-route]').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.route));
});
document.querySelector('[data-detail-back]').addEventListener('click', () => {
  detailModes?.capture();
  navigate(detailOrigin?.route || 'library', { restore: detailOrigin });
});

document.querySelector('#search-input').addEventListener('input', renderLibrary);
document.querySelector('#choose-folder').addEventListener('click', () => document.querySelector('#folder-input').click());
document.querySelector('#choose-files').addEventListener('click', () => document.querySelector('#file-input').click());
document.querySelector('#file-input').addEventListener('change', (event) => {
  const files = [...event.target.files]; event.target.value = '';
  if (files.length) stageSelection(files);
});
document.querySelector('#folder-input').addEventListener('change', (event) => {
  const files = [...event.target.files]; event.target.value = '';
  if (files.length) stageSelection(files);
});

const dropZone = document.querySelector('#drop-zone');
for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); });
}
dropZone.addEventListener('drop', (event) => {
  if (event.dataTransfer.files.length) stageSelection([...event.dataTransfer.files]);
});

document.querySelector('#batch-form').addEventListener('submit', commitBatchImport);
document.querySelector('#cancel-import').addEventListener('click', resetImport);
document.querySelector('#import-another').addEventListener('click', resetImport);
document.querySelector('#open-imported').addEventListener('click', () => navigate('library'));
document.querySelector('#play-imported').addEventListener('click', () => playList(state.importedTracks, '추가한 곡'));
document.querySelector('#review-failed').addEventListener('click', reviewFailedImports);

listeningUI = setupListeningUI({ player, state, openTrack, playList, refresh: refreshState, toast: showToast, escapeHtml, formatTime, coverMarkup });
comments = setupComments({ getTrack: id => state.selectedTrack?.id === id ? state.selectedTrack : state.tracks.find(track => track.id === id), toast: showToast, onSaved: result => {
  stateRequest += 1;
  const fields = Object.fromEntries(['meaning', 'favoriteReason', 'memory'].map(key => [key, result[key]]));
  const track = state.tracks.find(track => track.id === result.id);
  if (track) Object.assign(track, fields);
  if (state.selectedTrack?.id === result.id) Object.assign(state.selectedTrack, fields);
  refreshState().catch(() => {});
} });
trackEditor = setupTrackEditor({ getToken: () => state.localToken, toast: showToast, onDelete: openDeleteTrack, onSaved: result => {
  stateRequest += 1;
  const info = Object.fromEntries(['title', 'artist', 'artistId', 'lyricsOriginal', 'lyricsTranslation', 'artworkPath'].map(key => [key, result[key]]));
  const track = state.tracks.find(track => track.id === result.id);
  if (track) Object.assign(track, info);
  if (state.selectedTrack?.id === result.id) {
    Object.assign(state.selectedTrack, info);
    document.querySelector('[data-detail-title]').textContent = result.title;
    const artist = document.querySelector('[data-detail-artist]');
    artist.textContent = artistName(result.artist); artist.hidden = !artistName(result.artist);
    document.querySelector('[data-detail-cover]').innerHTML = coverMarkup(result);
    const lyrics = { lyricsOriginal: result.lyricsOriginal, lyricsTranslation: result.lyricsTranslation };
    drafts.update(result.id, lyrics, lyrics);
    for (const key of Object.keys(lyrics)) document.querySelector(`#notes-form [name="${key}"]`).value = lyrics[key];
    detailModes?.syncDraft(); lyricsView?.refreshArtwork();
  }
  renderAll();
  refreshState().catch(() => {});
} });
playlists = setupPlaylists({ state, render: renderLibrary, navigate, invalidate: () => { stateRequest += 1; }, toast: showToast, esc: escapeHtml, cover: coverMarkup });
placeHeaderTools('home');
setAppMode(state.appMode);
await refreshState();
alarmUI = setupAlarmUI({ player, state, openTrack, toast: showToast });
setupPlaybackControls({ player, openTrack,
  leaveLyrics: () => document.querySelector('[data-detail-back]').click(),
  selectList: index => {
    detailModes?.capture();
    if (!playlists.selectIndex(index)) return;
    navigate('library');
    document.querySelector('#main-content').focus({ preventScroll: true });
  },
  alarmActive: () => alarmUI?.session?.mode === 'alarm'
});

let autoImportRevision = 0;
let checkingAutoImport = false;
async function syncAutoImport() {
  if (!autoImportEnabled || document.hidden || checkingAutoImport || drafts.size || comments?.hasUnsaved() || trackEditor?.hasUnsaved() || playlists?.hasUnsaved()
      || state.importBusy || state.staged.length || savesInFlight.size || favoritesInFlight.size
      || document.querySelector('dialog[open], [popover]:popover-open') || document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;
  checkingAutoImport = true;
  try {
    const response = await fetch('/api/auto-import');
    if (!response.ok) return;
    const status = await response.json();
    if (!status.enabled || status.revision === autoImportRevision) return;
    const position = contentPosition();
    await refreshState();
    scrollContent(position);
    autoImportRevision = status.revision;
  } catch { /* Retry when the local library reconnects. */ }
  finally { checkingAutoImport = false; }
}
setInterval(syncAutoImport, 5000);
window.addEventListener('focus', syncAutoImport);
window.addEventListener('cove-service-reconnected', async () => {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) return;
    const data = await response.json();
    // Refresh authorization without reloading or replacing unsaved editor fields.
    state.localToken = data.localToken;
    await autoImportSettings.refresh();
    autoImportRevision = -1;
    await syncAutoImport();
    showToast('음악 서재에 다시 연결했습니다.');
  } catch { showToast('음악 서재 연결을 다시 확인해 주세요.'); }
});

function setAppMode(mode, { preview = false } = {}) {
  cancelDetailFollow();
  detailRequest += 1;
  followTarget = null;
  previewDetail = preview;
  state.appMode = mode === 'edit' ? 'edit' : 'listen';
  const editing = state.appMode === 'edit';
  document.body.dataset.appMode = state.appMode;
  detailModes?.setMode(state.appMode);
  renderHome();
  if (!editing && !preview && isLyricsListening()) {
    followTarget = player.trackId;
    followPlayingTrack();
  }
}

async function refreshState() {
  const request = ++stateRequest;
  const stateRequestedAt = Date.now();
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('컬렉션을 읽지 못했습니다.');
  const data = await response.json();
  if (request !== stateRequest) return;
  state.tracks = data.tracks;
  state.stats = data.stats;
  state.libraryRoot = data.libraryRoot;
  state.queues = data.queues || [];
  state.playlists = data.playlists || [];
  state.recentListening = data.recentListening || [];
  state.localToken = data.localToken;
  player.tracks = state.tracks;
  if (!queueRestored) {
    queueRestored = true;
    try {
      const saved = JSON.parse(localStorage.getItem('soriseojae.queue') || 'null');
      if (saved && Array.isArray(saved.ids)) {
        player.restore(saved);
      }
    } catch {}
  }
  renderAll({ stateRequestedAt });
}

function syncListeningShell() {
  const listening = state.route === 'detail' && state.appMode === 'listen';
  document.body.classList.toggle('is-listening', listening);
  const sidebar = document.querySelector('.sidebar');
  sidebar.hidden = listening;
  sidebar.inert = listening;
}

function navigate(route, { restore = null } = {}) {
  listeningUI?.closeQueue();
  if (!['home', 'library', 'import', 'detail'].includes(route)) { route = 'library'; restore = null; }
  if (route !== 'detail' && state.appMode === 'edit') setAppMode('listen', { preview: true });
  if (route === 'detail' && state.route !== 'detail') {
    let focused = document.activeElement;
    const menu = focused.closest?.('.song-menu');
    if (menu) focused = document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`) || focused;
    const row = focused.closest?.('[data-current-id]');
    detailOrigin = { route: state.route, ...contentPosition(), focused,
      selector: focused.id ? `#${CSS.escape(focused.id)}` : row ? `[data-current-id="${row.dataset.currentId}"] ${focused.matches('[data-more]') ? '[data-more]' : '[data-row-play]'}` : null };
    document.querySelector('[data-detail-back-label]').textContent = { home: 'Today', library: 'Collection' }[state.route] || 'Collection';
  }
  if (route !== 'detail') { cancelDetailFollow(); detailRequest += 1; followTarget = null; }
  state.route = route;
  closeMenus();
  document.querySelector('#settings-dialog').close();
  document.body.dataset.route = route;
  placeHeaderTools(route);
  views.forEach((view) => view.classList.toggle('is-visible', view.dataset.view === route));
  syncListeningShell();
  navButtons.forEach(button => { button.classList.toggle('is-active', button.dataset.route === route); if (button.dataset.route === route) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (route === 'library') renderLibrary();
  if (route === 'home') { listeningUI?.activateHome(); renderHome(); refreshState().catch(() => showToast('감상 목록을 불러오지 못했습니다.')); }
  if (restore) {
    requestAnimationFrame(() => {
      if (state.route !== route) return;
      const visible = element => element?.isConnected && element.getClientRects().length && !element.closest('[hidden], [inert]');
      const replacement = restore.selector ? document.querySelector(`.view.is-visible ${restore.selector}`) : null;
      const target = visible(restore.focused) ? restore.focused : visible(replacement) ? replacement : document.querySelector(`.nav-button[data-route="${route}"]`);
      target?.focus({ preventScroll: true });
      scrollContent({ left: restore.left, top: restore.top });
    });
  } else {
    scrollContent({ left: 0, top: 0 });
    if (route === 'detail' && document.activeElement.closest?.('.view:not(.is-visible), .sidebar[hidden]')) document.querySelector('[data-detail-back]').focus({ preventScroll: true });
  }
  if (route === 'detail') lyricsView?.layout();
}

function placeHeaderTools() { /* Global actions stay in the sidebar. */ }

function renderAll(options = {}) {
  document.querySelector('#stat-track-count').textContent = `${state.stats.trackCount ?? 0}곡`;
  document.querySelector('#stat-size').textContent = formatBytes(state.stats.totalBytes ?? 0);
  document.querySelector('#stat-life-count').textContent = `${state.stats.lifeSongCount ?? 0}곡`;
  document.querySelector('#library-path').textContent = state.libraryRoot;
  document.querySelector('#import-library-path').textContent = state.libraryRoot;
  renderHome();
  renderLibrary();
  listeningUI?.render(options);
}

async function playTrack(id, seconds) {
  const track = state.tracks.find(item => item.id === id);
  if (!track) return;
  player.ensureContext();
  if (player.trackId !== id) {
    const album = albumTracks(state.tracks, track);
    player.setQueue(album.map(item => item.id), album.findIndex(item => item.id === id), `앨범 · ${track.album}`);
  }
  if (seconds !== undefined) await player.seek(seconds);
  await player.play();
}

function playList(tracks, source, startId = tracks[0]?.id, toggleCurrent = false, resumeCurrent = false) {
  return playDisplayedList(player, tracks, { source, startId, toggleCurrent, resumeCurrent });
}

function renderHome() {
  const empty = document.querySelector('#home-empty');
  const content = document.querySelector('#home-content');
  empty.hidden = state.tracks.length > 0;
  content.hidden = false;
}

const searchText = new WeakMap();
function renderLibrary() {
  const scope = playlists?.renderControls() || state.tracks;
  const playlist = playlists?.selected(), editing = playlists?.editing();
  const query = document.querySelector('#search-input').value.trim().toLocaleLowerCase('ko');
  const filtered = query ? scope.filter(track => {
    if (!searchText.has(track)) searchText.set(track, `${track.title} ${metadataText(track)}`.toLocaleLowerCase('ko'));
    return searchText.get(track).includes(query);
  }) : scope;
  displayedTracks = filtered;
  const root = document.querySelector('#library-grid');
  root.classList.toggle('is-playlist-editing', !!editing);
  const source = collectionSource();
  const restoreFocus = retainFocus(root);
  const markup = filtered.map(track => `<article class="collection-row" data-current-id="${track.id}">
    <button type="button" class="collection-play" data-row-play="${track.id}" ${editing || track.missing ? 'disabled' : ''} aria-label="${escapeHtml(joined(track.title, artistName(track.artist), longTrackLabel(track.durationMs)))} 듣기" title="${escapeHtml(joined(track.title, metadataText(track)))}"><span class="collection-song">${coverMarkup(track)}<span><strong class="collection-title"><span class="collection-title-text">${escapeHtml(track.title)}</span>${longTrackLabel(track.durationMs) ? `<span class="long-track-label">${longTrackLabel(track.durationMs)}</span>` : ''}</strong><small ${artistName(track.artist) ? '' : 'hidden'}>${escapeHtml(artistName(track.artist))}</small></span></span></button>
    ${editing ? playlists.rowActions(track.id) : `<div class="song-menu" popover="auto" id="more-${track.id}" aria-label="${escapeHtml(track.title)} 곡 메뉴">${track.missing ? '' : `<button data-row-next="${track.id}">다음에 듣기</button><button data-row-append="${track.id}">대기열 끝에 추가</button><button data-playlist-track="${track.id}">플레이리스트에 추가</button>`}${playlist ? `<button data-playlist-remove="${track.id}">이 플레이리스트에서 빼기</button>` : ''}</div>`}
  </article>`).join('');
  // A listening-history response must not detach an open row menu or its
  // focused action. Rebind only when the displayed content/source changes.
  const renderKey = `${source}\n${markup}`;
  if (root._renderKey !== renderKey) {
    root._renderKey = renderKey;
    root.innerHTML = markup;
    bindTrackButtons(root);
    if (!editing) bindRowPlayback(root, id => { if (!filtered.find(row => row.id === id)?.missing) playList(filtered.filter(row => !row.missing), source, id, false, true); });
    playlists?.bindRows(root);
    for (const [name, next] of [['next', true], ['append', false]]) root.querySelectorAll(`[data-row-${name}]`).forEach(button => button.addEventListener('click', () => {
      player.enqueue(Number(button.getAttribute(`data-row-${name}`)), next);
      showToast(next ? '다음 곡으로 추가했습니다.' : '대기열 끝에 추가했습니다.');
    }));
    bindContextMenus(root);
    restoreFocus();
  }
  syncTrackPlayback();
  document.querySelector('#collection-results').textContent = query ? `검색 결과 ${filtered.length}곡` : '';
  document.querySelector('#collection-results').hidden = !query;
  document.querySelector('#library-empty').hidden = filtered.length > 0;
  document.querySelector('#library-empty h2').textContent = query ? '검색 결과가 없습니다' : playlist ? '곡을 추가해 보세요' : '소장한 음악이 없습니다';
  document.querySelector('#library-empty p').hidden = !!playlist && !query;
  document.querySelector('#library-empty p').textContent = query ? '다른 곡명, 아티스트 또는 앨범명으로 검색해 보세요.' : '폴더나 파일에서 음악을 추가해 보세요.';
  document.querySelector('#clear-search').hidden = !query;
  document.querySelector('#library-empty-add').hidden = !!query || !!playlist;
}

document.querySelector('#clear-search').addEventListener('click', () => { const input = document.querySelector('#search-input'); input.value = ''; renderLibrary(); input.focus(); });

function collectionSource() { const name = playlists?.selected()?.name; return document.querySelector('#search-input').value.trim() ? `${name || 'Collection'} · 검색 결과` : name ? `플레이리스트 · ${name}` : 'Collection'; }

function coverMarkup(track) {
  return `<div class="cover ${track.artworkPath ? 'has-artwork' : ''}">${track.artworkPath ? `<img src="/api/tracks/${track.id}/artwork?v=${encodeURIComponent(track.artworkPath)}" alt="${escapeHtml(joined(albumName(track.album), '앨범 사진'))}">` : icon('disc')}</div>`;
}

function bindTrackButtons(container) {
  container.querySelectorAll('[data-open-track]').forEach((button) => button.addEventListener('click', () => openTrack(Number(button.dataset.openTrack))));
}

async function openTrack(id) {
  cancelDetailFollow();
  followTarget = null;
  previewDetail = false;
  const request = ++detailRequest;
  if (state.selectedTrack?.id === id && detailModes) {
    navigate('detail');
    lyricsView?.sync(true);
    return;
  }
  try {
    const response = await fetch(`/api/tracks/${id}`);
    if (!response.ok) throw new Error('곡을 불러오지 못했습니다.');
    const track = await response.json();
    track.title = state.tracks.find(item => item.id === id)?.title ?? track.title;
    if (request !== detailRequest) return;
    detailModes?.capture();
    if (state.appMode === 'edit') setAppMode('listen', { preview: true });
    state.selectedTrack = track;
    renderDetail();
    navigate('detail');
  } catch { if (request === detailRequest) showToast('곡을 불러오지 못했습니다. 다시 시도해 주세요.'); }
}

function isLyricsListening() {
  return state.route === 'detail' && state.appMode === 'listen' && Boolean(lyricsView);
}

function detailInteractionOpen() {
  return document.querySelector('dialog[open], .song-menu:popover-open, #comments-dialog:popover-open') ||
    document.activeElement?.matches('textarea, input:not([type="range"]):not([type="checkbox"]):not([type="button"]), [contenteditable="true"]');
}

function cancelDetailFollow() {
  if (!followingRequest) return;
  detailRequest += 1;
  followingRequest = false;
  const container = document.querySelector('#detail-content');
  container.removeAttribute('data-follow-pending');
  container.removeAttribute('aria-busy');
}

async function followPlayingTrack() {
  const id = followTarget;
  if (!id || !isLyricsListening() || detailInteractionOpen() || followingRequest) return;
  if (id === state.selectedTrack?.id) { followTarget = null; return; }
  const container = document.querySelector('#detail-content');
  const hadFocus = container.contains(document.activeElement);
  const focusAction = ['data-favorite', 'data-comments', 'data-edit-info'].find(name => document.activeElement?.hasAttribute(name));
  detailModes?.capture();
  const request = ++detailRequest;
  followingRequest = true;
  container.setAttribute('data-follow-pending', '');
  container.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/tracks/${id}`);
    if (!response.ok) throw new Error('곡을 불러오지 못했습니다.');
    const track = await response.json();
    if (request !== detailRequest) return;
    if (!isLyricsListening() || player.trackId !== id || detailInteractionOpen()) { cancelDetailFollow(); return; }
    const restoreFocus = container.contains(document.activeElement) || (hadFocus && document.activeElement === document.body);
    cancelDetailFollow();
    followTarget = null;
    track.title = state.tracks.find(item => item.id === id)?.title ?? track.title;
    detailModes?.capture();
    state.selectedTrack = track;
    renderDetail();
    if (restoreFocus) container.querySelector(focusAction ? `[${focusAction}]` : '[data-lyrics-lines]')?.focus({ preventScroll: true });
  } catch {
    if (request !== detailRequest) return;
    cancelDetailFollow();
    followTarget = null;
    showToast('곡을 불러오지 못했습니다. 다시 시도해 주세요.');
  }
}

function renderDetail() {
  const track = state.selectedTrack;
  const container = document.querySelector('#detail-content');
  artworkEditor?.destroy();
  lyricsView?.destroy();
  lyricsView = null;
  detailModes = null;
  container.innerHTML = `
    <p class="detail-draft" data-detail-draft role="status" hidden>저장하지 않은 변경사항</p>
    <div class="detail-stage">
    <div class="listening-backdrop" aria-hidden="true"></div>
    <div class="detail-hero">
      <div class="detail-artwork"><div data-detail-cover>${coverMarkup(track)}</div><button type="button" class="secondary-button artwork-open" data-artwork-open data-input-only hidden>${icon('image-plus')} 앨범 사진 ${track.artworkPath ? '변경' : '등록'}</button></div>
      <div class="detail-copy">
        <p ${albumName(track.album) || track.year ? '' : 'hidden'}>${escapeHtml(joined(albumName(track.album), track.year))}</p>
        <h1 data-detail-title>${escapeHtml(track.title)}</h1>
        <p><span class="detail-artist" data-detail-artist ${artistName(track.artist) ? '' : 'hidden'}>${escapeHtml(artistName(track.artist))}</span><span class="detail-quality">${escapeHtml(qualityText(track))}</span></p>
      <button type="button" class="text-button current-track-link" data-lyrics-current-track hidden>재생 중인 곡 보기</button>
        <div class="detail-actions">
          <button type="button" class="icon-button detail-favorite" data-favorite aria-label="${track.isLifeSong ? '최애곡에서 해제' : '최애곡에 추가'}" title="${track.isLifeSong ? '최애곡에서 해제' : '최애곡에 추가'}" aria-pressed="${track.isLifeSong}" ${favoritesInFlight.has(track.id) ? 'disabled' : ''}>${icon('heart')}</button>
          <button type="button" class="icon-button" data-comments="${track.id}" aria-haspopup="dialog" aria-controls="comments-dialog" aria-expanded="false" aria-label="코멘트" title="코멘트">${icon('message-circle')}</button>
          <button type="button" class="icon-button" data-edit-info="${track.id}" aria-label="곡 정보 편집" title="곡 정보 편집" aria-haspopup="dialog">${icon('ellipsis')}</button>
        </div>
      </div>
    </div>
    <dialog class="artwork-dialog" aria-labelledby="artwork-title">
      <h2 id="artwork-title">앨범 사진 등록</h2>
      <p>${albumName(track.album) ? escapeHtml(albumName(track.album)) + ' 앨범의 모든 곡에 적용됩니다.' : '앨범 정보가 없어 이 곡에만 적용됩니다.'}</p>
      <div class="artwork-preview" data-artwork-preview><span>사진을 선택해 주세요</span></div>
      <label class="secondary-button file-button">사진 선택<input data-artwork-file type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"></label>
      <p class="artwork-file-info" data-artwork-info>JPG · PNG · WebP / 최대 10 MB</p>
      <p class="error-message" data-artwork-error role="alert" hidden></p>
      <div class="form-actions"><button type="button" class="secondary-button" data-artwork-cancel>취소</button><button type="button" class="primary-button" data-artwork-save disabled>사진 저장</button></div>
    </dialog>
    <form id="notes-form" data-track-id="${track.id}">
      <div class="lyrics-content">
        <div class="lyrics-toolbar"><strong data-lyrics-heading>가사와 번역 입력</strong><p data-lyrics-hint></p></div>
        <div class="lyrics-reader" data-lyrics-reader>
          <div class="lyrics-scroll" tabindex="0" role="region" aria-label="가사 감상" data-lyrics-lines></div>
          <button type="button" class="lyrics-return" data-lyrics-follow aria-label="재생 중인 가사로 돌아가기" hidden>재생 중인 가사로</button>
        </div>
        <div data-lyrics-editor hidden>
          <p class="lyrics-help">LRC 시간표가 있으면 재생에 맞춰 표시합니다. 번역도 같은 시간표를 사용하거나 원문과 줄 수를 맞춰 입력하세요.</p>
          <div class="notes-grid">
            <label>원문 가사${track.lyricsSourceName ? ` · ${escapeHtml(track.lyricsSourceName)} 자동 연결` : ''}<textarea name="lyricsOriginal" placeholder="원문 가사 또는 LRC를 입력하세요">${escapeHtml(track.lyricsOriginal)}</textarea></label>
            <label>한국어 번역<textarea name="lyricsTranslation" placeholder="한국어 번역을 입력하세요">${escapeHtml(track.lyricsTranslation)}</textarea></label>
          </div>
        </div>
      </div>
      <p class="error-message" data-lyrics-save-error role="alert" hidden></p>
      <div class="form-actions" data-input-only hidden><button type="button" class="secondary-button" data-listen-preview>감상으로 미리보기</button><button class="primary-button">가사 저장</button></div>
    </form>
    </div>
  `;
  delete container.dataset.tab;
  bindMenus(container);
  container.querySelector('#notes-form').addEventListener('submit', saveNotes);
  setupDetailActions(container, track);
  lyricsView = setupLyricsView(container);
  artworkEditor = setupArtworkEditor(container, track);
  detailModes = setupDetailModes(container);
}

function setupDetailModes(container) {
  const form = container.querySelector('#notes-form');
  const snapshot = () => Object.fromEntries(new FormData(form));
  const id = state.selectedTrack.id;
  const draft = drafts.open(id, state.selectedTrack);
  for (const key of Object.keys(draft)) form.elements[key].value = draft[key];
  form.querySelector('button.primary-button').disabled = savesInFlight.has(id);
  const updateDraft = () => {
    const values = snapshot();
    drafts.update(id, values);
    const banner = container.querySelector('[data-detail-draft]');
    banner.hidden = !drafts.get(id);
    banner.textContent = '저장하지 않은 변경사항';
  };
  function setMode(value) {
    const editing = value === 'edit';
    container.dataset.mode = value;
    container.querySelectorAll('[data-input-only]').forEach(element => { element.hidden = !editing; });
    lyricsView.setMode(value);
    syncListeningShell();
    updateDraft();
  }
  container.querySelector('[data-listen-preview]').addEventListener('click', () => setAppMode('listen', { preview: true }));
  form.addEventListener('input', updateDraft);
  setMode(state.appMode);
  return { setMode, capture: updateDraft, isEditing: () => state.appMode === 'edit', syncDraft: () => setMode(state.appMode) };
}

function setupArtworkEditor(container, track) {
  const dialog = container.querySelector('.artwork-dialog');
  const input = container.querySelector('[data-artwork-file]');
  const preview = container.querySelector('[data-artwork-preview]');
  const info = container.querySelector('[data-artwork-info]');
  const error = container.querySelector('[data-artwork-error]');
  const save = container.querySelector('[data-artwork-save]');
  const cancel = container.querySelector('[data-artwork-cancel]');
  let file = null;
  let previewUrl = null;
  let generation = 0;
  let busy = false;
  const clear = () => {
    generation += 1;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    file = null;
    input.value = '';
    save.disabled = true;
    error.hidden = true;
    preview.innerHTML = '<span>사진을 선택해 주세요</span>';
    info.textContent = 'JPG · PNG · WebP / 최대 10 MB';
  };
  const open = trigger => { clear(); openDialog(dialog, trigger); };
  container.querySelector('[data-artwork-open]').addEventListener('click', event => open(event.currentTarget));
  setupDialog(dialog);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', clear);
  input.addEventListener('change', async () => {
    const selected = input.files[0];
    if (!selected) return;
    clear();
    const version = generation;
    try {
      if (selected.size > 10 * 1024 ** 2) throw new Error('10 MB 이하의 사진을 선택해 주세요.');
      if (!/\.(jpe?g|png|webp)$/i.test(selected.name)) throw new Error('JPG, PNG 또는 WebP 사진을 선택해 주세요.');
      const url = URL.createObjectURL(selected);
      previewUrl = url;
      const image = new Image();
      image.src = url;
      await image.decode();
      if (generation !== version) return;
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('사진은 4,000만 화소 이하로 선택해 주세요.');
      image.alt = '선택한 앨범 사진 미리보기';
      preview.replaceChildren(image);
      info.textContent = `${selected.name} · ${image.naturalWidth} × ${image.naturalHeight} · ${formatBytes(selected.size)}`;
      file = selected;
      save.disabled = false;
    } catch (reason) {
      if (generation !== version) return;
      clear();
      error.textContent = reason instanceof DOMException ? '사진을 읽지 못했습니다. 다른 이미지 파일을 선택해 주세요.' : reason.message;
      error.hidden = false;
    }
  });
  save.addEventListener('click', async () => {
    if (!file || busy) return;
    busy = true;
    save.disabled = cancel.disabled = input.disabled = true;
    save.textContent = '저장 중…';
    error.hidden = true;
    try {
      const response = await fetch(`/api/tracks/${track.id}/artwork`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '사진을 저장하지 못했습니다.');
      if (container.isConnected && state.selectedTrack.id === track.id) {
        state.selectedTrack.artworkPath = result.artworkPath;
        container.querySelector('[data-detail-cover]').innerHTML = coverMarkup(result);
        lyricsView?.refreshArtwork();
        container.querySelector('[data-artwork-open]').innerHTML = `${icon('image-plus')} 앨범 사진 변경`;
      }
      dialog.close();
      await refreshState();
    } catch (reason) {
      error.textContent = reason.message || '사진을 저장하지 못했습니다. 다시 시도해 주세요.';
      error.hidden = false;
    } finally {
      busy = false;
      save.disabled = !file;
      cancel.disabled = input.disabled = false;
      save.textContent = '사진 저장';
    }
  });
  return { open, destroy: () => { dialog.close(); clear(); } };
}

function setupLyricsView(container) {
  const trackId = state.selectedTrack.id;
  const controller = new AbortController();
  const { signal } = controller;
  const scroll = container.querySelector('[data-lyrics-lines]');
  const reader = container.querySelector('[data-lyrics-reader]');
  const editor = container.querySelector('[data-lyrics-editor]');
  const followButton = container.querySelector('[data-lyrics-follow]');
  const currentTrackButton = container.querySelector('[data-lyrics-current-track]');
  const hint = container.querySelector('[data-lyrics-hint]');
  const originalInput = container.querySelector('[name="lyricsOriginal"]');
  const translationInput = container.querySelector('[name="lyricsTranslation"]');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const stage = container.querySelector('.detail-stage');
  let model, active = -1, follow = true, mode = 'listen';
  let buttons = [], renderedOriginal, renderedTranslation, frame, savedPosition = 0;
  function refreshArtwork() {
    const image = container.querySelector('[data-detail-cover] img');
    stage.style.removeProperty('--listening-artwork');
    if (!image) return;
    const current = () => !signal.aborted && image === container.querySelector('[data-detail-cover] img');
    const loaded = () => { if (current() && image.naturalWidth) stage.style.setProperty('--listening-artwork', `url(${JSON.stringify(image.getAttribute('src'))})`); };
    const failed = () => {
      if (!current()) return;
      stage.style.removeProperty('--listening-artwork');
      const cover = image.parentElement;
      cover.classList.remove('has-artwork');
      cover.innerHTML = icon('disc');
    };
    image.addEventListener('load', loaded, { once: true, signal });
    image.addEventListener('error', failed, { once: true, signal });
    if (image.complete) { if (image.naturalWidth) loaded(); else failed(); }
  }
  const visible = () => mode === 'listen' && scroll.getClientRects().length > 0;
  const sameTrack = () => player.trackId === trackId;
  const stopSmooth = () => scroll.scrollTo({ top: scroll.scrollTop, behavior: 'instant' });
  function updateState() {
    const matching = sameTrack();
    followButton.hidden = mode !== 'listen' || !model.timed || !matching || active < 0 || follow;
    currentTrackButton.hidden = mode !== 'listen' || !player.trackId || matching;
    scroll.dataset.follow = String(follow);
  }
  function browse() {
    if (!model) return;
    follow = false;
    stopSmooth();
    updateState();
  }
  function alignCurrent() {
    const row = buttons[active];
    if (!row || !visible()) return;
    const focused = document.activeElement;
    // A keyboard user reading a different line takes priority over playback.
    if (focused !== row && scroll.contains(focused) && focused.matches('[data-lyric-index]')) { browse(); return; }
    const box = scroll.getBoundingClientRect(), rect = row.getBoundingClientRect();
    const top = rect.top - box.top - scroll.clientTop + scroll.scrollTop;
    const target = row.offsetHeight > scroll.clientHeight - 40 ? top - 20 : top - (scroll.clientHeight - row.offsetHeight) / 2;
    scroll.scrollTo({ top: target, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }
  function sizeReader() {
    if (!visible()) return;
    const playerBox = document.querySelector('#mini-player');
    const bottom = Math.min(mainScroller().getBoundingClientRect().bottom, playerBox.hidden ? innerHeight : playerBox.getBoundingClientRect().top);
    // Focus scrolling must not inflate the stage while a short window reflows.
    const room = Math.max(48, bottom - (stage.getBoundingClientRect().top + mainScroller().scrollTop) - 8);
    // Measure the ordinary two-column header before deciding whether height,
    // as well as width, requires stacking. Resetting inside the same frame
    // prevents the wider stacked title from toggling the decision on each resize.
    stage.removeAttribute('data-height-stacked');
    const widthStacked = getComputedStyle(stage).getPropertyValue('--stacked').trim() === '1';
    const copy = container.querySelector('.detail-copy');
    const heightStacked = !widthStacked && room - copy.getBoundingClientRect().height < 240;
    stage.toggleAttribute('data-height-stacked', heightStacked);
    const narrow = widthStacked || heightStacked;
    const heading = copy.getBoundingClientRect().height;
    stage.style.setProperty('--heading-height', `${heading}px`);
    const minimum = narrow ? heading + 36 + 8 + 96 : heading + 240;
    stage.toggleAttribute('data-page-overflow', room < minimum);
    stage.style.setProperty('--detail-room', `${Math.floor(Math.max(room, minimum))}px`);
    if (narrow) {
      stage.style.setProperty('--stage-top', '0px');
      const cover = Math.max(36, Math.min(240, room - heading - 16 - Math.min(260, Math.max(160, room * .45))));
      stage.style.setProperty('--cover-limit', `${Math.floor(cover)}px`);
      stage.style.setProperty('--reading-height', `${Math.floor(Math.min(440, Math.max(96, Math.max(room, minimum) - heading - cover - 8)))}px`);
    } else {
      const style = getComputedStyle(stage);
      const leftColumn = (stage.clientWidth - parseFloat(style.columnGap)) * .44;
      // One size owns the visible square and the actual lyric viewport. The
      // title (including its gap) is a separate row above both objects.
      const size = Math.floor(Math.min(760, leftColumn, room - heading));
      stage.style.setProperty('--art-lyrics-size', `${size}px`);
      stage.style.setProperty('--reading-height', `${size}px`);
      // The player is part of the perceived window: balance against the full
      // viewport, with a small allowance for the title's weight above the square.
      // Clamp to the available room so compact windows retain player clearance.
      const spare = Math.max(0, room - heading - size);
      const stageOrigin = stage.getBoundingClientRect().top + mainScroller().scrollTop;
      const visualCenter = innerHeight / 2 + Math.min(24, heading * .2);
      const top = Math.max(0, Math.min(spare, visualCenter - stageOrigin - size / 2 - heading));
      stage.style.setProperty('--stage-top', `${Math.floor(top)}px`);
    }
    const readerHeight = reader.clientHeight;
    scroll.style.setProperty('--lyric-edge', `${Math.max(0, Math.floor(Math.min((readerHeight - 40) / 2, readerHeight - 96)))}px`);
    if (follow) alignCurrent();
  }
  function layout() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sizeReader);
  }
  function sync(force = false) {
    if (!model) return;
    const index = model.timed && sameTrack() && !player.status.startsWith('재생 실패') ? activeLyricIndex(model.rows, player.currentTime) : -1;
    const changed = index !== active;
    if (changed) {
      if (index < 0) stopSmooth();
      buttons[active]?.classList.remove('is-current');
      buttons[active]?.removeAttribute('aria-current');
      active = index;
      buttons[active]?.classList.add('is-current');
      buttons[active]?.setAttribute('aria-current', 'true');
    }
    updateState();
    if ((changed || force) && follow) alignCurrent();
  }
  function render() {
    // Mode/tab changes retain DOM and the manual reading position unless the
    // draft lyrics themselves changed. The parser still owns all pairing/time.
    if (renderedOriginal === originalInput.value && renderedTranslation === translationInput.value) return;
    stopSmooth();
    renderedOriginal = originalInput.value; renderedTranslation = translationInput.value;
    model = buildLyrics(renderedOriginal, renderedTranslation);
    active = -1;
    scroll.classList.toggle('is-untimed', !model.timed);
    const extra = (title, lines) => lines.length ? `<section class="lyrics-extra"><h3>${title}</h3><p>${escapeHtml(lines.join('\n'))}</p></section>` : '';
    scroll.innerHTML = model.rows.map((row, index) => {
      const tag = model.timed ? 'button' : 'div';
      return `<${tag} class="lyric-line" ${model.timed ? `type="button" data-lyric-index="${index}" title="${formatTime(row.time)}부터 재생" aria-label="${escapeHtml(`${formatTime(row.time)} · ${row.text || '간주'}${row.translation ? ` · ${row.translation}` : ''}`)}"` : ''}>
        <span class="lyric-copy"><span class="lyric-original" data-lyric-text="${escapeHtml(row.text || '간주')}"><span>${escapeHtml(row.text || '간주')}</span></span>
        ${row.translation ? `<span class="lyric-translation">${escapeHtml(row.translation)}</span>` : ''}</span></${tag}>`;
    }).join('') + extra('시간표 없는 원문', model.extraOriginal) + extra('번역 · 줄 연결 필요', model.extraTranslation)
      || `<div class="lyrics-empty">${icon('file-text')}<h3>아직 가사가 없습니다</h3><button type="button" class="secondary-button" data-add-lyrics>가사 입력</button></div>`;
    buttons = [...scroll.querySelectorAll('[data-lyric-index]')];
    buttons.forEach(button => button.addEventListener('click', async () => {
      try {
        follow = true;
        await playTrack(trackId, model.rows[Number(button.dataset.lyricIndex)].time);
        sync(true);
      } catch { showToast('이 구간을 재생하지 못했습니다. 음원 파일을 확인해 주세요.'); }
    }));
    scroll.querySelector('[data-add-lyrics]')?.addEventListener('click', event => trackEditor.open(trackId, event.currentTarget, 'lyricsOriginal'));
    sync(); layout();
  }
  function setMode(value) {
    if (mode === 'listen' && visible()) { savedPosition = scroll.scrollTop; stopSmooth(); }
    mode = value;
    container.classList.toggle('lyrics-listening', value === 'listen');
    reader.hidden = value === 'edit'; editor.hidden = value !== 'edit';
    hint.hidden = value !== 'edit';
    container.querySelector('.lyrics-toolbar').hidden = value !== 'edit';
    updateState();
    if (value === 'listen') { render(); scroll.scrollTop = savedPosition; sync(); layout(); }
  }
  function setVisible(value) {
    if (!value) { savedPosition = scroll.scrollTop; stopSmooth(); updateState(); }
    else { scroll.scrollTop = savedPosition; sync(true); layout(); }
  }
  followButton.addEventListener('click', () => {
    const moveFocus = document.activeElement === followButton;
    follow = true; sync(true);
    if (moveFocus) scroll.focus({ preventScroll: true });
  });
  currentTrackButton.addEventListener('click', () => { if (player.trackId) openTrack(player.trackId); });
  scroll.addEventListener('wheel', browse, { passive: true, signal });
  scroll.addEventListener('touchmove', browse, { passive: true, signal });
  scroll.addEventListener('pointerdown', event => {
    const rect = scroll.getBoundingClientRect();
    if (event.target === scroll && event.clientX >= rect.right - Math.max(16, scroll.offsetWidth - scroll.clientWidth)) browse();
  }, { signal });
  scroll.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(event.key)) browse();
  }, { signal });
  scroll.addEventListener('focusin', event => {
    if (!event.target.matches('[data-lyric-index]')) return;
    if (Number(event.target.dataset.lyricIndex) !== active) browse();
    requestAnimationFrame(() => {
      if (signal.aborted || followButton.hidden) return;
      const row = event.target.getBoundingClientRect(), box = scroll.getBoundingClientRect();
      const top = box.top + 6, bottom = box.bottom - 72;
      const delta = row.height > bottom - top || row.top < top ? row.top - top : row.bottom > bottom ? row.bottom - bottom : 0;
      if (delta) scroll.scrollBy({ top: delta, behavior: 'instant' });
    });
  }, { signal });
  reducedMotion.addEventListener('change', () => { stopSmooth(); if (follow) alignCurrent(); }, { signal });
  window.addEventListener('resize', layout, { signal });
  const observer = new ResizeObserver(layout);
  observer.observe(document.querySelector('#mini-player'));
  observer.observe(container.querySelector('.detail-copy'));
  observer.observe(stage);
  player.addEventListener('change', () => sync(), { signal });
  refreshArtwork(); render();
  return { sync, setMode, setVisible, refreshArtwork, layout, destroy: () => { stopSmooth(); controller.abort(); observer.disconnect(); cancelAnimationFrame(frame); } };
}

function setupDetailActions(container, track) {
  container.querySelector('[data-favorite]').addEventListener('click', async event => {
    const id = track.id, button = event.currentTarget;
    if (favoritesInFlight.has(id)) return;
    const isLifeSong = !Boolean(state.tracks.find(song => song.id === id)?.isLifeSong);
    favoritesInFlight.add(id); button.disabled = true;
    try {
      const response = await fetch(`/api/tracks/${id}/favorite`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isLifeSong }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '최애곡을 저장하지 못했습니다.');
      stateRequest += 1;
      const row = state.tracks.find(song => song.id === id);
      if (row) row.isLifeSong = result.isLifeSong;
      if (state.selectedTrack?.id === id) {
        state.selectedTrack.isLifeSong = result.isLifeSong;
        const action = container.querySelector('[data-favorite]');
        action.title = result.isLifeSong ? '최애곡에서 해제' : '최애곡에 추가';
        action.setAttribute('aria-label', action.title);
        action.setAttribute('aria-pressed', String(result.isLifeSong));
      }
      renderAll();
      showToast(result.isLifeSong ? '최애곡에 추가했습니다.' : '최애곡에서 해제했습니다.');
    } catch (error) { showToast(error.message || '최애곡을 저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally {
      favoritesInFlight.delete(id); button.disabled = false;
      if (state.selectedTrack?.id === id) container.querySelector('[data-favorite]').disabled = false;
    }
  });
  container.querySelector('[data-comments]').addEventListener('click', event => comments.open(track.id, event.currentTarget));
}
function openDeleteTrack(track, trigger) {
  const dialog = document.querySelector('#delete-track-dialog');
  dialog.dataset.trackId = String(track.id);
  document.querySelector('#delete-track-title').textContent = track.title;
  document.querySelector('#delete-track-path').textContent = `${state.libraryRoot}/${track.managedPath}`;
  document.querySelector('#delete-track-error').hidden = true;
  openDialog(dialog, trigger);
}

function syncTrackPlayback() {
  document.querySelectorAll('[data-current-id]').forEach(row => { const active = Number(row.dataset.currentId) === player.trackId; row.classList.toggle('is-current', active); if (active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); });
}
player.addEventListener('change', syncTrackPlayback);

async function saveNotes(event) {
  event.preventDefault();
  if (!detailModes?.isEditing()) return;
  const formElement = event.currentTarget;
  const button = event.submitter;
  const id = Number(formElement.dataset.trackId);
  if (savesInFlight.has(id)) return;
  savesInFlight.add(id);
  const form = new FormData(formElement);
  const body = Object.fromEntries(form.entries());
  drafts.startSave(id, body);
  formElement.querySelector('[data-lyrics-save-error]').hidden = true;
  let saved = false;
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/tracks/${id}/notes`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '가사를 저장하지 못했습니다.');
    drafts.saved(id, body);
    saved = true;
    if (state.selectedTrack.id === id) {
      Object.assign(state.selectedTrack, { lyricsOriginal: result.lyricsOriginal, lyricsTranslation: result.lyricsTranslation });
      detailModes?.syncDraft();
    }
    try {
      await refreshState();
      showToast('가사 저장됨');
    } catch {
      showToast('가사를 저장했습니다. 컬렉션은 다시 불러와 주세요.');
    }
  } catch (reason) {
    const error = state.selectedTrack?.id === id ? document.querySelector('[data-lyrics-save-error]') : null;
    const message = reason.message || '저장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.';
    if (error) { error.textContent = message; error.hidden = false; }
    showToast(message);
  }
  finally {
    if (!saved) {
      drafts.failed(id);
      if (state.selectedTrack.id === id) detailModes?.syncDraft();
    }
    savesInFlight.delete(id);
    if (button) button.disabled = false;
    if (state.selectedTrack.id === id) document.querySelector('#notes-form .primary-button').disabled = false;
  }
}

async function recordPlayback(id, listenedMs, completed) {
  const response = await fetch(`/api/tracks/${id}/playback`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listenedMs, completed })
  });
  if (!response.ok) throw new Error('감상 이력 저장 실패');
  await refreshState();
}

async function localRequest(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-local-token': state.localToken }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '처리하지 못했습니다.');
  return result;
}

async function stageSelection(files) {
  if (state.importBusy) return;
  state.importBusy = true;
  document.querySelectorAll('#import-select input,#import-select textarea,#import-select button').forEach(control => control.disabled = true);
  const reviewFirst = document.querySelector('#import-review-first').checked;
  let prepared = false;
  try { prepared = await prepareCopySelection(files); }
  catch (error) { showImportError(error.message || '파일을 준비하지 못했습니다.'); }
  finally {
    state.importBusy = false;
    document.querySelectorAll('#import-select input,#import-select textarea,#import-select button').forEach(control => control.disabled = false);
    document.querySelector('#stage-progress').hidden = true;
  }
  if (prepared && !reviewFirst) {
    if (state.staged.length) await commitBatchImport();
    else showImportResults();
  }
}

async function prepareCopySelection(files) {
  clearImportError();
  await discardStaged();
  state.staged = [];
  state.importResults = new Map();
  state.importOrder = [];
  const audioExtensions = new Set(['flac', 'alac', 'm4a', 'mp3', 'aac', 'ogg']);
  const audioFiles = files.filter((file) => audioExtensions.has(fileExtension(file.name)));
  const lyricFiles = files.filter((file) => fileExtension(file.name) === 'lrc' && file.size <= 2 * 1024 * 1024);
  if (audioFiles.length > 500) return showImportError('한 번에 음원 500개 이하를 선택해 주세요.');
  if (!audioFiles.length) return showImportError('선택한 폴더에서 FLAC, ALAC/M4A, MP3, AAC 또는 OGG 파일을 찾지 못했습니다.');

  const progressArea = document.querySelector('#stage-progress');
  const progress = document.querySelector('#upload-progress');
  progressArea.hidden = false;
  progress.max = audioFiles.length;
  progress.value = 0;
  document.querySelector('#progress-name').textContent = `${audioFiles.length}개 음원 분석 중`;
  document.querySelector('#progress-value').textContent = `0/${audioFiles.length}`;

  const stagedResults = [];
  const report = { duplicates: 0, errors: [], alternatives: 0, lrcCount: 0, excluded: [] };
  for (const file of audioFiles) {
    const result = await stageOneFile(file);
    if (result.status === 'ready') {
      if (stagedResults.some(item => item.staged.checksum === result.staged.checksum)) {
        report.duplicates += 1;
        report.excluded.push(`${file.name}: 이번 선택에 포함된 동일 파일`);
        await discardImport(result.staged.importId);
      } else { stagedResults.push(result); state.staged.push(result); }
    }
    else if (result.status === 'duplicate') { report.duplicates += 1; report.excluded.push(`${file.name}: 이미 소장한 동일 파일`); }
    else report.errors.push(`${file.name}: ${result.error}`);
    progress.value += 1;
    document.querySelector('#progress-value').textContent = `${progress.value}/${audioFiles.length}`;
  }

  const lyricMap = new Map();
  for (const file of lyricFiles) {
    const path = relativeFilePath(file);
    lyricMap.set(trackKey(path), file);
  }

  const selected = [];
  for (const preferred of stagedResults) {
    const titleKey = trackKey(`${preferred.directory}/${preferred.staged.metadata.title}.lrc`);
    const lyricFile = lyricMap.get(preferred.trackKey) || lyricMap.get(titleKey);
    if (lyricFile) {
      try {
        preferred.lrcText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await lyricFile.arrayBuffer());
        preferred.lrcSourceName = lyricFile.name; report.lrcCount += 1;
      } catch { report.errors.push(`${lyricFile.name}: UTF-8 가사를 읽지 못했습니다. 음원은 가사 없이 추가할 수 있습니다.`); }
    }
    selected.push(preferred);
  }

  state.staged = selected;
  state.importReport = report;
  progressArea.hidden = true;
  showBatchReview();
  return true;
}

async function stageOneFile(file) {
  try {
    const response = await fetch('/api/stage', { method: 'POST', headers: { 'x-file-name': encodeURIComponent(file.name) }, body: file });
    const result = await response.json();
    if (response.status === 409) return { status: 'duplicate', existingTrack: result.existingTrack };
    if (!response.ok) return { status: 'error', error: result.error || '분석 실패' };
    const path = relativeFilePath(file);
    return {
      status: 'ready', file, staged: result, directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      trackKey: trackKey(path), lrcText: '', lrcSourceName: ''
    };
  } catch (error) {
    return { status: 'error', error: error.message || '분석 실패' };
  }
}

function showBatchReview() {
  document.querySelector('#import-select').hidden = true;
  const form = document.querySelector('#batch-form');
  form.hidden = false;
  setStep(2);
  const moving = state.staged.some(item => item.move);
  document.querySelector('#move-review-notice').hidden = !moving;
  document.querySelector('#commit-import').textContent = moving ? `${state.staged.length}곡 이동` : `${state.staged.length}곡 복사하여 추가`;
  document.querySelector('#commit-import').disabled = !state.staged.length;
  document.querySelector('#review-summary').textContent = state.staged.length ? `${state.staged.length}곡을 추가할 수 있습니다` : '추가할 새 음원이 없습니다';
  const report = state.importReport;
  if (!state.importOrder?.length) state.importOrder = state.staged.map(item => item.staged.importId);
  report.lrcCount = state.staged.filter(item => item.lrcSourceName).length;
  const details = [
    report.lrcCount ? `LRC ${report.lrcCount}개 연결` : null,
    report.alternatives ? `낮은 음질 대안 ${report.alternatives}개 제외` : null,
    report.duplicates ? `이미 소장한 파일 ${report.duplicates}개 제외` : null,
    report.errors.length ? `분석 실패 ${report.errors.length}개` : null
  ].filter(Boolean);
  document.querySelector('#review-detail').textContent = details.join(' · ') || '가사나 표지가 없어도 추가할 수 있습니다.';
  const excluded = [...(report.excluded || []), ...report.errors];
  document.querySelector('#review-exclusions').innerHTML = excluded.length ? `<details class="exclusion-details" ${!state.staged.length ? 'open' : ''}><summary>제외·확인 실패 ${excluded.length}개 · 이유 보기</summary><ul class="result-list">${excluded.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></details>` : '';
  document.querySelector('#batch-list').innerHTML = state.staged.map((item, index) => {
    const metadata = item.staged.metadata;
    return `<article class="batch-row">
      <div class="batch-cover">${icon(item.staged.hasArtwork ? 'image-plus' : 'disc')}</div>
      <div class="batch-copy batch-fields"><label>곡명<input data-import-index="${index}" data-import-field="title" value="${escapeHtml(metadata.title)}" required></label><label>가수명<input data-import-index="${index}" data-import-field="artist" value="${escapeHtml(artistName(metadata.artist))}" placeholder="가수명 입력 · 선택"></label></div>
      <div class="batch-status"><span class="quality-badge">${escapeHtml(qualityText(metadata))}</span><small>${item.lrcSourceName ? `LRC · ${escapeHtml(item.lrcSourceName)}` : 'LRC 없음'} · ${item.staged.hasArtwork ? '내장 표지' : '표지 없음'}</small></div>
      <details class="batch-extra"><summary>파일·가사 자세히 보기</summary><p>${escapeHtml(item.sourcePath || item.file.name)}</p><div class="batch-lyrics">${item.move
        ? `<label>LRC 파일 경로<input data-lrc-path="${index}" value="${escapeHtml(item.lrcPath || '')}" placeholder="/Volumes/Music/가사.lrc"></label><button type="button" class="secondary-button" data-link-lrc="${index}">가사 연결</button>`
        : `<label class="secondary-button file-button">LRC 직접 선택<input type="file" accept=".lrc" data-lrc-file="${index}"></label>`}${item.lrcSourceName ? `<button type="button" class="text-button" data-unlink-lrc="${index}">가사 연결 해제</button>` : ''}<small>${item.move ? '연결된 가사도 음원과 함께 이동합니다.' : '선택한 가사는 복사하여 보관합니다.'}</small></div></details>
    </article>`;
  }).join('');
  document.querySelectorAll('[data-import-field]').forEach(input => input.addEventListener('input', () => {
    const key = input.dataset.importField;
    if (key === 'title') input.setCustomValidity(input.value.trim() ? '' : '곡명을 입력해 주세요.');
    state.staged[Number(input.dataset.importIndex)].staged.metadata[key] = input.value.trim() || (key === 'artist' ? '알 수 없는 아티스트' : '');
  }));
  document.querySelectorAll('[data-unlink-lrc]').forEach(button => button.addEventListener('click', async () => {
    if (state.importBusy) return;
    const item = state.staged[Number(button.dataset.unlinkLrc)];
    setReviewBusy(true);
    try {
      if (item.move) await localRequest('/api/local-lyrics', { importId: item.staged.importId, path: null });
      Object.assign(item, { lrcText: '', lrcSourceName: '', lrcPath: '' }); showBatchReview();
    } catch (error) { showImportError(error.message); }
    finally { setReviewBusy(false); }
  }));
  document.querySelectorAll('[data-link-lrc]').forEach(button => button.addEventListener('click', async () => {
    if (state.importBusy) return;
    const index = Number(button.dataset.linkLrc), item = state.staged[index];
    setReviewBusy(true);
    try {
      const path = document.querySelector(`[data-lrc-path="${index}"]`).value.trim();
      const result = await localRequest('/api/local-lyrics', { importId: item.staged.importId, path });
      Object.assign(item, result); showBatchReview(); showToast('가사 파일을 연결했습니다.');
    } catch (error) { showImportError(error.message); }
    finally { setReviewBusy(false); }
  }));
  document.querySelectorAll('[data-lrc-file]').forEach(input => input.addEventListener('change', async () => {
    if (state.importBusy) return;
    const file = input.files[0]; if (!file) return;
    setReviewBusy(true);
    try {
      if (!file.name.toLowerCase().endsWith('.lrc') || file.size > 2 * 1024 * 1024) throw new Error('2 MB 이하 LRC 파일을 선택해 주세요.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      Object.assign(state.staged[Number(input.dataset.lrcFile)], { lrcText: text, lrcSourceName: file.name });
      showBatchReview();
    } catch (error) { showImportError(error.message); }
    finally { setReviewBusy(false); }
  }));

}

function setReviewBusy(busy) {
  state.importBusy = busy;
  document.querySelectorAll('#batch-form button,#batch-form input').forEach(control => control.disabled = busy);
  document.querySelector('#commit-import').disabled = busy || !state.staged.length;
}

async function commitBatchImport(event) {
  event?.preventDefault();
  if (state.importBusy || !state.staged.length) return;
  if (!document.querySelector('#batch-form').reportValidity()) return;
  clearImportError();
  for (const input of document.querySelectorAll('[data-lrc-path]')) {
    const item = state.staged[Number(input.dataset.lrcPath)];
    if (input.value.trim() !== (item.lrcPath || '')) return showImportError('수정한 LRC 경로의 가사 연결 버튼을 먼저 눌러 주세요.');
  }
  state.importBusy = true;
  const button = document.querySelector('#commit-import');
  const progress = document.querySelector('#import-save-status');
  progress.hidden = false;
  const items = state.staged.slice();
  const controls = [...document.querySelectorAll('#batch-form button,#batch-form input')];
  controls.forEach(control => control.disabled = true);
  state.importResults ||= new Map();
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      button.textContent = `서재에 ${item.move ? '이동' : '복사'} 중 · ${index + 1}/${items.length}곡`;
      progress.textContent = button.textContent;
      try {
        const response = await fetch(item.move ? '/api/local-commit' : '/api/commit', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-local-token': state.localToken },
          body: JSON.stringify({ importId: item.staged.importId, confirmMove: Boolean(item.move),
            metadata: { ...item.staged.metadata, lrcText: item.lrcText, lrcSourceName: item.lrcSourceName } })
        });
        const result = await response.json();
        if (response.ok) state.importResults.set(item.staged.importId, result);
        else item.failure = result.error || '추가하지 못했습니다. 다시 확인해 주세요.';
      } catch {
        item.uncertain = true;
        item.failure = '완료 여부를 확인하지 못했습니다. 연결을 확인한 뒤 완료 여부를 다시 확인해 주세요.';
      }
    }
    state.staged = items.filter(item => !state.importResults.has(item.staged.importId));
    await reconcileImports();
    showImportResults();
    try { await refreshState(); } catch { showImportError('컬렉션을 새로 읽지 못했습니다. 연결을 확인하고 완료 여부를 다시 확인해 주세요.'); }
  } finally {
    state.importBusy = false;
    controls.forEach(control => control.disabled = false);
    progress.hidden = true;
    button.textContent = '미완료 파일 추가';
  }
}

async function reconcileImports() {
  for (const item of state.staged.filter(item => item.uncertain)) {
    try {
      const response = await fetch(`/api/imports/${item.staged.importId}?checksum=${encodeURIComponent(item.staged.checksum)}`);
      if (!response.ok) continue;
      const result = await response.json();
      if (result.status === 'committed') {
        if (result.recovered && item.move) result.track.moveWarnings = ['서재 보관을 확인했습니다. 원본 제거 여부는 원래 폴더에서 확인해 주세요.'];
        state.importResults.set(item.staged.importId, result.track);
      } else if (result.status === 'ready') {
        item.uncertain = false;
        item.failure = '추가되지 않았습니다. 준비한 파일을 다시 확인해 주세요.';
      } else if (result.status === 'missing') {
        item.failure = '서버에서 준비 상태를 찾지 못했습니다. 컬렉션과 원래 폴더를 확인한 뒤 파일을 다시 선택해 주세요.';
      }
    } catch { /* Keep uncertainty and never resubmit here. */ }
  }
  state.staged = state.staged.filter(item => !state.importResults.has(item.staged.importId));
  const order = state.importOrder || [];
  state.importedTracks = [...state.importResults.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([, track]) => track);
}

function showImportResults() {
  document.querySelector('#batch-form').hidden = true;
  document.querySelector('#import-select').hidden = true;
  document.querySelector('#import-complete').hidden = false;
  const count = state.importedTracks.length;
  const unknown = state.staged.filter(item => item.uncertain).length;
  const failed = state.staged.length - unknown;
  document.querySelector('.complete-mark').innerHTML = icon(count ? 'check' : 'alert');
  document.querySelector('#import-complete h2').textContent = count ? `${count}곡 추가됨` : '추가 결과를 확인해 주세요';
  const copy = document.querySelector('#complete-copy');
  copy.textContent = [failed ? `${failed}곡을 추가하지 못했습니다.` : '', unknown ? `${unknown}곡은 완료 여부를 확인하지 못했습니다.` : ''].filter(Boolean).join(' ');
  copy.hidden = !copy.textContent;
  document.querySelector('#complete-tracks').innerHTML = state.importedTracks.map(track => `<li>${escapeHtml(joined(track.title, artistName(track.artist)))}</li>`).join('');
  const warnings = [...(state.importReport?.errors || []), ...(state.importReport?.excluded || []), ...state.staged.filter(item => !item.uncertain).map(item => `${item.file.name}: ${item.failure}`)];
  const uncertainPanel = document.querySelector('#uncertain-imports');
  uncertainPanel.hidden = !unknown; uncertainPanel.textContent = state.staged.filter(item => item.uncertain).map(item => `${item.file.name}: ${item.failure}`).join('\n');
  const preservation = state.importedTracks.flatMap(track => track.moveWarnings || []);
  const preservationPanel = document.querySelector('#preservation-warnings');
  preservationPanel.hidden = !preservation.length; preservationPanel.textContent = preservation.join('\n');
  const panel = document.querySelector('#complete-warnings');
  panel.hidden = !warnings.length; panel.textContent = warnings.join('\n');
  const review = document.querySelector('#review-failed');
  review.hidden = !state.staged.length;
  review.textContent = unknown ? '완료 여부 다시 확인' : '미완료 파일 다시 확인';
  document.querySelector('#play-imported').disabled = !count;
  setStep(3);
}

async function reviewFailedImports() {
  if (state.importBusy) return;
  state.importBusy = true;
  document.querySelector('#review-failed').disabled = true;
  try {
    await reconcileImports();
    if (state.staged.some(item => item.uncertain)) return showImportResults();
    if (!state.staged.length) return showImportResults();
    document.querySelector('#import-complete').hidden = true;
    clearImportError(); showBatchReview();
  } finally {
    state.importBusy = false;
    document.querySelector('#review-failed').disabled = false;
  }
}

async function resetImport() {
  if (state.importBusy) return;
  state.importBusy = true;
  await discardStaged();
  state.staged = [];
  state.importedTracks = [];
  state.importResults = new Map();
  state.importOrder = [];
  state.importReport = null;
  document.querySelector('#file-input').value = '';
  document.querySelector('#folder-input').value = '';
  document.querySelector('#import-select').hidden = false;
  document.querySelector('#batch-form').hidden = true;
  document.querySelector('#import-complete').hidden = true;
  document.querySelector('#stage-progress').hidden = true;
  clearImportError();
  setStep(1);
  state.importBusy = false;
}

async function discardStaged() {
  await Promise.all((state.staged || []).filter(item => !item.uncertain).map((item) => discardImport(item.staged.importId)));
}

async function discardImport(importId) {
  await fetch('/api/discard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId })
  }).catch(() => {});
}

function relativeFilePath(file) {
  return file.webkitRelativePath || file.name;
}

function trackKey(path) {
  const normalized = path.replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  const directory = separator >= 0 ? normalized.slice(0, separator).toLocaleLowerCase('ko') : '';
  const filename = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const stem = filename.replace(/\.[^.]+$/, '')
    .replace(/^\d{1,3}(?:-\d{1,3})?[\s._-]+/, '')
    .replace(/[\s._-]*(?:\(?(?:flac|alac|lossless|320k|320kbps|无损|极高音质)\)?)$/i, '')
    .normalize('NFC').trim().toLocaleLowerCase('ko');
  return `${directory}/${stem}`;
}

function fileExtension(name) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function qualityText(metadata) {
  if (metadata.lossless) {
    const detail = [metadata.bitDepth ? `${metadata.bitDepth}-bit` : '', metadata.sampleRate ? `${Number((metadata.sampleRate / 1000).toFixed(1))} kHz` : ''].filter(Boolean).join('/');
    return `${metadata.format}${detail ? ` ${detail}` : ' 무손실'}`;
  }
  return `${metadata.format} ${metadata.bitrate ? `${Math.round(metadata.bitrate / 1000)} kbps` : '비트레이트 미상'}`;
}

function setStep(value) {
  document.querySelectorAll('[data-step]').forEach((step) => step.classList.toggle('is-current', Number(step.dataset.step) === value));
}

function showImportError(message) {
  importError.textContent = message;
  importError.hidden = false;
}

function clearImportError() {
  importError.hidden = true;
  importError.textContent = '';
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatTime(seconds) {
  const value = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

const deleteDialog = document.querySelector('#delete-track-dialog');
let deletingTrack = false;
deleteDialog.addEventListener('cancel', event => { if (deletingTrack) event.preventDefault(); });
document.querySelector('#delete-track-confirm').addEventListener('click', async () => {
  if (deletingTrack) return;
  const id = Number(deleteDialog.dataset.trackId);
  const error = document.querySelector('#delete-track-error');
  if (savesInFlight.has(id) || comments.isSaving(id) || trackEditor.isSaving(id)) {
    error.textContent = '저장이 끝난 뒤 다시 삭제해 주세요.'; error.hidden = false; return;
  }
  deletingTrack = true;
  deleteDialog.querySelectorAll('button').forEach(button => button.disabled = true);
  try {
    const response = await fetch(`/api/tracks/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-local-token': state.localToken }, body: JSON.stringify({ confirmDeleteFile: true }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '삭제하지 못했습니다.');
    const editor = document.querySelector('#track-info-dialog');
    if (Number(editor.dataset.trackId) === id && editor.open) editor.close();
    navigate('library');
    state.selectedTrack = null;
    if (player.trackId === id) player.pause();
    for (let i = player.queue.length - 1; i >= 0; i--) if (player.queue[i].trackId === id) player.remove(i);
    player.cache.delete(id);
    drafts.records.delete(id); comments.forget(id); trackEditor.forget(id);
    state.tracks = state.tracks.filter(track => track.id !== id);
    player.tracks = state.tracks;
    deleteDialog.close();
    await refreshState();
    document.querySelector('.nav-button.is-active')?.focus();
    showToast(result.cleanupPending ? '곡은 삭제했지만 음원 파일 정리에 실패했습니다. 보관 폴더를 확인해 주세요.' : '곡과 음원 파일을 삭제했습니다.');
  } catch (reason) {
    error.textContent = reason.message; error.hidden = false;
    if (!deleteDialog.open) showToast(reason.message);
  } finally { deletingTrack = false; deleteDialog.querySelectorAll('button').forEach(button => button.disabled = false); }
});

