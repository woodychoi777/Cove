// Display only: never normalize the stored identity or import metadata.
function known(value, fallback) {
  const text = String(value ?? '').trim();
  return text === fallback ? '' : text;
}
export const artistName = value => known(value, '알 수 없는 아티스트');
export const albumName = value => known(value, '알 수 없는 앨범');
export const joined = (...values) => values.filter(Boolean).join(' · ');
export const metadataText = track => joined(artistName(track.artist), albumName(track.album));

// A display-only badge; the saved song title and exact player time stay intact.
export function longTrackLabel(durationMs) {
  return Number.isFinite(durationMs) && durationMs >= 600000 ? '긴 음악' : '';
}
