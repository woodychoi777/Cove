import { mainScroller, contentPosition, revealWithin } from './scroll.js';
import { closeMenus } from './ui.js';

// The shell excludes the measured player; each scroll owner reveals its focus.
export function setupFocusVisibility() {
  const player = document.querySelector('#mini-player');
  const sidebar = document.querySelector('.sidebar');
  const root = document.documentElement;
  const margin = 8;
  let frame;

  function revealFocus() {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || !target.closest('main') || target.closest('dialog, [popover], [data-lyrics-lines]') || !target.getClientRects().length) return;
    revealWithin(mainScroller(), target, margin);
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(revealFocus);
  }
  function measure() {
    const height = player.hidden ? 0 : Math.ceil(player.getBoundingClientRect().height);
    const top = getComputedStyle(sidebar).position === 'sticky' ? Math.ceil(sidebar.getBoundingClientRect().height) : 0;
    document.body.style.setProperty('--player-height', `${height}px`);
    root.style.setProperty('--focus-top', `${top + margin}px`);
    root.style.setProperty('--focus-bottom', `${height + margin}px`);
    schedule();
  }
  const observer = new ResizeObserver(measure);
  observer.observe(player);
  observer.observe(sidebar);
  mainScroller().addEventListener('scroll', () => {
    const position = contentPosition();
    // A queued event from revealing the trigger can arrive after its menu opens.
    if ([...document.querySelectorAll('.song-menu:popover-open')].some(menu => menu._contentPosition && (Math.abs(menu._contentPosition.top - position.top) > .5 || Math.abs(menu._contentPosition.left - position.left) > .5))) closeMenus();
  }, { passive: true });
  document.addEventListener('focusin', schedule);
  window.addEventListener('resize', measure);
  measure();
}
