import { rediscoveryCandidates, shuffled } from './listening.js';

export const DAILY_RECOMMENDATIONS_KEY = 'soriseojae.today-recommendations.v1';
export function localDateKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function validSnapshot(value) {
  return value?.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && ['favorites', 'rediscovery'].every(key => Array.isArray(value[key]) && value[key].length <= (key === 'favorites' ? 4 : 2)
      && value[key].every(id => Number.isSafeInteger(id) && id > 0) && new Set(value[key]).size === value[key].length);
}
function fill(selected, candidates, random, limit = 2) {
  if (selected.length >= limit) return selected;
  const available = candidates.filter(id => !selected.includes(id));
  return [...selected, ...shuffled(available, random).slice(0, limit - selected.length)];
}

// Pure selection: no playback, metadata writes, UTC-date shortcuts or day-wide re-shuffle.
export function selectDailyRecommendations(tracks, previous, { now = Date.now(), random = Math.random, refreshDate = true } = {}) {
  const today = localDateKey(now);
  const prior = validSnapshot(previous) && (previous.date === today || !refreshDate) ? previous : null;
  const library = new Map(tracks.map(track => [track.id, track]));
  const favoritePool = tracks.filter(track => track.isLifeSong).map(track => track.id);
  const retainedFavorites = (prior?.favorites || []).filter(id => library.get(id)?.isLifeSong);
  let favorites = fill(retainedFavorites.slice(0, 2), favoritePool, random);
  // Preserve today's rediscovery snapshot after listening, irrespective of a new lastPlayedAt.
  let rediscovery = (prior?.rediscovery || []).filter(id => library.has(id));
  const eligible = rediscoveryCandidates(tracks, now).map(track => track.id);
  rediscovery = fill(rediscovery, eligible.filter(id => !favorites.includes(id)), random);
  rediscovery = fill(rediscovery, eligible, random);
  // Keep the existing daily order when expanding an older two-card snapshot.
  if (!rediscovery.length) favorites = fill(retainedFavorites.length > 2 ? retainedFavorites : favorites, favoritePool, random, 4);
  return { version: 1, date: prior?.date || today, favorites, rediscovery };
}

export function createDailyRecommendations({ storage, now = () => Date.now(), random = Math.random, key = DAILY_RECOMMENDATIONS_KEY } = {}) {
  let snapshot = null;
  function read() {
    try { const value = JSON.parse(storage?.getItem(key) || 'null'); return validSnapshot(value) ? value : null; }
    catch { return null; }
  }
  snapshot = read();
  return {
    update(tracks, { refreshDate = false } = {}) {
      const stored = read();
      // Adopt same-day updates from another window. A new date is applied only
      // at a Today entry/activation, never from an ordinary playback refresh.
      if (stored && (!snapshot || stored.date === snapshot.date || refreshDate)) snapshot = stored;
      const next = selectDailyRecommendations(tracks, snapshot, { now: now(), random, refreshDate });
      try { if (JSON.stringify(next) !== storage?.getItem(key)) storage?.setItem(key, JSON.stringify(next)); } catch { /* Memory remains stable if storage is unavailable. */ }
      snapshot = next;
      const byId = new Map(tracks.map(track => [track.id, track]));
      return { favorites: snapshot.favorites.map(id => byId.get(id)), rediscovery: snapshot.rediscovery.map(id => byId.get(id)) };
    }
  };
}
