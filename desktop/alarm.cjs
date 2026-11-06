const { randomUUID } = require('node:crypto');
const defaults = () => ({ enabled: false, time: '07:00', tracks: [null, null, null], volumes: [.2, .45, .7], classicId: null, classicVolume: .25 });
function validate(value) {
  const id = x => x === null || (Number.isSafeInteger(x) && x > 0);
  const volume = x => typeof x === 'number' && Number.isFinite(x) && x >= 0.01 && x <= 1;
  if (!value || typeof value.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
      || !Array.isArray(value.tracks) || value.tracks.length !== 3 || !value.tracks.every(id)
      || !Array.isArray(value.volumes) || value.volumes.length !== 3 || !value.volumes.every(volume)
      || !id(value.classicId) || !volume(value.classicVolume)) throw Error('알람 시각, 곡과 음량을 확인해 주세요.');
  if (value.enabled && (value.tracks.includes(null) || value.classicId === null)) throw Error('알람 세 곡과 클래식 한 곡을 선택해 주세요.');
  return { enabled: value.enabled, time: value.time, tracks: [...value.tracks], volumes: [...value.volumes], classicId: value.classicId, classicVolume: value.classicVolume };
}
function dayKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function wakeTime(time) { const [h,m] = time.split(':').map(Number), n = (h*60+m+1439)%1440; return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}:00`; }
class AlarmScheduler {
  constructor({ state = {}, persist, fire, cancel, now = () => new Date() }) {
    this.state = state; this.persist = persist; this.fire = fire; this.cancel = cancel; this.now = now; this.active = null;
    try { this.config = validate(state.config || defaults()); } catch { this.config = defaults(); }
    this.state.config = this.config;
    this.state.runs = Array.isArray(state.runs) ? state.runs.slice(-32) : [];
  }
  save(config) {
    config = validate(config);
    if (this.active && config.enabled) this.state.deferDate = dayKey(this.now());
    this.config = this.state.config = config;
    if (!config.enabled && this.active) { const token = this.active.token; this.active = null; this.cancel(token); }
    this.persist(this.state);
    return this.config;
  }
  tick() {
    if (!this.config.enabled || this.active) return;
    const now = this.now(), date = dayKey(now), [hours,minutes] = this.config.time.split(':').map(Number);
    if (this.state.deferDate === date || this.state.runs.includes(date)) return;
    const due = new Date(now); due.setHours(hours, minutes, 0, 0);
    const elapsed = now - due;
    if (elapsed < 0) return;
    // Claim the local calendar day before delivery; resume/reload cannot ring twice.
    this.state.runs = [...this.state.runs, date].slice(-32);
    this.state.lastOutcome = elapsed <= 300000 ? 'started' : 'missed';
    this.persist(this.state);
    if (elapsed > 300000) return;
    this.active = { token: randomUUID(), config: structuredClone(this.config) };
    this.fire(this.active);
  }
  finish(token) { if (this.active?.token !== token) return false; this.active = null; return true; }
}
module.exports = { defaults, validate, dayKey, wakeTime, AlarmScheduler };
