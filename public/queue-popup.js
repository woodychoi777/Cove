import { closeMenus } from './ui.js';
import { revealWithin } from './scroll.js';

// A non-modal panel: playback and the page underneath keep their own state.
export function setupQueuePopup({ onOpen }) {
  const button = document.querySelector('#queue-open');
  const panel = document.querySelector('#queue-panel');
  let dismissPointer = null;
  const isOpen = () => panel.matches(':popover-open');
  function close(restoreFocus = false) {
    if (!isOpen()) return;
    panel.hidePopover();
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
  }
  function open({ focus = true, current = true } = {}) {
    if (isOpen()) return;
    closeMenus();
    onOpen();
    panel.showPopover();
    button.setAttribute('aria-expanded', 'true');
    if (focus) document.querySelector('#queue-close').focus({ preventScroll: true });
    if (current) requestAnimationFrame(() => revealWithin(panel.querySelector('.queue-body'), panel.querySelector('.is-queued-current')));
  }
  button.addEventListener('click', () => isOpen() ? close(true) : open());
  document.querySelector('#queue-close').addEventListener('click', () => close(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
  }, true);
  document.addEventListener('pointerdown', event => {
    dismissPointer = null;
    if (!isOpen() || panel.contains(event.target) || button.contains(event.target) || event.target.closest('[data-quick-append]')) return;
    // Transport and explicit navigation remain intentional actions. A background
    // song/lyric click first dismisses the panel without starting that song.
    const intentional = event.target.closest('#mini-player, .nav-button, .top-tools, .collection-tools, button[data-route], a[data-route]');
    if (!intentional) { dismissPointer = event.pointerId; event.preventDefault(); event.stopPropagation(); }
    close(panel.contains(document.activeElement));
  }, true);
  document.addEventListener('click', event => {
    if (dismissPointer !== null && event.pointerId === dismissPointer) {
      dismissPointer = null; event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('focusin', event => {
    if (isOpen() && !panel.contains(event.target) && event.target !== button && !event.target.closest('[data-quick-append]')) close();
  });
  document.addEventListener('beforetoggle', event => {
    if (event.target.matches('dialog') && event.newState === 'open') close();
  }, true);
  return { open, close, isOpen };
}
