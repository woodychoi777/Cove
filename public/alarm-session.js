// Temporarily use the common player, without persisting alarm/preview queues.
// Existing controls continue to work for the after-alarm classical track.
export class AlarmSession {
  constructor({ player, onState = () => {}, acknowledge = async () => {}, onClassic = () => {} }) {
    Object.assign(this, { player, onState, acknowledge, onClassic });
    this.mode = 'idle'; this.generation = 0; this.internal = 0;
    this.originalSetQueue = player.setQueue.bind(player);
    player.setQueue = (...args) => {
      if (!this.internal && this.mode !== 'idle') this.restore();
      return this.originalSetQueue(...args);
    };
    player.addEventListener('change', () => this.changed());
  }
  inside(fn) { this.internal++; try { return fn(); } finally { this.internal--; } }
  capture() {
    if (this.saved) return;
    const p = this.player;
    this.saved = { queue: p.snapshot(), offset: p.currentTime, volume: p.volume, muted: p.muted, persist: p.persist };
    p.pause(); p.persist = () => {};
  }
  notify(error = '') { this.onState({ mode: this.mode, index: this.index, trackId: this.player.trackId, error }); }
  async start({ token, config }) {
    if (this.token === token && this.mode === 'alarm') return;
    this.restore(); this.capture(); this.token = token; this.config = structuredClone(config); this.failed = new Set();
    this.mode = 'alarm'; this.index = 0; this.notify(); await this.stage(0);
  }
  async preview({ trackId, volume, fade }) {
    if (this.mode === 'alarm') return;
    this.restore(); this.capture(); this.mode = 'preview'; this.notify();
    await this.load(trackId, volume, fade ? 10 : 0);
  }
  async stage(index) {
    if (this.mode !== 'alarm') return;
    this.index = index; this.notify(); await this.load(this.config.tracks[index], this.config.volumes[index], index === 0 && !this.hasPlayedFirst ? 10 : 0);
    if (index === 0 && this.mode === 'alarm') this.hasPlayedFirst = true;
  }
  async load(id, volume, fade) {
    const token = ++this.generation, p = this.player; this.transitioning = true; this.advanceQueued = false;
    this.inside(() => {
      p.stop(true); p.shuffle = false; p.repeat = 'off'; p.fadeSeconds = 0;
      p.muted = false; p.volume = fade ? 0 : volume;
      this.originalSetQueue([id], 0, this.mode === 'alarm' ? '알람' : this.mode === 'classic' ? '알람 후 음악' : '미리 듣기');
    });
    if (!p.trackId) { this.transitioning = false; return this.failedTrack('선택한 곡이 소장 목록에 없습니다.'); }
    await this.inside(() => p.play());
    if (token !== this.generation) return;
    this.transitioning = false;
    if (p.status.startsWith('재생 실패')) return this.failedTrack('음원을 재생하지 못했습니다.');
    if (fade && p.master && p.context) {
      const now = p.context.currentTime;
      // Keep slider target separate from the scheduled audio envelope.
      p._volume = volume;
      p.master.gain.cancelScheduledValues(now); p.master.gain.setValueAtTime(0, now);
      p.master.gain.linearRampToValueAtTime(volume, now + fade);
      p.emit('change');
    }
    this.notify(); this.changed();
  }
  changed() {
    if (this.mode === 'idle' || this.transitioning || this.advanceQueued) return;
    const p = this.player;
    const failed = p.status.startsWith('재생 실패');
    if (!failed && !(p.paused && p.status === '대기열 재생 완료')) return;
    this.advanceQueued = true;
    const token = this.generation;
    queueMicrotask(() => {
      if (token !== this.generation || this.mode === 'idle') return;
      this.advanceQueued = false;
      if (failed) return this.failedTrack('음원을 재생하지 못했습니다.');
      if (this.mode === 'alarm') this.advance();
      else this.restore();
    });
  }
  failedTrack(message) {
    if (this.mode !== 'alarm') { this.restore(); this.onState({ mode: 'idle', error: message }); return; }
    this.failed.add(this.index); this.advance();
  }
  advance() {
    if (this.mode !== 'alarm') return;
    const next = [0,1,2].find(i => i > this.index && !this.failed.has(i));
    if (next === undefined) { void this.dismiss(); return; }
    void this.stage(next);
  }
  async dismiss(token = this.token) {
    if (this.mode !== 'alarm' || token !== this.token) return;
    const config = this.config;
    // Change mode synchronously: held keys and native + DOM delivery are idempotent.
    this.mode = 'classic'; this.generation++; this.player.stop(true); this.transitioning = true;
    void this.acknowledge(token).catch(() => {});
    this.notify();
    await this.load(config.classicId, config.classicVolume, 0);
    if (this.mode === 'classic') this.onClassic(config.classicId);
  }
  cancel(token) { if (token && token !== this.token) return; this.restore(); }
  restore() {
    if (!this.saved) return;
    const p = this.player, saved = this.saved;
    const token = this.token, wasAlarm = this.mode === 'alarm';
    this.generation++; this.mode = 'idle'; this.transitioning = true; this.saved = null;
    this.inside(() => {
      p.stop(true); p.restore(saved.queue); p.offset = saved.offset;
      p.volume = saved.volume; p.muted = saved.muted; p.persist = saved.persist;
      p.emit('change');
    });
    this.token = null; this.hasPlayedFirst = false; this.transitioning = false; this.advanceQueued = false;
    if (wasAlarm) void this.acknowledge(token).catch(() => {});
    this.notify();
  }
}
