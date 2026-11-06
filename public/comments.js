import { t } from './i18n.js';
import { TrackDrafts } from './drafts.js';

export const commentText = track => ['meaning', 'favoriteReason', 'memory'].map(key => track[key] || '').filter(value => value !== '').join('\n\n');

export function setupComments({ getTrack, onSaved, toast }) {
  const dialog = document.querySelector('#comments-dialog'), form = document.querySelector('#comments-form');
  const input = form.elements.comment, save = form.querySelector('.primary-button');
  const error = document.querySelector('#comments-error'), dirty = document.querySelector('#comments-draft');
  const drafts = new TrackDrafts(['comment']), inFlight = new Set(), errors = new Map();
  let selectedId = null;
  const update = () => {
    dirty.hidden = !drafts.get(selectedId);
    save.disabled = inFlight.has(selectedId);
    error.textContent = errors.get(selectedId) || '';
    error.hidden = !error.textContent;
  };
  input.addEventListener('input', () => { drafts.update(selectedId, { comment: input.value }); update(); });
  const isOpen = () => dialog.matches(':popover-open');
  const trigger = () => dialog._trigger?.isConnected ? dialog._trigger : document.querySelector(`#detail-content [data-comments="${selectedId}"]`);
  function close(restoreFocus = false) {
    if (!isOpen()) return;
    dialog.hidePopover();
    if (restoreFocus) trigger()?.focus({ preventScroll: true });
  }
  function place() {
    if (!isOpen()) return;
    const button = trigger();
    if (!button) return close();
    const rect = button.getBoundingClientRect(), player = document.querySelector('#mini-player');
    const bottom = (player.hidden ? innerHeight : player.getBoundingClientRect().top) - 12;
    dialog.style.maxHeight = `${Math.max(120, bottom - 12)}px`;
    const below = rect.bottom + 8, height = dialog.offsetHeight;
    const top = below + height <= bottom ? below : rect.top - height - 8 >= 12 ? rect.top - height - 8 : Math.max(12, bottom - height);
    dialog.style.top = `${top}px`;
    dialog.style.left = `${Math.max(12, Math.min(innerWidth - dialog.offsetWidth - 12, rect.right - dialog.offsetWidth))}px`;
  }
  dialog.querySelector('[data-dialog-close]').addEventListener('click', () => close(true));
  dialog.addEventListener('toggle', () => {
    trigger()?.setAttribute('aria-expanded', String(isOpen()));
    if (!isOpen() && (dialog.contains(document.activeElement) || document.activeElement === document.body)) trigger()?.focus({ preventScroll: true });
  });
  window.addEventListener('resize', place);
  document.addEventListener('scroll', event => { if (event.target.contains?.(trigger())) place(); }, true);
  let dismissPointer = null;
  document.addEventListener('pointerdown', event => {
    dismissPointer = null;
    if (!isOpen() || dialog.contains(event.target) || trigger()?.contains(event.target)) return;
    const intentional = event.target.closest('#mini-player, .nav-button, [data-detail-back], [data-favorite], [data-edit-info]');
    if (!intentional) { dismissPointer = event.pointerId; event.preventDefault(); event.stopPropagation(); }
    close();
  }, true);
  document.addEventListener('click', event => {
    if (dismissPointer === event.pointerId) { dismissPointer = null; event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const id = selectedId;
    if (inFlight.has(id)) return;
    const submitted = { comment: input.value };
    drafts.startSave(id, submitted); inFlight.add(id); errors.delete(id); update();
    try {
      const response = await fetch(`/api/tracks/${id}/comments`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submitted) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t('코멘트를 저장하지 못했습니다.'));
      drafts.saved(id, submitted);
      onSaved(result);
      toast(t('코멘트 저장됨'));
    } catch (reason) {
      drafts.failed(id);
      errors.set(id, t(reason.message) || t('연결을 확인하고 다시 저장해 주세요.'));
      if (!isOpen() || selectedId !== id) toast(errors.get(id));
    } finally {
      inFlight.delete(id);
      if (selectedId === id) update();
    }
  });
  return {
    isSaving: id => inFlight.has(id),
    forget: id => { drafts.records.delete(id); errors.delete(id); },
    hasUnsaved: () => drafts.size > 0,
    open(id, trigger) {
      const track = getTrack(id);
      if (!track) return;
      if (isOpen() && selectedId === id) { close(true); return; }
      if (isOpen()) close();
      selectedId = id;
      dialog.dataset.trackId = String(id);
      document.querySelector('#comments-track-title').textContent = track.title;
      input.value = drafts.open(id, { comment: commentText(track) }).comment;
      update(); dialog._trigger = trigger;
      dialog.showPopover(); place(); input.focus({ preventScroll: true });
    }
  };
}
