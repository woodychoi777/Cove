// App keys yield to editing, dialogs and native keyboard widgets.
export function setupPlaybackControls({ player, document: doc = document, navigator: nav = navigator, Metadata = globalThis.MediaMetadata, alarmActive = () => false, openTrack = () => {}, leaveLyrics = () => {}, selectList = () => {}, nativeBridge = globalThis.coveMedia }) {
  const blocked = target => target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="tab"], [role="slider"], [role="menu"], [role="listbox"], [role="combobox"], audio, video');
  const editing = target => target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"], [role="combobox"], audio, video');
  let spaceHeld = false;
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing || alarmActive() || doc.querySelector('dialog[open], [popover]:popover-open')) return;
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && /^[1-5]$/.test(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) selectList(Number(event.key) - 1);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      if (doc.body?.dataset.route !== 'detail') return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) leaveLyrics();
      return;
    }
    if (event.code === 'Space' || event.key === ' ') {
      if (editing(event.target) || editing(doc.activeElement)) return;
      // Consume even on playlist tabs, so the native Space click cannot select a list.
      event.preventDefault(); event.stopPropagation(); spaceHeld = true;
      if (player.trackId && !event.repeat) { if (player.paused) void player.play(); else player.pause(); }
      return;
    }
    if (blocked(event.target) || blocked(doc.activeElement)) return;
    if (event.key === 'Enter') {
      // Preserve explicit buttons/links; on the main surface Enter opens lyrics.
      if (!player.trackId || event.target?.closest?.('button, a, [role="button"]')) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) void openTrack(player.trackId);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const next = Math.max(0, Math.min(1, Math.round((player.volume + (event.key === 'ArrowUp' ? .05 : -.05)) * 100) / 100));
      if (event.key === 'ArrowUp' && player.muted) player.muted = false;
      player.volume = next;
    } else if (!event.repeat) {
      if (event.key === 'ArrowLeft' && player.hasPrevious) void player.previous();
      if (event.key === 'ArrowRight' && player.hasNext) void player.next();
    }
  };
  const keyup = event => {
    if (!spaceHeld || !(event.code === 'Space' || event.key === ' ')) return;
    spaceHeld = false; event.preventDefault(); event.stopPropagation();
  };
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('keyup', keyup, true);
  const media = nativeBridge ? null : nav.mediaSession;
  let metadataKey = '';
  const seekTo = value => {
    if (!player.trackId || !Number.isFinite(value)) return;
    const duration = player.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    return player.seek(Math.max(0, Math.min(duration, value)));
  };
  const seekBy = (direction, details = {}) => {
    const offset = details.seekOffset === undefined ? 10 : details.seekOffset;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset <= 0) return;
    return seekTo((player.currentTime || 0) + direction * offset);
  };
  const actions = {
    toggle: () => player.trackId && (player.paused ? player.play() : player.pause()),
    play: () => player.trackId && player.play(),
    pause: () => player.trackId && player.pause(),
    stop: () => { if (player.trackId) { player.pause(); return seekTo(0); } },
    previoustrack: () => player.hasPrevious && player.previous(),
    nexttrack: () => player.hasNext && player.next(),
    seekbackward: details => seekBy(-1, details),
    seekforward: details => seekBy(1, details),
    seekto: details => seekTo(details?.seekTime)
  };
  const registered = [];
  if (media) {
    for (const [action, fn] of Object.entries(actions)) {
      if (action === 'toggle') continue;
      try {
        media.setActionHandler(action, details => { if (!alarmActive()) void fn(details); });
        registered.push(action);
      } catch { /* Older engines can lack individual media actions. */ }
    }
  }
  let nativeReady = false, nativeTimer, seekTimer, seekWatchdog;
  const stopSeek = () => { clearInterval(seekTimer); clearTimeout(seekWatchdog); seekTimer = null; };
  const unsubscribe = nativeBridge?.onAction(details => {
    if (details.phase === 'end') return stopSeek();
    if (alarmActive()) return stopSeek();
    const fn = actions[details.action]; if (!fn) return;
    if (details.phase === 'begin') {
      stopSeek(); void fn({ seekOffset: 5 });
      seekTimer = setInterval(() => { if (alarmActive() || player.paused) return stopSeek(); void fn({seekOffset:5}); }, 500);
      seekWatchdog = setTimeout(stopSeek, 30000);
    } else { stopSeek(); void fn(details); }
  });
  if (nativeBridge) void nativeBridge.ready().then(ready => { nativeReady = ready; sync(); });
  const sync = () => {
    if (nativeReady) {
      clearTimeout(nativeTimer);
      // Coalesce the 100 ms player clock while publishing transport changes immediately.
      const publish = () => { const track = player.track; nativeBridge.update({ id: track?.id || 0, title: track?.title || '', artist: track?.artist || '', album: track?.album || '', paused: player.paused, position: player.currentTime || 0, duration: player.duration || 0 }); };
      const identity = `${player.trackId}:${player.paused}`;
      if (sync.identity !== identity) { sync.identity = identity; publish(); }
      else if (Date.now() - (sync.last || 0) >= 1000) { sync.last = Date.now(); publish(); }
    }
    if (!media) return;
    const track = player.track;
    const key = track ? JSON.stringify([track.id, track.title, track.artist, track.album, track.artworkPath]) : '';
    if (key !== metadataKey) {
      metadataKey = key;
      try { media.metadata = track && Metadata ? new Metadata({ title: track.title, artist: track.artist || '', album: track.album || '', artwork: track.artworkPath ? [{ src: new URL(`/api/tracks/${track.id}/artwork`, doc.baseURI).href }] : [] }) : null; } catch {}
    }
    media.playbackState = !track ? 'none' : player.paused ? 'paused' : 'playing';
    if (media.setPositionState) try {
      const duration = player.duration;
      media.setPositionState(track && Number.isFinite(duration) && duration > 0 ? { duration, playbackRate: 1, position: Math.max(0, Math.min(duration, player.currentTime || 0)) } : undefined);
    } catch {}
  };
  player.addEventListener('change', sync); sync();
  return () => {
    doc.removeEventListener('keydown', keydown, true); doc.removeEventListener('keyup', keyup, true); player.removeEventListener('change', sync);
    stopSeek(); clearTimeout(nativeTimer); unsubscribe?.();
    for (const action of registered) media.setActionHandler(action, null);
    if (media) { media.metadata = null; media.playbackState = 'none'; }
  };
}
