// Current song-page entry points; settings belong to other pages.
export async function leaveListening(page) {
  if (await page.locator('body').evaluate(el => el.classList.contains('is-listening'))) await page.locator('[data-detail-back]').click();
}
export async function navigateTo(page, route) {
  await leaveListening(page);
  await page.locator(`.nav-button[data-route="${route}"]`).click();
}
export async function openImport(page) {
  await navigateTo(page, 'library');
  await page.locator('#collection-add').click();
}
// Song context menus now contain queue/list actions only. Open lyrics through
// the playing row and common player, keeping an already-current song untouched.
export async function openCollectionSong(page, id) {
  const current = await page.evaluate(() => { const q = JSON.parse(localStorage.getItem('soriseojae.queue') || 'null'); return q?.ids[q.index]; });
  if (current !== id) {
    await page.locator(`#library-grid [data-row-play="${id}"]`).click();
    await page.waitForFunction(id => {
      const q = JSON.parse(localStorage.getItem('soriseojae.queue') || 'null');
      return q?.ids[q.index] === id && !/불러오는|준비/.test(document.querySelector('#mini-player').dataset.playbackStatus || '');
    }, id);
    if (await page.locator('#mini-play').getAttribute('aria-label') === '일시정지') await page.locator('#mini-play').click();
  }
  await page.locator('#mini-track').click();
  await page.locator(`#notes-form[data-track-id="${id}"]`).waitFor({ state: 'visible' });
}
export async function lyricsViewportFits(page) {
  return page.locator('[data-lyrics-lines]').evaluate(el => {
    const r = el.getBoundingClientRect(), player = document.querySelector('#mini-player');
    const bottom = (player.hidden ? innerHeight : player.getBoundingClientRect().top) - 8;
    const stageElement = el.closest('.detail-stage');
    const stage = stageElement.getBoundingClientRect();
    const heading = stageElement.querySelector('.detail-copy').getBoundingClientRect().height;
    const headingSettled = Math.abs(parseFloat(stageElement.style.getPropertyValue('--heading-height')) - heading) < 1;
    return headingSettled && Math.abs(stage.bottom - bottom) < 1 && r.top >= 8 && r.bottom <= bottom + 1 && r.height >= 80 && r.height <= 761;
  });
}
export async function songMenu(page, action) {
  if (['[data-comments]', '[data-favorite]', '[data-edit-info]'].includes(action)) { await page.locator(`#detail-content ${action}`).click(); return; }
  await page.locator('#detail-content [data-more]').click();
  await page.locator(`.song-menu:popover-open ${action}`).click();
}
export async function openComments(page) { await songMenu(page, '[data-comments]'); }
export async function toggleManage(page, detail = true) {
  if (detail) {
    await page.locator('[data-view="detail"]').waitFor({ state: 'visible' });
    if (await page.locator('body').getAttribute('data-app-mode') === 'edit') await page.locator('[data-listen-preview]').click();
    else await songMenu(page, '[data-edit-lyrics]');
  } // Editing is local to the song form; other actions need no mode switch.
}

export async function ensureLyricsEditing(page) {
  await page.locator('[data-view="detail"]').waitFor({ state: 'visible' });
  if (await page.locator('body').getAttribute('data-app-mode') !== 'edit') await songMenu(page, '[data-edit-lyrics]');
}
