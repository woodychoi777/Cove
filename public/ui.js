import { mainScroller, contentBounds, contentPosition, revealWithin } from './scroll.js';

// Native dialogs/popovers keep the existing page and audio instance alive.
export function openDialog(dialog, trigger) {
  dialog._trigger = trigger || document.activeElement;
  if (!dialog.open) dialog.showModal();
}
export function setupDialog(dialog) {
  if (dialog._prepared) return;
  dialog._prepared = true;
  // Keep the heading and primary actions visible; only the body scrolls.
  const form = dialog.querySelector(':scope > form');
  const content = form || dialog;
  const actions = content.querySelector(':scope > .form-actions');
  const body = document.createElement('div'); body.className = 'dialog-body';
  [...content.children].filter(child => child !== actions && (form || child.tagName !== 'H2' && !child.classList.contains('dialog-heading'))).forEach(child => body.append(child));
  content.insertBefore(body, actions);
  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    // Native dialogs restore focus immediately; their queued close event can
    // arrive after the user has already entered another menu or dialog.
    const active = document.activeElement;
    if ((!active || active === document.body || dialog.contains(active)) && dialog._trigger?.isConnected) dialog._trigger.focus();
  });
}
export function menuTrigger(action) {
  return action.closest('.song-menu')?._trigger || action.closest('.song-more')?.querySelector('[data-more]') || action;
}
export function closeMenus() { document.querySelectorAll('.song-menu:popover-open').forEach(menu => menu.hidePopover()); }
// Metadata refreshes may redraw rows after an automatic track change. Restore
// the same action by song identity without moving focus to the playing song.
export function retainFocus(root) {
  let target = document.activeElement;
  if (!root.contains(target)) return () => {};
  const menu = target.closest('[popover]');
  if (menu) target = root.querySelector(`[aria-controls="${menu.id}"]`) || target;
  const rowId = target.closest('[data-current-id]')?.dataset.currentId;
  const attributes = [...target.attributes].filter(attr => attr.name.startsWith('data-') && attr.name !== 'data-icon-state');
  const id = target.id;
  return () => {
    if (target.isConnected) return;
    const scope = rowId ? [...root.querySelectorAll('[data-current-id]')].find(row => row.dataset.currentId === rowId) : root;
    const replacement = id ? document.getElementById(id) : [...(scope?.querySelectorAll('button,a,input') || [])].find(item => attributes.length && attributes.every(attr => item.getAttribute(attr.name) === attr.value));
    replacement?.focus({ preventScroll: true });
  };
}
export function bindMenus(root) {
  root.querySelectorAll('[data-more]').forEach(button => {
    const menu = root.querySelector(`#${button.getAttribute('aria-controls')}`);
    button.addEventListener('click', () => {
      if (menu.matches(':popover-open')) return menu.hidePopover();
      closeMenus(); menu.showPopover();
      const place = () => {
        const rect = button.getBoundingClientRect();
        const { top, bottom } = contentBounds();
        menu.style.maxHeight = `${Math.max(80, bottom - top)}px`;
        menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`;
        menu.style.top = `${Math.max(top, Math.min(bottom - menu.offsetHeight, rect.bottom + 4))}px`;
      };
      menu._trigger = button;
      menu._contentPosition = contentPosition();
      place(); menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    });
    menu.addEventListener('toggle', () => { const open = menu.matches(':popover-open'); menu.hidden = false; button.setAttribute('aria-expanded', String(open)); });
    menuKeys(menu, () => button);
    menu.querySelectorAll('button').forEach(action => action.addEventListener('click', () => { menu.hidePopover(); if (button.isConnected) button.focus(); }));
  });
}

function menuKeys(menu, trigger) {
  menu.setAttribute('role', 'menu');
  menu.querySelectorAll('button').forEach(button => button.setAttribute('role', 'menuitem'));
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation(); menu.hidePopover(); trigger()?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true }); revealWithin(menu, items[next]);
    }
  });
}

// Context actions belong to the row, never to the playing song. Touch uses
// a stationary long press; its release must not also start row playback.
export function bindContextMenus(root) {
  root.querySelectorAll('.collection-row').forEach(row => {
    const menu = row.querySelector('.song-menu');
    if (!menu) return;
    const trigger = row.querySelector('[data-row-play]:not(:disabled)') || row;
    if (trigger === row) row.tabIndex = 0;
    trigger.setAttribute('aria-describedby', 'collection-menu-help');
    bindContextTarget(row, menu, { trigger });
  });
}

export function bindContextTarget(row, menu, { trigger = row, controls = true, beforeOpen = () => true } = {}) {
    trigger.setAttribute('aria-haspopup', 'menu'); if (controls) trigger.setAttribute('aria-controls', menu.id);
    trigger.setAttribute('aria-expanded', 'false');
    let timer, origin, held = false;
    const stop = () => { clearTimeout(timer); timer = null; };
    const open = (x, y) => {
      if (!row.isConnected || trigger.disabled || !menu.children.length || beforeOpen() === false) return;
      closeMenus(); menu._trigger?.setAttribute('aria-expanded', 'false');
      menu._trigger = trigger; menu.showPopover(); trigger.setAttribute('aria-expanded', 'true'); menu._contentPosition = contentPosition();
      const { top, bottom } = contentBounds();
      menu.style.maxHeight = `${Math.max(44, bottom - top)}px`;
      menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, x))}px`;
      menu.style.top = `${Math.max(top, Math.min(bottom - menu.offsetHeight, y))}px`;
      menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    };
    row.addEventListener('contextmenu', event => {
      if (event.target.closest('.song-menu')) return;
      event.preventDefault(); stop(); open(event.clientX, event.clientY);
    });
    row.addEventListener('keydown', event => {
      if (event.target.closest('.song-menu')) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); event.stopPropagation();
        revealWithin(mainScroller(), trigger);
        const rect = trigger.getBoundingClientRect(); open(rect.left + 16, rect.bottom);
      }
    });
    row.addEventListener('pointerdown', event => {
      held = false;
      if (event.pointerType !== 'touch' || event.target.closest('.song-menu')) return;
      origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => { held = true; open(origin.x, origin.y); }, 550);
    });
    row.addEventListener('pointermove', event => {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) stop();
    });
    row.addEventListener('pointerup', stop); row.addEventListener('pointercancel', stop);
    row.addEventListener('click', event => {
      if (held && !event.target.closest('.song-menu')) { event.preventDefault(); event.stopImmediatePropagation(); held = false; }
    }, true);
    if (!menu._contextPrepared) {
      menu._contextPrepared = true;
      menuKeys(menu, () => menu._trigger);
      menu.addEventListener('toggle', () => {
        const open = menu.matches(':popover-open');
        const target = menu._trigger;
        target?.setAttribute('aria-expanded', String(open));
        if (!open && menu.contains(document.activeElement)) target?.focus({ preventScroll: true });
      });
      menu.querySelectorAll('button').forEach(action => action.addEventListener('click', () => {
        menu.hidePopover();
        menu._trigger?.focus({ preventScroll: true });
      }));
    }
}

// A native main button gives Enter/Space behavior; its sibling menu stays a
// separate tab stop. The article also accepts clicks on its outer blank padding.
export function bindRowPlayback(root, play) {
  root.querySelectorAll('.collection-row[data-current-id]').forEach(row => row.addEventListener('click', event => {
    if (event.target.closest('.song-more, .song-menu, .playlist-edit-actions') || event.defaultPrevented) return;
    play(Number(row.dataset.currentId));
  }));
}
