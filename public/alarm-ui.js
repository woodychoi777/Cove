import { localizeMarkup, t } from './i18n.js';
import { AlarmSession } from './alarm-session.js';
import { openDialog } from './ui.js';
import { artistName } from './metadata-display.js';

export function setupAlarmUI({ player, state, openTrack, toast, bridge = window.coveAlarm }) {
  if (window.covePlatform === 'win32') {
    document.querySelector('.alarm-help').innerHTML = localizeMarkup`<summary>실행과 음량 안내</summary><p>Cove가 실행 중일 때 알람이 울립니다. Windows 잠자기 깨우기는 지원하지 않습니다. 알람이 켜져 있으면 창을 닫아도 백그라운드에서 대기하며, 파일 → Cove 종료로 완전히 종료할 수 있습니다.</p><p>실제 소리 크기는 Windows와 출력 장치의 음량에도 영향을 받습니다. 시스템 음량·음소거는 변경하지 않습니다.</p>`;
  }
  if (!bridge) return { hasUnsaved: () => false };
  const $ = selector => document.querySelector(selector);
  const button = $('#alarm-open'), settings = $('#alarm-settings-dialog'), form = $('#alarm-settings-form');
  const picker = $('#alarm-picker-dialog'), ringing = $('#alarm-ringing-dialog');
  const slots = $('#alarm-song-slots'), error = $('#alarm-settings-error');
  let draft, baseline, pickIndex = 0, busy = false, previewRequest = 0, held = null, lastPreview = -1;
  const labels = [t('첫 번째 곡'), t('두 번째 곡'), t('세 번째 곡'), t('알람 후 클래식')];
  const unwrap = response => { if (!response?.ok) throw Error(response?.error || t('알람 연결을 확인해 주세요.')); return response.value; };
  const track = id => state.tracks.find(t => t.id === id);
  const selected = i => i === 3 ? draft.classicId : draft.tracks[i];
  const volume = i => i === 3 ? draft.classicVolume : draft.volumes[i];
  function setError(message) { error.textContent = t(message); error.hidden = !message; }
  function readControls() { if (!draft) return; draft.enabled = $('#alarm-enabled').checked; draft.time = $('#alarm-time').value; }
  const hasUnsaved = () => { readControls(); return !!draft && JSON.stringify(draft) !== baseline; };
  const session = new AlarmSession({ player, acknowledge: token => bridge.stop(token),
    onClassic: id => { if (!document.querySelector('dialog[open]')) void openTrack(id); },
    onState: status => {
      if (status.mode === 'alarm') {
        previewRequest++;
        if (!ringing.open) openDialog(ringing);
        const song = track(draft?.tracks?.[status.index]);
        // The active snapshot may differ from next-day settings.
        const current = track(session.config?.tracks[status.index]) || song;
        $('#alarm-stage-label').textContent = `${status.index + 1} / 3`;
        $('#alarm-now-title').textContent = current?.title || t('곡 확인 중');
        $('#alarm-now-artist').textContent = artistName(current?.artist);
        $('#alarm-ringing-error').textContent = status.error;
        $('#alarm-ringing-error').hidden = !status.error;
      } else {
        if (ringing.open) ringing.close();
        if (status.error) toast(status.error);
      }
      slots.querySelectorAll('[data-alarm-preview]').forEach((b, i) => {
        const active = status.mode === 'preview' && i === lastPreview;
        b.textContent = active ? t('듣기 중지') : t('미리 듣기'); b.setAttribute('aria-pressed', String(active));
      });
    }
  });
  function renderSlots() {
    slots.replaceChildren();
    labels.forEach((label, index) => {
      const row = document.createElement('section'); row.className = 'alarm-song-slot';
      const heading = document.createElement('h3'); heading.textContent = label;
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'alarm-song-choice';
      choose.dataset.alarmChoose = index;
      const song = track(selected(index));
      const title = document.createElement('strong'); title.textContent = song?.title || (selected(index) ? t('곡을 다시 선택해 주세요') : t('곡 선택'));
      const artist = document.createElement('small'); artist.textContent = artistName(song?.artist);
      choose.append(title, artist); choose.setAttribute('aria-label', t("{0} 선택: {1}", label, title.textContent));
      choose.addEventListener('click', () => { session.cancel(); pickIndex = index; $('#alarm-picker-title').textContent = t("{0} 선택", label); $('#alarm-song-search').value = ''; renderSearch(); openDialog(picker, choose); $('#alarm-song-search').focus(); });
      const controls = document.createElement('div'); controls.className = 'alarm-slot-controls';
      const field = document.createElement('label'); field.textContent = t('음량');
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '1'; slider.max = '100'; slider.value = Math.round(volume(index)*100); slider.setAttribute('aria-label', t("{0} 음량", label));
      const output = document.createElement('output'); output.textContent = `${slider.value}%`;
      slider.addEventListener('input', () => { const value = Number(slider.value)/100; if (index===3) draft.classicVolume=value; else draft.volumes[index]=value; output.textContent = `${slider.value}%`; if (session.mode === 'preview' && lastPreview === index) player.volume=value; });
      field.append(slider, output);
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'text-button'; preview.textContent = t('미리 듣기'); preview.dataset.alarmPreview = index; preview.disabled = !song;
      preview.setAttribute('aria-label', t("{0} 미리 듣기", label));
      preview.addEventListener('click', async () => {
        const request = ++previewRequest; setError('');
        if (session.mode === 'preview' && lastPreview === index) { session.cancel(); return; }
        try {
          preview.disabled = true;
          const choice = unwrap(await bridge.preview({ trackId: selected(index), volume: volume(index), fade: index===0 }));
          if (request !== previewRequest || !settings.open || session.mode === 'alarm') return;
          lastPreview = index; await session.preview(choice);
        } catch(e) { setError(e.message); }
        finally { preview.disabled = !track(selected(index)); }
      });
      controls.append(field, preview); row.append(heading, choose, controls); slots.append(row);
    });
  }
  function renderSearch() {
    const results = $('#alarm-search-results'); results.replaceChildren();
    const query = $('#alarm-song-search').value.trim().toLocaleLowerCase();
    const matches = state.tracks.filter(t => `${t.title} ${t.artist || ''}`.toLocaleLowerCase().includes(query)).slice(0,80);
    for (const song of matches) {
      const b = document.createElement('button'); b.type='button'; b.className='alarm-search-song'; b.dataset.alarmTrack=song.id;
      const title=document.createElement('strong'), artist=document.createElement('small');title.textContent=song.title;artist.textContent=artistName(song.artist);b.append(title,artist);
      b.addEventListener('click', () => { if(pickIndex===3) draft.classicId=song.id;else draft.tracks[pickIndex]=song.id;picker.close();renderSlots();slots.querySelector(`[data-alarm-choose="${pickIndex}"]`).focus(); });
      results.append(b);
    }
    if (!matches.length) { const p=document.createElement('p');p.textContent=t('일치하는 소장곡이 없습니다.');results.append(p); }
  }
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      const data = unwrap(await bridge.get());
      if (!draft || JSON.stringify(draft) === baseline) { draft=structuredClone(data.config);baseline=JSON.stringify(draft); }
      $('#alarm-enabled').checked=draft.enabled;$('#alarm-time').value=draft.time;
      $('#alarm-wake-status').textContent=t(data.wake.message);renderSlots();setError('');
      $('#settings-dialog').close();openDialog(settings,button);
    } catch(e) { toast(e.message); }
  });
  $('#alarm-song-search').addEventListener('input',renderSearch);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;readControls();setError('');session.cancel();previewRequest++;
    busy=true;const controls=[...form.querySelectorAll('input,button')];const disabled=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);
    try {
      const result=unwrap(await bridge.save(structuredClone(draft)));
      draft=structuredClone(result.config);baseline=JSON.stringify(draft);$('#alarm-wake-status').textContent=t(result.wake.message);
      settings.close();toast(draft.enabled ? t("{0} 알람을 설정했습니다.", draft.time) : t('알람을 껐습니다.'));
    }catch(e){setError(e.message);try{const data=unwrap(await bridge.get());$('#alarm-wake-status').textContent=t(data.wake.message);}catch{}}
    finally{busy=false;controls.forEach((el,i)=>el.disabled=disabled[i]);}
  });
  settings.addEventListener('close',()=>{readControls();previewRequest++;if(session.mode==='preview')session.cancel();});
  $('#alarm-dismiss').addEventListener('click',()=>void session.dismiss());
  ringing.addEventListener('cancel',event=>{event.preventDefault();void session.dismiss();});
  // Capture before existing shortcuts, consume the matching keyup and repeats.
  document.addEventListener('keydown',event=>{
    if(held || session.mode==='alarm'){
      event.preventDefault();event.stopImmediatePropagation();
      if(!held){held=event.code||event.key;void session.dismiss();}
    }
  },true);
  document.addEventListener('keyup',event=>{if(held){event.preventDefault();event.stopImmediatePropagation();if(held===(event.code||event.key))held=null;}},true);
  window.addEventListener('blur',()=>{held=null;});
  bridge.onEvent(event=>{
    if(event.type==='start') { previewRequest++;void session.start(event); }
    else if(event.type==='cancel')session.cancel(event.token);
    else if(event.type==='dismiss')void session.dismiss(event.token);
  });
  void bridge.ready().then(unwrap).then(active=>{if(active)void session.start(active);}).catch(e=>toast(e.message));
  window.addEventListener('pagehide',()=>session.cancel());
  return { hasUnsaved, session };
}
