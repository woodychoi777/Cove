import { t } from './i18n.js';
import { openDialog, menuTrigger } from './ui.js';

export function setupTitleEditor({ getTrack, getToken, onSaved, toast }) {
  const dialog = document.querySelector('#title-dialog'), form = document.querySelector('#title-form');
  const input = form.elements.title, save = form.querySelector('.primary-button'), cancel = form.querySelector('[data-dialog-close]');
  const error = document.querySelector('#title-error');
  let id, busy = false, returnControl;
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-edit-title]');
    if (!action) return;
    if (busy) return toast(t('곡 이름을 저장 중입니다. 잠시 후 다시 열어 주세요.'));
    const track = getTrack(Number(action.dataset.editTitle));
    if (!track) return;
    id = track.id; input.value = track.title; error.hidden = true;
    const trigger = menuTrigger(action);
    returnControl = trigger.getAttribute('aria-controls') ? `[aria-controls="${CSS.escape(trigger.getAttribute('aria-controls'))}"]` : `#library-grid [data-row-play="${id}"]`;
    openDialog(dialog, trigger);
    input.focus(); input.select();
  });
  dialog.addEventListener('close', () => {
    if (!dialog._trigger?.isConnected) (document.querySelector(returnControl) || document.querySelector('#settings-open'))?.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const title = input.value.trim();
    if (!title || title.length > 300) { error.textContent = !title ? t('곡 이름을 입력해 주세요.') : t('곡 이름은 300자 이하로 입력해 주세요.'); error.hidden = false; input.focus(); return; }
    const submittedId = id;
    busy = true; input.disabled = save.disabled = true; cancel.textContent = t('닫기'); error.hidden = true;
    try {
      const response = await fetch(`/api/tracks/${submittedId}/title`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-local-token': getToken() }, body: JSON.stringify({ title }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t('곡 이름을 저장하지 못했습니다.'));
      onSaved(result); dialog.close();
    } catch (reason) {
      error.textContent = t(reason.message) || t('곡 이름을 저장하지 못했습니다. 다시 시도해 주세요.'); error.hidden = false;
      if (!dialog.open) toast(error.textContent);
    } finally { busy = false; input.disabled = save.disabled = false; cancel.textContent = t('취소'); }
  });
}
