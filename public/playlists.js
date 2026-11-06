import { icon } from './icons.js';
import { openDialog, menuTrigger, bindContextTarget, closeMenus } from './ui.js';
import { artistName, metadataText } from './metadata-display.js';

export function setupPlaylists({ state, render, navigate, invalidate, toast, esc, cover }) {
  const $ = id => document.getElementById(id);
  const edits = new Map(), notices = new Map();
  let menuTarget = null;
  let selectedId = null, generation = 0, nameTarget = null, nameDone = false, nameInitial = '';
  let pick = null, targetSong = null, deleteTarget = null, tabsMarkup = '';
  const selected = () => state.playlists?.find(row => row.id === selectedId) || edits.get(selectedId)?.base || null;
  const editing = () => edits.get(selectedId);
  const isBusy = dialog => dialog.dataset.pending === 'true';
  function busy(dialog, value) {
    dialog.dataset.pending = String(value);
    for (const control of dialog.querySelectorAll('button,input,select')) {
      if (value) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
      else control.disabled = control.dataset.wasDisabled === 'true';
    }
  }
  for (const id of ['playlist-name-dialog', 'playlist-add-dialog', 'playlist-target-dialog', 'playlist-delete-dialog']) {
    $(id).addEventListener('cancel', event => { if (isBusy($(id))) event.preventDefault(); });
  }
  function apply(row, deleted = false) {
    generation++; invalidate();
    state.playlists = (state.playlists || []).filter(item => item.id !== row.id);
    if (!deleted) state.playlists.push(row);
    state.playlists.sort((a, b) => a.id - b.id);
  }
  async function request(path = '', method = 'GET', body) {
    let response;
    try { response = await fetch('/api/playlists' + path, { method, headers: { 'Content-Type': 'application/json', 'x-local-token': state.localToken }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('연결을 확인하고 다시 시도해 주세요.'); }
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || '플레이리스트를 저장하지 못했습니다.'), value);
    return value;
  }
  async function refresh() {
    const version = generation;
    const rows = await request();
    if (version !== generation) return;
    generation++; invalidate(); state.playlists = rows; render();
  }
  function error(scope, reason) {
    $(scope + '-error').textContent = reason.message; $(scope + '-error').hidden = false;
    $(scope + '-reload').hidden = reason.code !== 'REVISION_CONFLICT';
    if (reason.current) apply(reason.current);
    if (reason.code === 'NOT_FOUND') refresh().then(() => { if ($('playlist-target-dialog').open) renderTargets(); }).catch(() => {});
  }
  function clearError(scope) { $(scope + '-error').hidden = true; $(scope + '-reload').hidden = true; }
  function showNotice(reason) {
    if (reason.current) apply(reason.current);
    notices.set(selectedId, reason); render();
    if (reason.code === 'NOT_FOUND') refresh().catch(() => {});
  }
  const tabs = $('playlist-tabs');
  const tabFor = id => tabs.querySelector(`[data-playlist-id="${id ?? ''}"]`);
  function revealTab(tab) {
    if (!tab) return;
    const box = tabs.getBoundingClientRect(), rect = tab.getBoundingClientRect();
    const delta = rect.left < box.left + 4 ? rect.left - box.left - 4 : rect.right > box.right - 4 ? rect.right - box.right + 4 : 0;
    if (delta) tabs.scrollBy({ left: delta, behavior: 'instant' });
  }
  function focusSelectedTab() { const tab = tabFor(selectedId); tab?.focus(); revealTab(tab); }
  function choose(id) {
    if (editing()?.busy) return;
    if (selectedId === id) { revealTab(tabFor(id)); return; }
    selectedId = id;
    $('search-input').value = ''; render(); revealTab(tabFor(id));
  }
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"]'); if (!tab || tab.disabled) return;
    choose(tab.dataset.playlistId ? Number(tab.dataset.playlistId) : null);
    focusSelectedTab();
  });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const available = [...tabs.querySelectorAll('[role="tab"]:not(:disabled)')];
    if (!available.length) return;
    event.preventDefault();
    const index = available.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
    available.forEach((tab,i) => tab.tabIndex = i === next ? 0 : -1);
    available[next].focus(); revealTab(available[next]);
  });
  tabs.addEventListener('focusin', event => revealTab(event.target.closest('[role="tab"]')));
  function openSettings() {
    navigate('library'); $('playlist-create').focus();
  }
  function openName(row = null) {
    nameTarget = row ? { ...row } : null; nameDone = false; clearError('playlist-name');
    const names = new Set((state.playlists || []).map(row => row.name.toLocaleLowerCase('ko')));
    let proposal = '새 플레이리스트', suffix = 2;
    while (names.has(proposal.toLocaleLowerCase('ko'))) proposal = `새 플레이리스트 ${suffix++}`;
    nameInitial = row?.name || proposal;
    $('playlist-name-heading').textContent = row ? '이름 변경' : '새 플레이리스트';
    $('playlist-name-form').elements.name.value = nameInitial;
    $('playlist-name-form').querySelector('.primary-button').textContent = row ? '저장' : '만들기';
    const trigger = row ? tabFor(row.id) : $('playlist-create');
    $('settings-dialog').close(); closeMenus(); openDialog($('playlist-name-dialog'), trigger);
    $('playlist-name-form').elements.name.focus(); $('playlist-name-form').elements.name.select();
  }
  $('playlist-create').addEventListener('click', () => openName());
  $('playlist-rename').addEventListener('click', () => { const row = state.playlists.find(row => row.id === menuTarget); if (row) openName(row); });
  $('playlist-name-dialog').addEventListener('close', () => { if (!nameTarget && !nameDone) $('playlist-create').focus(); });
  $('playlist-name-form').addEventListener('submit', async event => {
    event.preventDefault(); const dialog = $('playlist-name-dialog'); if (isBusy(dialog)) return;
    const value = event.currentTarget.elements.name.value.trim();
    if (!value || value.length > 100) { error('playlist-name', new Error('이름을 1~100자로 입력해 주세요.')); event.currentTarget.elements.name.focus(); return; }
    busy(dialog, true); clearError('playlist-name');
    try {
      const result = nameTarget ? await request('/' + nameTarget.id, 'PATCH', { name: value, revision: nameTarget.revision }) : await request('', 'POST', { name: value });
      apply(result); nameDone = true; dialog.close();
      if (!nameTarget) { choose(result.id); navigate('library'); }
      else render();
      const target = tabFor(nameTarget ? result.id : selectedId);
      target?.focus(); revealTab(target);
    } catch (reason) { error('playlist-name', reason); }
    finally { busy(dialog, false); }
  });
  $('playlist-name-reload').addEventListener('click', async () => {
    try { nameTarget = await request('/' + nameTarget.id); apply(nameTarget); nameInitial = nameTarget.name; $('playlist-name-form').elements.name.value = nameTarget.name; clearError('playlist-name'); render(); }
    catch (reason) { error('playlist-name', reason); }
  });

  function renderPick() {
    if (!pick) return;
    const query = $('playlist-add-search').value.trim().toLocaleLowerCase('ko');
    const tracks = pick.tracks.filter(row => `${row.title} ${metadataText(row)}`.toLocaleLowerCase('ko').includes(query));
    $('playlist-add-list').innerHTML = tracks.map(row => {
      const included = pick.base.trackIds.includes(row.id);
      return `<label class="playlist-pick-row"><input type="checkbox" data-pick-track="${row.id}" ${included ? 'checked disabled' : pick.ids.has(row.id) ? 'checked' : ''}>${cover(row)}<span><strong>${esc(row.title)}</strong>${artistName(row.artist) ? `<small>${esc(artistName(row.artist))}</small>` : ''}</span>${included ? '<small>추가됨</small>' : ''}</label>`;
    }).join('') || (pick.tracks.length ? '<p>검색 결과가 없습니다.</p>' : '');
    $('playlist-add-list').querySelectorAll('[data-pick-track]').forEach(input => input.addEventListener('change', () => {
      const id = Number(input.dataset.pickTrack); if (input.checked) pick.ids.add(id); else pick.ids.delete(id); pickCount();
    }));
    $('playlist-add-name').textContent = pick.base.name;
    $('playlist-add-empty').hidden = $('playlist-import-link').hidden = !!pick.tracks.length;
    pickCount();
  }
  function pickCount() {
    const count = [...pick.ids].filter(id => !pick.base.trackIds.includes(id)).length;
    $('playlist-add-save').textContent = count ? `${count}곡 추가` : '추가'; $('playlist-add-save').disabled = !count;
  }
  function openPick() {
    const base = selected(); if (!base) return;
    pick = { base: { ...base, trackIds: base.trackIds.slice() }, tracks: state.tracks.slice(), ids: new Set() };
    $('playlist-add-search').value = ''; clearError('playlist-add'); renderPick();
    openDialog($('playlist-add-dialog'), document.activeElement); $('playlist-add-search').focus();
  }
  $('playlist-add').addEventListener('click', openPick); $('empty-playlist-add').addEventListener('click', openPick);
  $('playlist-add-search').addEventListener('input', renderPick);
  $('playlist-add-dialog').addEventListener('close', () => { pick = null; });
  $('playlist-import-link').addEventListener('click', () => { $('playlist-add-dialog').close(); choose(null); navigate('import'); $('choose-files').focus(); });
  $('playlist-add-save').addEventListener('click', async () => {
    const dialog = $('playlist-add-dialog'); if (!pick || isBusy(dialog)) return;
    const target = pick; const ids = target.tracks.filter(row => target.ids.has(row.id) && !target.base.trackIds.includes(row.id)).map(row => row.id);
    if (!ids.length) return;
    busy(dialog, true); clearError('playlist-add');
    try { apply(await request('/' + target.base.id, 'PATCH', { revision: target.base.revision, addTrackIds: ids })); dialog.close(); render(); $('playlist-add').focus(); }
    catch (reason) { error('playlist-add', reason); }
    finally { busy(dialog, false); if (pick) renderPick(); }
  });
  $('playlist-add-reload').addEventListener('click', async () => {
    try { pick.base = await request('/' + pick.base.id); apply(pick.base); clearError('playlist-add'); renderPick(); render(); }
    catch (reason) { error('playlist-add', reason); }
  });

  function renderTargets() {
    const rows = state.playlists || [];
    $('playlist-target-list').innerHTML = rows.map(row => `<button type="button" class="playlist-target-row" data-target-playlist="${row.id}" title="${esc(row.name)}" ${row.trackIds.includes(targetSong.id) ? 'disabled' : ''}><span>${esc(row.name)}</span>${row.trackIds.includes(targetSong.id) ? '<small>추가됨</small>' : ''}</button>`).join('');
    $('playlist-target-empty').hidden = $('playlist-settings-link').hidden = !!rows.length;
    $('playlist-target-list').querySelectorAll('[data-target-playlist]').forEach(button => button.addEventListener('click', async () => {
      const dialog = $('playlist-target-dialog'); if (isBusy(dialog)) return;
      const base = state.playlists.find(row => row.id === Number(button.dataset.targetPlaylist)), id = targetSong.id;
      busy(dialog, true); clearError('playlist-target');
      try { apply(await request('/' + base.id, 'PATCH', { revision: base.revision, addTrackIds: [id] })); dialog.close(); render(); toast('플레이리스트에 추가했습니다.'); }
      catch (reason) { error('playlist-target', reason); }
      finally { busy(dialog, false); if (dialog.open) renderTargets(); }
    }));
  }
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-playlist-track]'); if (!action) return;
    targetSong = state.tracks.find(row => row.id === Number(action.dataset.playlistTrack)); if (!targetSong) return;
    const trigger = menuTrigger(action);
    closeMenus(); clearError('playlist-target'); $('playlist-target-song').textContent = targetSong.title; renderTargets(); openDialog($('playlist-target-dialog'), trigger);
  });
  $('playlist-target-reload').addEventListener('click', async () => { try { await refresh(); clearError('playlist-target'); renderTargets(); } catch (reason) { error('playlist-target', reason); } });
  $('playlist-settings-link').addEventListener('click', () => { $('playlist-target-dialog').close(); navigate('library'); openName(); });

  function startEdit() {
    const base = selected(); if (!base) return;
    if (!edits.has(base.id)) edits.set(base.id, { base: { ...base }, ids: base.trackIds.slice(), busy: false });
    $('search-input').value = ''; closeMenus(); render(); $('playlist-edit-save').focus();
  }
  $('playlist-edit').addEventListener('click', () => { if (!state.playlists.some(row => row.id === menuTarget)) return; choose(menuTarget); startEdit(); });
  $('playlist-edit-cancel').addEventListener('click', () => { if (editing()?.busy) return; edits.delete(selectedId); notices.delete(selectedId); render(); focusSelectedTab(); });
  $('playlist-edit-save').addEventListener('click', async () => {
    const edit = editing(), id = selectedId; if (!edit || edit.busy) return;
    edit.busy = true; notices.delete(id); render();
    try { apply(await request('/' + id, 'PATCH', { revision: edit.base.revision, trackIds: edit.ids.slice() })); edits.delete(id); render(); focusSelectedTab(); }
    catch (reason) { if (reason.current) apply(reason.current); notices.set(id, reason); if (reason.code === 'NOT_FOUND') refresh().catch(() => {}); }
    finally { edit.busy = false; render(); }
  });
  $('playlist-reload').addEventListener('click', async () => {
    try {
      const latest = await request('/' + selectedId); apply(latest);
      if (editing()) edits.set(selectedId, { base: latest, ids: latest.trackIds.slice(), busy: false });
      notices.delete(selectedId); render();
    } catch (reason) { showNotice(reason); }
  });
  function bindRows(root) {
    root.querySelectorAll('[data-playlist-up],[data-playlist-down],[data-playlist-remove]').forEach(button => button.addEventListener('click', () => {
      if (!editing()) startEdit();
      const edit = editing(); if (edit.busy) return;
      const action = button.hasAttribute('data-playlist-up') ? 'up' : button.hasAttribute('data-playlist-down') ? 'down' : 'remove';
      const id = Number(button.getAttribute('data-playlist-' + action)), index = edit.ids.indexOf(id);
      if (index < 0) return;
      if (action === 'remove') edit.ids.splice(index, 1);
      else { const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= edit.ids.length) return; [edit.ids[index], edit.ids[next]] = [edit.ids[next], edit.ids[index]]; }
      render();
      const nextId = action === 'remove' ? edit.ids[Math.min(index, edit.ids.length - 1)] : id;
      (root.querySelector(`[data-playlist-${action}="${nextId}"]`) || $('playlist-edit-save')).focus();
    }));
  }
  function rowActions(id) {
    const edit = editing(); if (!edit) return '';
    const index = edit.ids.indexOf(id), title = esc(state.tracks.find(row => row.id === id)?.title || '곡');
    return `<div class="song-more playlist-edit-actions"><button type="button" class="icon-button" data-playlist-up="${id}" aria-label="${title} 위로 이동" ${index === 0 || edit.busy ? 'disabled' : ''}>${icon('arrow-up')}</button><button type="button" class="icon-button" data-playlist-down="${id}" aria-label="${title} 아래로 이동" ${index === edit.ids.length - 1 || edit.busy ? 'disabled' : ''}>${icon('arrow-down')}</button><button type="button" class="icon-button" data-playlist-remove="${id}" aria-label="${title} 목록에서 빼기" ${edit.busy ? 'disabled' : ''}>${icon('minus')}</button></div>`;
  }

  $('playlist-delete').addEventListener('click', () => {
    const target = state.playlists.find(row => row.id === menuTarget); if (!target) return;
    deleteTarget = { ...target }; $('playlist-delete-name').textContent = `‘${deleteTarget.name}’ 목록을 삭제할까요?`; clearError('playlist-delete');
    closeMenus(); openDialog($('playlist-delete-dialog'), tabFor(deleteTarget.id));
  });
  $('playlist-delete-confirm').addEventListener('click', async () => {
    const dialog = $('playlist-delete-dialog'); if (isBusy(dialog)) return;
    busy(dialog, true); clearError('playlist-delete');
    try { await request('/' + deleteTarget.id, 'DELETE', { revision: deleteTarget.revision }); apply(deleteTarget, true); edits.delete(deleteTarget.id); notices.delete(deleteTarget.id); dialog.close(); if (selectedId === deleteTarget.id) choose(null); else render(); focusSelectedTab(); }
    catch (reason) { error('playlist-delete', reason); }
    finally { busy(dialog, false); }
  });
  $('playlist-delete-reload').addEventListener('click', async () => {
    try { deleteTarget = await request('/' + deleteTarget.id); apply(deleteTarget); $('playlist-delete-name').textContent = `‘${deleteTarget.name}’ 목록을 삭제할까요?`; clearError('playlist-delete'); render(); }
    catch (reason) { error('playlist-delete', reason); }
  });
  tabs.addEventListener('scroll', () => {
    if ($('playlist-menu').matches(':popover-open') && $('playlist-menu')._tabsLeft !== tabs.scrollLeft) closeMenus();
  }, { passive: true });

  function renderControls() {
    if (selectedId && !selected()) selectedId = null;
    const current = selected(), edit = editing(), rows = state.playlists || [];
    const options = current && !rows.some(row => row.id === current.id) ? [...rows, current] : rows;
    const focusedId = document.activeElement?.closest('#playlist-tabs [role="tab"]')?.dataset.playlistId;
    const markup = [{id:null,name:'전체 음악'}, ...options].map(row => `<button type="button" role="tab" id="collection-tab-${row.id ?? 'all'}" data-playlist-id="${row.id ?? ''}" aria-controls="collection-panel" title="${esc(row.name)}">${esc(row.name)}</button>`).join('');
    const replaced = tabsMarkup !== markup;
    if (replaced) {
      closeMenus(); tabs.innerHTML = markup; tabsMarkup = markup;
      tabs.querySelectorAll('[data-playlist-id]:not([data-playlist-id=""])').forEach(tab => {
        tab.setAttribute('aria-describedby', 'playlist-menu-help');
        bindContextTarget(tab, $('playlist-menu'), { controls: false, beforeOpen: () => {
          if (editing()?.busy) return false;
          menuTarget = Number(tab.dataset.playlistId);
          const row = state.playlists.find(row => row.id === menuTarget); if (!row) return false;
          revealTab(tab);
          $('playlist-menu')._tabsLeft = tabs.scrollLeft;
          $('playlist-menu').setAttribute('aria-label', `${row.name} 플레이리스트 메뉴`);
          return true;
        } });
      });
    }
    const candidate = focusedId === undefined ? selectedId : focusedId ? Number(focusedId) : null;
    const roving = tabFor(candidate) ? candidate : selectedId;
    tabs.querySelectorAll('[role="tab"]').forEach(tab => {
      const id = tab.dataset.playlistId ? Number(tab.dataset.playlistId) : null;
      tab.setAttribute('aria-selected', String(id === selectedId));
      tab.tabIndex = id === roving ? 0 : -1;
      tab.disabled = !!edit?.busy;
    });
    $('collection-panel').setAttribute('aria-labelledby', tabFor(selectedId).id);
    if (replaced) {
      if (focusedId !== undefined) (tabFor(focusedId ? Number(focusedId) : null) || tabFor(selectedId))?.focus({preventScroll:true});
      revealTab(tabFor(selectedId));
    }
    $('playlist-add').hidden = !current || !!edit || !current.trackIds.length;
    $('empty-playlist-add').hidden = !current || !!edit || !!$('search-input').value.trim();
    $('playlist-edit-bar').hidden = !edit;
    $('search-input').disabled = !!edit;
    for (const id of ['playlist-edit-save', 'playlist-edit-cancel']) $(id).disabled = !!edit?.busy;
    const notice = notices.get(selectedId);
    $('playlist-notice').hidden = !notice;
    if (notice) $('playlist-notice').querySelector('p').textContent = notice.message;
    $('playlist-reload').hidden = notice?.code !== 'REVISION_CONFLICT';
    const tracks = new Map(state.tracks.map(row => [row.id, row]));
    return current ? (edit?.ids || current.trackIds).map(id => tracks.get(id) || { id, title: '서재에서 찾을 수 없는 곡', missing: true }) : state.tracks;
  }
  return { selectIndex(index) {
    const tab = tabs.querySelectorAll('[role="tab"]')[index];
    if (!tab || tab.disabled) return false;
    choose(tab.dataset.playlistId ? Number(tab.dataset.playlistId) : null);
    return true;
  }, selected, editing, renderControls, bindRows, rowActions, refresh,
    hasUnsaved: () => !!edits.size || !!pick?.ids.size || ($('playlist-name-dialog').open && $('playlist-name-form').elements.name.value !== nameInitial) };
}
