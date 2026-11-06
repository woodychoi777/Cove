import { TrackDrafts } from './drafts.js';
import { artistName } from './metadata-display.js';
import { openDialog, menuTrigger } from './ui.js';

const fields = ['title', 'artist', 'lyricsOriginal', 'lyricsTranslation'];
const values = track => Object.fromEntries(fields.map(key => [key, key === 'artist' ? artistName(track.artist) : track[key] || '']));
const same = (a, b) => fields.every(key => a[key] === b[key]);

export function setupTrackEditor({ getToken, onSaved, onDelete, toast }) {
  const dialog = document.querySelector('#track-info-dialog'), form = document.querySelector('#track-info-form');
  const error = document.querySelector('#track-info-error'), dirty = document.querySelector('#track-info-draft');
  const save = form.querySelector('.primary-button'), preview = document.querySelector('#track-info-cover');
  const fileInput = document.querySelector('#track-info-image'), undoImage = document.querySelector('#track-info-image-undo');
  const imageInfo = document.querySelector('#track-info-image-info'), scope = document.querySelector('#track-info-image-scope');
  const deleteButton = document.querySelector('#track-info-delete');
  const drafts = new TrackDrafts(fields), pictures = new Map(), pending = new Set(), tracks = new Map();
  let id, generation = 0, imageVersion = 0, loading = false, checkingImage = false, previewUrl;
  const inputValues = () => Object.fromEntries(fields.map(key => [key, form.elements[key].value]));
  function update() {
    const changed = drafts.get(id) || pictures.has(id);
    dirty.hidden = !changed;
    save.disabled = loading || checkingImage || pending.has(id);
    deleteButton.disabled = loading || checkingImage || pending.has(id);
    save.textContent = pending.has(id) ? '저장 중…' : '저장';
  }
  function showError(message) { error.textContent = message; error.hidden = !message; }
  function renderPicture() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    const file = pictures.get(id), track = tracks.get(id);
    const url = file ? (previewUrl = URL.createObjectURL(file)) : track?.artworkPath ? `/api/tracks/${id}/artwork?v=${encodeURIComponent(track.artworkPath)}` : null;
    preview.replaceChildren();
    if (url) { const image = new Image(); image.src = url; image.alt = '앨범 사진 미리보기'; preview.append(image); }
    else preview.textContent = '앨범 사진';
    imageInfo.textContent = file ? file.name : 'JPG · PNG · WebP / 최대 10 MB';
    undoImage.hidden = !file;
    const album = track?.album;
    scope.textContent = album && album !== '알 수 없는 앨범' ? `${album} 앨범의 곡에 함께 적용됩니다.` : '이 곡에 적용됩니다.';
  }
  function capture() { if (!loading && drafts.records.has(id)) drafts.update(id, inputValues()); update(); }
  async function open(trackId, trigger, focus = 'title') {
    const version = ++generation;
    imageVersion++; checkingImage = false; id = trackId; loading = true;
    dialog.dataset.trackId = String(trackId);
    form.reset(); error.hidden = dirty.hidden = true;
    for (const key of fields) form.elements[key].disabled = true;
    fileInput.disabled = true; undoImage.disabled = true;
    preview.replaceChildren(); imageInfo.textContent = ''; scope.textContent = '';
    openDialog(dialog, trigger); update();
    try {
      const response = await fetch(`/api/tracks/${trackId}`);
      const track = await response.json();
      if (!response.ok) throw Error(track.error || '곡 정보를 불러오지 못했습니다.');
      if (version !== generation || !dialog.open) return;
      tracks.set(id, track);
      const draft = drafts.open(id, values(track));
      for (const key of fields) { form.elements[key].disabled = false; form.elements[key].value = draft[key]; }
      loading = false; fileInput.disabled = false; undoImage.disabled = false;
      renderPicture(); update(); form.elements[focus]?.focus();
    } catch (reason) { if (version === generation && dialog.open) showError(reason.message || '곡 정보를 불러오지 못했습니다.'); }
  }
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-edit-info]');
    if (action) open(Number(action.dataset.editInfo), menuTrigger(action));
  });
  deleteButton.addEventListener('click', () => {
    const track = tracks.get(id);
    if (!deleteButton.disabled && track) { capture(); onDelete(track, deleteButton); }
  });
  form.addEventListener('input', event => { if (fields.includes(event.target.name)) capture(); });
  dialog.addEventListener('close', () => {
    generation++; imageVersion++; checkingImage = false;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (!dialog._trigger?.isConnected) document.querySelector('#detail-content [data-edit-info], .nav-button.is-active')?.focus({ preventScroll: true });
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    const targetId = id, version = ++imageVersion;
    checkingImage = true; update(); showError('');
    const url = URL.createObjectURL(file);
    try {
      if (file.size > 10 * 1024 ** 2) throw Error('10 MB 이하의 사진을 선택해 주세요.');
      if (!/\.(jpe?g|png|webp)$/i.test(file.name)) throw Error('JPG, PNG 또는 WebP 사진을 선택해 주세요.');
      const image = new Image(); image.src = url; await image.decode();
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40000000) throw Error('사진은 4,000만 화소 이하로 선택해 주세요.');
      if (version !== imageVersion || targetId !== id || !dialog.open) return;
      pictures.set(id, file); renderPicture();
    } catch (reason) {
      if (version === imageVersion) showError(reason instanceof DOMException ? '사진을 읽지 못했습니다. 다른 파일을 선택해 주세요.' : reason.message);
    } finally {
      URL.revokeObjectURL(url);
      if (version === imageVersion) { checkingImage = false; fileInput.value = ''; update(); }
    }
  });
  undoImage.addEventListener('click', () => { imageVersion++; checkingImage = false; pictures.delete(id); renderPicture(); update(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (loading || checkingImage || pending.has(id)) return;
    capture(); showError('');
    const submitted = inputValues(), targetId = id, file = pictures.get(id);
    if (!submitted.title.trim() || submitted.title.length > 300 || submitted.artist.length > 300) {
      showError(!submitted.title.trim() ? '곡 이름을 입력해 주세요.' : '곡 이름과 가수명은 300자 이하로 입력해 주세요.');
      form.elements[submitted.title.trim() ? 'artist' : 'title'].focus(); return;
    }
    const baseline = drafts.records.get(id).baseline;
    const changes = Object.fromEntries(fields.filter(key => submitted[key] !== baseline[key]).map(key => [key, submitted[key]]));
    if (!Object.keys(changes).length && !file) { dialog.close(); return; }
    drafts.startSave(id, submitted); pending.add(id); update();
    try {
      const body = { changes };
      if (file) body.artwork = await new Promise((ok, no) => {
        const reader = new FileReader(); reader.onload = () => ok(reader.result.split(',')[1]); reader.onerror = () => no(Error('사진을 읽지 못했습니다.')); reader.readAsDataURL(file);
      });
      const response = await fetch(`/api/tracks/${targetId}/info`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-local-token': getToken() }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '곡 정보를 저장하지 못했습니다.');
      const normalized = values(result), latest = drafts.records.get(targetId).latest;
      const unchanged = same(latest, submitted) && pictures.get(targetId) === file;
      // Submitted values become the baseline; edits made while saving remain latest.
      if (same(latest, submitted)) drafts.update(targetId, normalized);
      drafts.saved(targetId, normalized); tracks.set(targetId, result);
      if (pictures.get(targetId) === file) pictures.delete(targetId);
      onSaved(result);
      if (id === targetId && dialog.open) {
        if (unchanged) dialog.close();
        else { renderPicture(); update(); }
      }
    } catch (reason) {
      drafts.failed(targetId);
      if (id === targetId && dialog.open) showError(reason.message || '곡 정보를 저장하지 못했습니다.');
      else toast(reason.message || '곡 정보를 저장하지 못했습니다.');
    } finally { pending.delete(targetId); if (id === targetId) update(); }
  });
  return { open, isSaving: id => pending.has(id), forget: id => { drafts.records.delete(id); pictures.delete(id); tracks.delete(id); }, hasUnsaved: () => drafts.size > 0 || pictures.size > 0 || pending.size > 0 || checkingImage };
}
