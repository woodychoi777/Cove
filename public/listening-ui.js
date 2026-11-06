import { createDailyRecommendations, localDateKey } from './daily-recommendations.js';
import { icon, setPlayButton } from './icons.js';
import { artistName, joined, metadataText } from './metadata-display.js';
import { LoadingCue } from './loading-cue.js';
import { openDialog, retainFocus, bindRowPlayback } from './ui.js';
import { setupQueuePopup } from './queue-popup.js';
import { contentPosition, scrollContent, revealWithin } from './scroll.js';

export function setupListeningUI({ player, state, openTrack, playList, refresh, toast, escapeHtml: esc, formatTime: time, coverMarkup }) {
  let miniId = null, savingQueue = false, playbackError = '';
  const loadingCue = new LoadingCue({ onChange: () => updateMini() });
  const queuePopup = setupQueuePopup({ onOpen: () => renderQueue(true) });
  const track = id => state.tracks.find(item => item.id === id);
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '저장하지 못했습니다.');
    return result;
  };
  let storage;
  try { storage = localStorage; } catch {}
  const daily = createDailyRecommendations({ storage });
  let refreshRecommendationDate = true;
  let activationRequestedAt = -Infinity;
  const lastMarkup = new Map();
  function songRow(song, card = false) {
    const label = esc(joined(song.title, artistName(song.artist)));
    const copy = `<strong>${esc(song.title)}</strong><small ${artistName(song.artist) ? '' : 'hidden'}>${esc(artistName(song.artist))}</small>`;
    const append = `<div class="song-more"><button type="button" class="icon-button" data-quick-append="${song.id}" aria-label="${esc(song.title)} 대기열 끝에 추가" title="대기열 끝에 추가">${icon('plus')}</button></div>`;
    if (card) return `<article class="collection-row rediscovery-card" data-current-id="${song.id}"><button type="button" class="recommendation-cover" data-row-play="${song.id}" aria-label="${label} 듣기">${coverMarkup(song)}</button><div class="recommendation-info"><button type="button" class="collection-play recommendation-copy" data-row-play="${song.id}" aria-label="${label} 듣기" title="${label}">${copy}</button>${append}</div></article>`;
    return `<article class="collection-row home-song" data-current-id="${song.id}"><button type="button" class="collection-play" data-row-play="${song.id}" aria-label="${label} 듣기" title="${esc(joined(song.title, metadataText(song)))}"><span class="collection-song">${coverMarkup(song)}<span>${copy}</span></span></button>${append}</article>`;
  }
  function bindRows(root, songs, source) {
    root.querySelectorAll('[data-quick-append]').forEach(button => button.addEventListener('click', () => {
      player.enqueue(Number(button.dataset.quickAppend)); toast('대기열에 추가했습니다');
    }));
    bindRowPlayback(root, id => playList(songs, source, id, false, true));
  }
  function renderBlock(root, songs, source, empty, card = false) {
    const markup = songs.length ? songs.map(song => songRow(song, card)).join('') : empty ? `<p class="section-description">${empty}</p>` : '';
    if (lastMarkup.get(root.id) === markup) return;
    lastMarkup.set(root.id, markup);
    const focused = root.contains(document.activeElement), position = contentPosition();
    const restoreFocus = retainFocus(root);
    root.innerHTML = markup;
    bindRows(root, songs, source);
    restoreFocus();
    if (focused && !root.contains(document.activeElement)) (root.querySelector('[data-row-play]') || root.closest('section').querySelector('h2')).focus({ preventScroll: true });
    if (focused) scrollContent(position);
  }
  function renderDiscoveries({ stateRequestedAt } = {}) {
    // A response requested before midnight/activation must not freeze a new
    // day's picks from yesterday's cached listening dates.
    const refreshDate = refreshRecommendationDate && state.route === 'home'
      && stateRequestedAt >= activationRequestedAt && localDateKey(stateRequestedAt) === localDateKey();
    const recommendations = daily.update(state.tracks, { refreshDate });
    if (refreshDate) refreshRecommendationDate = false;
    renderBlock(document.querySelector('#favorites-list'), recommendations.favorites, '나의 최애곡', '최애곡을 추가해 보세요', true);
    const rediscovery = document.querySelector('#rediscovery-list');
    const section = rediscovery.closest('section');
    if (!recommendations.rediscovery.length && section.contains(document.activeElement)) document.querySelector('#favorites-heading').focus({ preventScroll: true });
    section.hidden = !recommendations.rediscovery.length;
    renderBlock(rediscovery, recommendations.rediscovery, '오랜만에 꺼내는 곡', '', true);
  }
  function renderRecentListening() {
    const songs = (state.recentListening || []).map(row => track(row.id)).filter(Boolean);
    renderBlock(document.querySelector('#recent-listening-list'), songs, '최근 많이 들은 곡', '아직 감상 기록이 없습니다');
  }
  function activateHome() { refreshRecommendationDate = true; activationRequestedAt = Date.now(); }
  function onActivate() {
    if (state.route !== 'home' || document.visibilityState !== 'visible') return;
    activateHome();
    refresh().catch(() => {});
  }
  window.addEventListener('focus', onActivate);
  document.addEventListener('visibilitychange', onActivate);
  function renderQueue(force = false) {
    if (force !== true && !queuePopup.isOpen()) return;
    const root = document.querySelector('#queue-list');
    const scroller = document.querySelector('.queue-body'), scrollTop = scroller.scrollTop;
    const focused = document.activeElement;
    const entryKey = focused.closest?.('[data-entry-key]')?.dataset.entryKey;
    const action = ['play', 'up', 'down', 'remove'].find(name => focused.hasAttribute?.(`data-queue-${name}`));
    root.innerHTML = player.queue.length ? player.queue.map((row, index) => {
      const song = track(row.trackId);
      return `<article class="listening-row ${index === player.index ? 'is-queued-current' : ''}" data-entry-key="${row.key}"><span class="queue-number">${index + 1}</span>${song ? coverMarkup(song) : icon('disc')}<button class="song-link" data-queue-play="${index}"><strong>${esc(song?.title || '사용할 수 없는 곡')}</strong><small>${esc(joined(artistName(song?.artist), index === player.index ? '현재 곡' : ''))}</small></button><div class="row-actions"><button class="icon-button" data-queue-up="${index}" aria-label="${index + 1}번 곡 위로" title="위로" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button><button class="icon-button" data-queue-down="${index}" aria-label="${index + 1}번 곡 아래로" title="아래로" ${index === player.queue.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button><button class="icon-button" data-queue-remove="${index}" aria-label="${index + 1}번 곡 대기열에서 빼기" title="대기열에서 빼기">${icon('minus')}</button></div></article>`;
    }).join('') : '<div class="empty-state compact"><h2>대기열이 비었습니다</h2><p>컬렉션에서 음악을 선택해 주세요.</p><button class="secondary-button" id="queue-to-library">컬렉션 열기</button></div>';
    root.querySelector('#queue-to-library')?.addEventListener('click', () => document.querySelector('.nav-button[data-route="library"]').click());
    for (const name of ['play', 'up', 'down', 'remove']) root.querySelectorAll(`[data-queue-${name}]`).forEach(button => button.addEventListener('click', () => { const index = Number(button.getAttribute(`data-queue-${name}`)); if (name === 'play') player.select(index); if (name === 'up') player.move(index, index - 1); if (name === 'down') player.move(index, index + 1); if (name === 'remove') player.remove(index); }));
    if (entryKey && action) {
      const row = [...root.querySelectorAll('[data-entry-key]')].find(row => row.dataset.entryKey === entryKey);
      const target = row?.querySelector(`[data-queue-${action}]:not(:disabled)`) || row?.querySelector('[data-queue-play]') || root.querySelector('[data-queue-play]') || document.querySelector('#queue-close');
      target.focus({ preventScroll: true });
      scroller.scrollTop = scrollTop;
      if (queuePopup.isOpen()) revealWithin(scroller, target);
    }
    else scroller.scrollTop = scrollTop;
    document.querySelector('#queue-order-summary').textContent = `현재 재생 순서 · ${player.queue.length}곡`;
    document.querySelector('#transition-setting').value = String(player.fadeSeconds);
    document.querySelector('#queue-save-open').disabled = !player.queue.length;
    const saved = document.querySelector('#saved-queues');
    const restoreSavedFocus = retainFocus(saved);
    saved.innerHTML = (state.queues || []).map(row => `<article class="listening-row"><div class="song-link"><strong>${esc(row.name)}</strong><small>${row.trackIds.length}곡</small></div><button class="secondary-button" data-load-queue="${row.id}">불러오기</button></article>`).join('') || '<p class="section-description">대기열에 이름을 붙여 보관하세요.</p>';
    saved.querySelectorAll('[data-load-queue]').forEach(button => button.addEventListener('click', () => { const row = state.queues.find(row => row.id === Number(button.dataset.loadQueue)); player.setQueue(row.trackIds, 0, `저장한 대기열 · ${row.name}`); toast('대기열을 불러왔습니다. 재생 버튼을 눌러 주세요.'); }));
    restoreSavedFocus();
  }
  document.querySelector('#transition-setting').addEventListener('change', event => player.setTransition(event.target.value));
  const queueDialog = document.querySelector('#queue-save-dialog');
  let returnToQueue = false;
  queueDialog.addEventListener('cancel', event => { if (savingQueue) event.preventDefault(); });
  document.querySelector('#queue-save-open').addEventListener('click', () => { document.querySelector('#queue-save-error').hidden = true; returnToQueue = queuePopup.isOpen(); queuePopup.close(); openDialog(queueDialog, document.querySelector('#queue-open')); });
  queueDialog.addEventListener('close', () => {
    if (!returnToQueue) return;
    returnToQueue = false; queuePopup.open({ focus: false, current: false });
    document.querySelector('#queue-save-open').focus({ preventScroll: true });
  });
  document.querySelector('#queue-save-form').addEventListener('submit', async event => {
    event.preventDefault(); if (savingQueue) return;
    const form = event.currentTarget, controls = [...form.querySelectorAll('button,input')];
    savingQueue = true; controls.forEach(control => control.disabled = true);
    try { await post('/api/queues', { name: form.elements.name.value, trackIds: player.queue.map(row => row.trackId) }); form.reset(); queueDialog.close(); try { await refresh(); toast('대기열을 저장했습니다.'); } catch { toast('대기열을 저장했습니다. 목록은 다시 불러와 주세요.'); } }
    catch (error) { const panel = document.querySelector('#queue-save-error'); panel.textContent = error.message; panel.hidden = false; }
    finally { savingQueue = false; controls.forEach(control => control.disabled = false); }
  });
  const volumeButton = document.querySelector('#volume-open');
  const volumeSlider = document.querySelector('#mini-volume-inline');
  let audibleVolume = player.volume > 0 ? player.volume : .8;
  volumeButton.addEventListener('click', () => {
    if (player.muted || player.volume === 0) {
      if (player.volume === 0) player.volume = audibleVolume;
      player.muted = false;
    } else player.muted = true;
  });
  volumeSlider.addEventListener('input', event => {
    player.volume = event.target.value;
    player.muted = false;
  });
  const errorDialog = document.querySelector('#playback-error-dialog');
  document.querySelector('#playback-error-open').addEventListener('click', event => openDialog(errorDialog, event.currentTarget));
  player.addEventListener('error', event => { playbackError = event.detail; });
  document.querySelector('#retry-playback').addEventListener('click', () => player.paused ? player.play() : player.plan());
  document.querySelector('#skip-playback').addEventListener('click', () => player.next());
  function updateMini() {
    const song = player.track;
    const queueButton = document.querySelector('#queue-open');
    const queueHome = document.querySelector(song ? '.mini-end' : '#queue-dock');
    if (queueButton.parentElement !== queueHome) {
      const focused = document.activeElement === queueButton;
      queueHome.append(queueButton);
      if (focused) queueButton.focus({ preventScroll: true });
    }
    document.querySelector('#mini-player').hidden = !song;
    document.body.classList.toggle('has-mini-player', Boolean(song));
    if (!song) { miniId = null; loadingCue.reset(); return; }
    if (miniId !== `${song.id}:${song.artworkPath}:${song.title}`) {
      document.querySelector('#mini-track').innerHTML = `${coverMarkup(song)}<span><strong>${esc(song.title)}</strong><small ${artistName(song.artist) ? '' : 'hidden'}>${esc(artistName(song.artist))}</small></span>`;
      document.querySelector('#mini-track').title = joined(song.title, artistName(song.artist));
      miniId = `${song.id}:${song.artworkPath}:${song.title}`;
    }
    const seek = document.querySelector('#mini-seek');
    seek.max = Math.max(1, player.duration); seek.value = player.currentTime;
    seek.style.setProperty('--seek-position', `${player.duration ? player.currentTime / player.duration * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `${time(player.currentTime)} / ${time(player.duration)}`);
    document.querySelector('#mini-elapsed').textContent = time(player.currentTime);
    document.querySelector('#mini-time').textContent = time(player.duration);
    const rawLoading = /불러오는/.test(player.status);
    const loading = loadingCue.update(rawLoading, player.queue[player.index]?.key || song.id);
    const problem = /실패/.test(player.status);
    const mini = document.querySelector('#mini-player');
    mini.dataset.playbackStatus = player.status;
    const errorButton = document.querySelector('#playback-error-open');
    errorButton.hidden = !problem;
    if (problem) {
      const summary = player.status.startsWith('다음 곡 준비') ? '다음 곡을 준비하지 못했습니다.' : '음원을 재생하지 못했습니다.';
      document.querySelector('#mini-status').textContent = summary;
      document.querySelector('#playback-error-reason').textContent = playbackError || player.status;
      errorButton.setAttribute('aria-label', `${summary} 자세히 및 다시 시도`);
      errorButton.title = `${summary} · 다시 시도`;
    } else {
      playbackError = '';
      if (errorDialog.open) {
        const hadFocus = errorDialog.contains(document.activeElement);
        errorDialog.close();
        if (hadFocus) document.querySelector('#mini-play').focus({ preventScroll: true });
      }
    }
    document.querySelector('#skip-playback').disabled = !player.hasNext;
    setPlayButton(document.querySelector('#mini-play'), !player.paused, loading && rawLoading);
    document.querySelector('#mini-play').setAttribute('aria-busy', String(rawLoading));
    for (const [id, available] of [['mini-prev', player.hasPrevious], ['mini-next', player.hasNext]]) {
      const button = document.querySelector(`#${id}`), heldFocus = document.activeElement === button;
      button.disabled = !available;
      if (heldFocus && button.disabled) document.querySelector('#mini-play').focus({ preventScroll: true });
    }
    const shuffle = document.querySelector('#mini-shuffle');
    shuffle.setAttribute('aria-pressed', String(player.shuffle));
    shuffle.setAttribute('aria-label', shuffle.title = `셔플: ${player.shuffle ? '켬' : '끔'}`);
    const repeat = document.querySelector('#mini-repeat');
    repeat.setAttribute('aria-pressed', String(player.repeat !== 'off'));
    repeat.setAttribute('aria-label', repeat.title = repeatLabel());
    if (repeat.dataset.mode !== player.repeat) { repeat.innerHTML = icon(player.repeat === 'one' ? 'repeat-one' : 'repeat'); repeat.dataset.mode = player.repeat; }
    if (player.volume > 0) audibleVolume = player.volume;
    volumeSlider.value = player.muted ? '0' : String(player.volume);
    const muted = player.muted || player.volume === 0;
    volumeButton.setAttribute('aria-pressed', String(muted));
    volumeButton.setAttribute('aria-label', volumeButton.title = muted ? '음소거 해제' : '음소거');
    if (volumeButton.dataset.muted !== String(muted)) {
      volumeButton.innerHTML = icon(muted ? 'volume-x' : 'volume-2');
      volumeButton.dataset.muted = String(muted);
    }
    document.querySelectorAll('[data-current-id]').forEach(row => row.classList.toggle('is-current', Number(row.dataset.currentId) === player.trackId));
  }
  function repeatLabel() { return `반복: ${{ off: '끔', all: '전체', one: '한 곡' }[player.repeat]}`; }
  document.querySelector('#mini-shuffle').addEventListener('click', () => player.setShuffle(!player.shuffle));
  document.querySelector('#mini-repeat').addEventListener('click', () => player.setRepeat({ off: 'all', all: 'one', one: 'off' }[player.repeat]));
  document.querySelector('#mini-track').addEventListener('click', () => { if (player.trackId) openTrack(player.trackId); });
  document.querySelector('#mini-play').addEventListener('click', () => player.paused ? player.play() : player.pause());
  document.querySelector('#mini-prev').addEventListener('click', () => player.previous());
  document.querySelector('#mini-next').addEventListener('click', () => player.next());
  document.querySelector('#mini-seek').addEventListener('input', event => player.seek(event.target.value));
  player.addEventListener('change', updateMini);
  player.addEventListener('queuechange', renderQueue);
  return { activateHome, render: options => { renderDiscoveries(options); renderRecentListening(); renderQueue(); updateMini(); }, closeQueue: () => queuePopup.close() };
}
