// Main content owns page position; overlays only scroll their own bodies.
export const mainScroller = () => document.querySelector('#main-content');
export function contentPosition() {
  const main = mainScroller();
  return { left: main.scrollLeft, top: main.scrollTop };
}
export function scrollContent(position) {
  mainScroller().scrollTo({ ...position, behavior: 'instant' });
}
export function contentBounds(margin = 8) {
  const rect = mainScroller().getBoundingClientRect();
  return { top: rect.top + margin, bottom: rect.bottom - margin };
}
export function revealWithin(container, target, margin = 8) {
  if (!target || !container.contains(target)) return;
  const box = container.getBoundingClientRect(), rect = target.getBoundingClientRect();
  const top = box.top + container.clientTop + margin, bottom = box.top + container.clientTop + container.clientHeight - margin;
  const delta = rect.top < top || rect.height > bottom - top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
  if (Math.abs(delta) > .5) container.scrollBy({ top: delta, behavior: 'instant' });
}
