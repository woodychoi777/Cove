import { t } from './i18n.js';
// One local SVG family; no remote assets or runtime icon dependency.
const paths = {
  'cove-brand': '<g transform="rotate(0 48 48)"><path d="M21 52V43a27 27 0 0 1 54 0v9" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M28 35c3-8 10-12 20-12s17 4 20 12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><g transform="rotate(-10 24 60)"><path d="M23 43v11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="14" y="51" width="15" height="29" rx="7" fill="currentColor"/><rect x="32" y="54" width="6" height="23" rx="3" fill="currentColor"/></g><g transform="rotate(10 72 60)"><path d="M73 43v11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="67" y="51" width="15" height="29" rx="7" fill="currentColor"/><rect x="58" y="54" width="6" height="23" rx="3" fill="currentColor"/></g></g>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  library: '<path d="M4 6v14M8 4v16M12 8v12M16 4l4 16"/>',
  'mic-vocal': '<path d="m7 12 5 5m-3-7 5 5M6 13l-3 8 8-3"/><circle cx="16" cy="8" r="5"/>',
  'list-music': '<path d="M4 6h12M4 11h8M4 16h6m8-9v11l4-1V6l-4 1Z"/><circle cx="15" cy="18" r="3"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
  'skip-back': '<path d="M5 5v14m14-14L7 12l12 7Z"/>', 'skip-forward': '<path d="M19 5v14M5 5l12 7-12 7Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  'volume-2': '<path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  'volume-x': '<path d="m11 5-6 4H2v6h3l6 4V5Zm5 4 5 6m0-6-5 6"/>',
  ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  'settings-2': '<path d="M3 7h6m4 0h8M3 17h10m4 0h4"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  'image-plus': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 5 5m-2-2 3-3 7 7M16 6h4m-2-2v4"/>',
  'file-text': '<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h8"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10H3Z"/>',
  'arrow-up': '<path d="m6 10 6-6 6 6m-6-6v16"/>', 'arrow-down': '<path d="m6 14 6 6 6-6m-6 6V4"/>',
  'arrow-left': '<path d="m10 5-7 7 7 7M3 12h18"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M7 10a5 5 0 0 1 3-3m7 7a5 5 0 0 1-3 3"/>',
  'rotate-ccw': '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>', 'rotate-cw': '<path d="M21 10a9 9 0 1 0-2 8m2-14v6h-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>', x: '<path d="m6 6 12 12M18 6 6 18"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  'message-circle': '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  shuffle: '<path d="m18 3 4 4-4 4M2 17h3c5 0 6-10 11-10h6M2 7h3c2 0 3 1 4 3m4 4c1 2 2 3 4 3h5m-4-4 4 4-4 4"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>',
  'repeat-one': '<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3m8-7 2-1v5"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6-8.5"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v1"/>'
};
export function icon(name) {
  const brand = name === 'cove-brand';
  return `<svg class="icon icon-${name}" viewBox="0 0 ${brand ? '96 96' : '24 24'}" ${brand ? '' : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true" focusable="false">${paths[name] || paths.disc}</svg>`;
}
export function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
export function setPlayButton(button, playing, loading = false) {
  const name = loading ? 'loader' : playing ? 'pause' : 'play';
  if (button.dataset.iconState !== name) { button.innerHTML = icon(name); button.dataset.iconState = name; }
  const label = playing ? t('일시정지') : t('재생');
  button.setAttribute('aria-label', label); button.title = loading ? t('불러오는 중') : label;
  button.setAttribute('aria-busy', String(loading));
}
