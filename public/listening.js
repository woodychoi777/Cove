export function albumTracks(tracks, track) {
  return tracks.filter(item => item.albumId === track.albumId).sort((a, b) =>
    (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 999) - (b.trackNumber || 999) || a.id - b.id);
}

// Capture the displayed order at the user's click; later searches never mutate it.
export async function playDisplayedList(player, tracks, { source, startId = tracks[0]?.id, toggleCurrent = false, resumeCurrent = false } = {}) {
  const ids = tracks.map(track => track.id);
  const index = ids.indexOf(startId);
  if (index < 0) return;
  player.ensureContext();
  if ((toggleCurrent || resumeCurrent) && player.trackId === startId) {
    if (player.paused) await player.play();
    else if (toggleCurrent) player.pause();
    return;
  }
  player.setQueue(ids, index, source);
  await player.play();
}

export function rediscoveryCandidates(tracks, now = Date.now()) {
  const threshold = now - 90 * 86400000;
  return tracks.map(track => ({ track, at: utcTimestamp(track.lastPlayedAt == null || track.lastPlayedAt === '' ? track.createdAt : track.lastPlayedAt) }))
    .filter(({ at }) => Number.isFinite(at) && at <= threshold)
    .map(({ track }) => track);
}
// Retained utility for callers needing age order; Today uses daily random picks.
export function rediscover(tracks, now = Date.now()) {
  return rediscoveryCandidates(tracks, now).sort((a, b) =>
    utcTimestamp(a.lastPlayedAt || a.createdAt) - utcTimestamp(b.lastPlayedAt || b.createdAt) || a.id - b.id).slice(0, 2);
}

// SQLite timestamps are UTC; preserve explicit ISO offsets. Missing or malformed
// dates never become epoch-zero recommendations (including impossible dates).
function utcTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second] = parts;
  if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate() || +hour > 23 || +minute > 59 || +second > 59) return NaN;
  return Date.parse(value.replace(' ', 'T') + (parts[8] ? '' : 'Z'));
}

export function randomPick(items, previous, random = Math.random) {
  const pool = items.length > 1 ? items.filter(item => item !== previous) : items;
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}

export function shuffled(items, random = Math.random) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function transitionPlan(now, end, nextDuration, seconds) {
  const fade = Math.max(0, Math.min(seconds, (end - now - 0.05) / 2, nextDuration / 2));
  return { start: Math.max(now + 0.025, end - fade), fade };
}
