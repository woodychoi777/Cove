import { transitionPlan, shuffled } from './listening.js';
import { needsStreaming, StreamedAudio } from './streaming-audio.js';

// One audio clock schedules both buffers, so UI timers do not determine the handoff.
export class QueuePlayer extends EventTarget {
  constructor({ contextFactory = () => new AudioContext(), loadBuffer, mediaFactory, persist = () => {}, random = Math.random, tick = true } = {}) {
    super();
    this.contextFactory = contextFactory;
    this.loadBuffer = loadBuffer;
    this.mediaFactory = mediaFactory;
    this.persist = persist;
    this.random = random;
    this.shuffle = false;
    this.repeat = 'off';
    this.originalOrder = [];
    this.queue = [];
    this.source = '재생 대기열';
    this.index = -1;
    this.paused = true;
    this.offset = 0;
    this.fadeSeconds = 0;
    this.status = '음악을 선택하세요';
    this.generation = 0;
    this.planGeneration = 0;
    this.nodes = new Set();
    this.cache = new Map();
    this.durations = new Map();
    this.tracks = [];
    this._volume = 0.8;
    this._muted = false;
    if (tick) this.timer = setInterval(() => this.update(), 100);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  get trackId() { return this.queue[this.index]?.trackId ?? null; }
  get track() { return this.tracks.find(track => track.id === this.trackId); }
  get duration() { return this.streaming?.duration || this.current?.buffer.duration || this.durations.get(this.trackId) || (this.track?.durationMs || 0) / 1000; }
  get currentTime() {
    if (this.streaming) return this.streaming.currentTime;
    return this.current && !this.paused ? Math.min(this.duration, this.current.offset + Math.max(0, this.context.currentTime - this.current.start)) : this.offset;
  }
  get volume() { return this._volume; }
  set volume(value) { this._volume = Math.max(0, Math.min(1, Number(value))); this.setGain(); }
  get muted() { return this._muted; }
  set muted(value) { this._muted = Boolean(value); this.setGain(); }
  setGain() {
    if (this.master) { this.master.gain.cancelScheduledValues(this.context.currentTime); this.master.gain.setValueAtTime(this.muted ? 0 : this.volume, this.context.currentTime); }
    this.emit('change');
  }
  ensureContext() {
    if (!this.context) {
      this.context = this.contextFactory();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.setGain();
    }
  }
  snapshot() { return { ids: this.queue.map(row => row.trackId), order: this.queue.map(row => this.originalOrder.indexOf(row.key)), index: this.index, fadeSeconds: this.fadeSeconds, source: this.source, shuffle: this.shuffle, repeat: this.repeat }; }
  restore(saved) {
    if (!saved || !Array.isArray(saved.ids)) return;
    // Restore the saved occurrence order exactly; do not shuffle again or play.
    this.shuffle = false;
    this.setQueue(saved.ids, saved.index, saved.source);
    const validOrders = Array.isArray(saved.order) && saved.order.length === saved.ids.length && saved.order.every(Number.isInteger) && new Set(saved.order).size === saved.order.length;
    if (validOrders) {
      const orders = saved.order.filter((_, i) => this.tracks.some(track => track.id === saved.ids[i]));
      this.originalOrder = this.queue.map((row, i) => ({ key: row.key, order: orders[i] })).sort((a, b) => a.order - b.order).map(row => row.key);
    }
    this.shuffle = saved.shuffle === true;
    this.repeat = ['all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
    this.setTransition(saved.fadeSeconds);
  }
  nextIndex(natural = false) {
    if (!this.trackId) return -1;
    if (natural && this.repeat === 'one') return this.index;
    if (this.index + 1 < this.queue.length) return this.index + 1;
    return this.repeat === 'all' ? 0 : -1;
  }
  get hasNext() { return this.nextIndex() >= 0; }
  previousIndex() {
    if (!this.trackId) return -1;
    if (this.index > 0) return this.index - 1;
    return this.repeat === 'all' ? this.queue.length - 1 : -1;
  }
  get hasPrevious() { return this.previousIndex() >= 0; }
  reorderRemaining() {
    const remaining = this.queue.slice(this.index + 1);
    const order = new Map(this.originalOrder.map((key, index) => [key, index]));
    this.queue.splice(this.index + 1, remaining.length, ...(this.shuffle ? shuffled(remaining, this.random) : remaining.sort((a, b) => order.get(a.key) - order.get(b.key))));
  }
  setShuffle(value) {
    const enabled = Boolean(value);
    if (this.shuffle === enabled) return;
    this.update();
    this.shuffle = enabled;
    this.reorderRemaining();
    this.plan(); this.changed();
  }
  setRepeat(value) {
    this.update();
    this.repeat = ['all', 'one'].includes(value) ? value : 'off';
    this.plan(); this.changed();
  }
  changed() { this.persist(this.snapshot()); this.emit('queuechange'); this.emit('change'); }
  async buffer(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const promise = (async () => {
      if (this.loadBuffer) return this.loadBuffer(id, this.context);
      const response = await fetch(`/api/tracks/${id}/audio`);
      if (!response.ok) throw new Error('음원 파일을 읽지 못했습니다.');
      return this.context.decodeAudioData(await response.arrayBuffer());
    })();
    this.cache.set(id, promise);
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    try { return await promise; } catch (error) { this.cache.delete(id); throw error; }
  }
  setQueue(ids, index = 0, source = '재생 대기열') {
    this.stop(true);
    this.source = typeof source === 'string' && source.trim() ? source.slice(0, 150) : '재생 대기열';
    this.queue = ids.filter(id => this.tracks.some(track => track.id === id)).map(trackId => ({ key: crypto.randomUUID(), trackId }));
    this.originalOrder = this.queue.map(row => row.key);
    this.index = this.queue.length ? Math.max(0, Math.min(Number.isInteger(index) ? index : 0, this.queue.length - 1)) : -1;
    this.reorderRemaining();
    this.offset = 0;
    this.session = null;
    this.status = this.trackId ? '재생 준비' : '대기열이 비었습니다';
    this.changed();
  }
  makeNode(entry, buffer, start, offset, session) {
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.master);
    const node = { entry, buffer, source, gain, start, offset, session, finished: false };
    this.nodes.add(node);
    source.onended = () => {
      this.finishNode(node);
      if (node !== this.current) this.flush(node.session, true);
      this.update();
    };
    source.start(start, offset);
    return node;
  }
  finishNode(node) {
    if (node.finished) return;
    node.finished = true;
    node.session.heard += Math.max(0, Math.min(node.buffer.duration - node.offset, this.context.currentTime - node.start));
    this.nodes.delete(node);
    node.source.disconnect();
    node.gain.disconnect();
  }
  flush(session, completed = false) {
    if (!session || session.flushed || session.heard <= 0) return;
    session.flushed = true;
    this.emit('listened', { id: session.id, listenedMs: Math.round(session.heard * 1000), completed });
  }
  stop(flush = false) {
    this.generation += 1;
    this.planGeneration += 1;
    this.offset = this.currentTime;
    this.paused = true;
    this.streaming?.destroy();
    this.streaming = null;
    for (const node of [...this.nodes]) {
      node.source.onended = null;
      node.source.stop();
      this.finishNode(node);
      if (flush || node.session !== this.session) this.flush(node.session);
    }
    if (flush) this.flush(this.session);
    this.current = null;
    this.scheduled = null;
  }
  pause() { this.update(); this.stop(true); this.status = '일시정지'; this.emit('change'); }
  async play() {
    if (!this.trackId) return;
    if (!this.paused) return;
    this.ensureContext();
    const token = ++this.generation;
    const id = this.trackId;
    this.paused = false;
    this.status = '불러오는 중';
    this.emit('change');
    try {
      if (needsStreaming(this.track)) {
        if (!this.session || this.session.flushed) this.session = { id, heard: 0 };
        const stream = new StreamedAudio({
          context: this.context, destination: this.master, session: this.session, mediaFactory: this.mediaFactory,
          onDuration: duration => { if (token === this.generation && duration > 0) { this.durations.set(id, duration); this.emit('change'); } },
          onStatus: status => { if (token === this.generation) { this.status = status; this.emit('change'); } },
          onEnded: () => {
            if (token !== this.generation) return;
            const duration = this.duration, session = this.session;
            this.stop(); this.flush(session, true);
            const next = this.nextIndex(true);
            if (next >= 0) this.select(next);
            else { this.offset = duration; this.status = '대기열 재생 완료'; this.emit('change'); }
          },
          onError: error => {
            if (token !== this.generation) return;
            this.stop(true); this.status = '재생 실패 · 다음 곡으로 이동하거나 다시 시도하세요';
            this.emit('error', error.message); this.emit('change');
          }
        });
        this.streaming = stream;
        await Promise.all([this.context.resume(), stream.start(`/api/tracks/${id}/audio`, this.offset)]);
        if (token === this.generation) { this.status = '재생 중'; this.emit('change'); }
        return;
      }
      await this.context.resume();
      const buffer = await this.buffer(id);
      if (token !== this.generation) return;
      if (this.offset >= buffer.duration) this.offset = 0;
      if (!this.session || this.session.flushed) this.session = { id, heard: 0 };
      this.current = this.makeNode(this.queue[this.index], buffer, this.context.currentTime + 0.03, this.offset, this.session);
      this.status = '재생 중';
      this.emit('change');
      this.plan();
    } catch (error) {
      if (token !== this.generation) return;
      if (this.streaming) this.stop(true);
      this.paused = true;
      this.status = '재생 실패 · 다음 곡으로 이동하거나 다시 시도하세요';
      this.emit('error', error.message || '이 브라우저에서 음원을 재생할 수 없습니다.');
      this.emit('change');
    }
  }
  async seek(seconds) {
    this.update();
    if (!this.trackId) return;
    const resume = !this.paused;
    const duration = this.duration;
    this.stop();
    this.offset = Math.max(0, Math.min(Number(seconds) || 0, duration));
    this.emit('change');
    if (resume && duration > 0 && this.offset >= duration) {
      this.flush(this.session, true);
      const next = this.nextIndex();
      if (next >= 0) await this.select(next);
      else { this.status = '대기열 재생 완료'; this.emit('change'); }
      return;
    }
    if (resume) await this.play();
  }
  async select(index, autoplay = true) {
    if (index < 0 || index >= this.queue.length) return;
    this.stop(true);
    this.index = index;
    this.offset = 0;
    this.session = null;
    this.status = '재생 준비';
    this.changed();
    if (autoplay) await this.play();
  }
  // A scheduled source can already be audible before the next UI tick. Adopt
  // that occurrence before choosing its neighbour, or Next restarts that source.
  next() { this.update(); return this.select(this.nextIndex()); }
  previous() { this.update(); return this.select(this.previousIndex()); }
  enqueue(id, next = false) {
    this.update();
    if (!this.tracks.some(track => track.id === id)) return;
    const entry = { key: crypto.randomUUID(), trackId: id };
    const anchor = this.originalOrder.indexOf(this.queue[this.index]?.key);
    this.originalOrder.splice(next ? anchor + 1 : this.originalOrder.length, 0, entry.key);
    this.queue.splice(next ? this.index + 1 : this.queue.length, 0, entry);
    if (this.index < 0) this.index = 0;
    this.plan();
    this.changed();
  }
  move(from, to) {
    this.update();
    if (from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) return;
    const currentKey = this.queue[this.index]?.key;
    const entry = this.queue.splice(from, 1)[0];
    this.queue.splice(to, 0, entry);
    this.originalOrder.splice(this.originalOrder.indexOf(entry.key), 1);
    const following = this.queue[to + 1];
    this.originalOrder.splice(following ? this.originalOrder.indexOf(following.key) : this.originalOrder.length, 0, entry.key);
    this.index = this.queue.findIndex(row => row.key === currentKey);
    this.plan(); this.changed();
  }
  remove(index) {
    this.update();
    if (index < 0 || index >= this.queue.length) return;
    const active = index === this.index;
    const resume = !this.paused;
    if (active) this.stop(true);
    const [removed] = this.queue.splice(index, 1);
    this.originalOrder.splice(this.originalOrder.indexOf(removed.key), 1);
    if (index < this.index) this.index -= 1;
    if (active) {
      this.index = this.queue.length ? Math.min(index, this.queue.length - 1) : -1;
      this.offset = 0; this.session = null;
      this.status = this.trackId ? '재생 준비' : '대기열이 비었습니다';
      if (resume && this.trackId) this.play();
    } else this.plan();
    this.changed();
  }
  setTransition(seconds) { this.update(); this.fadeSeconds = [0, 2, 4, 6].includes(Number(seconds)) ? Number(seconds) : 0; this.plan(); this.changed(); }
  async plan() {
    const version = ++this.planGeneration;
    if (this.scheduled) {
      const node = this.scheduled;
      node.source.onended = null;
      node.source.stop(); this.finishNode(node);
      this.scheduled = null;
    }
    const current = this.current;
    if (!current || this.paused) return;
    current.gain.gain.cancelScheduledValues(this.context.currentTime);
    const now = this.context.currentTime;
    const remainingFade = (current.fadeInEnd || 0) - now;
    current.gain.gain.setValueAtTime(remainingFade > 0 ? Math.max(0, (now - current.start) / (current.fadeInEnd - current.start)) : 1, now);
    if (remainingFade > 0) current.gain.gain.linearRampToValueAtTime(1, current.fadeInEnd);
    const next = this.queue[this.nextIndex(true)];
    if (!next) return;
    // Stream boundaries advance on ended; do not pre-decode a long next track.
    if (needsStreaming(this.tracks.find(track => track.id === next.trackId))) return;
    try {
      const buffer = await this.buffer(next.trackId);
      if (version !== this.planGeneration || this.current !== current || this.paused) return;
      const end = current.start + current.buffer.duration - current.offset;
      const timing = transitionPlan(this.context.currentTime, end, buffer.duration, this.repeat === 'one' ? 0 : this.fadeSeconds);
      const session = { id: next.trackId, heard: 0 };
      const node = this.makeNode(next, buffer, timing.start, 0, session);
      if (timing.fade) {
        node.fadeInEnd = timing.start + timing.fade;
        current.gain.gain.setValueAtTime(1, timing.start);
        current.gain.gain.linearRampToValueAtTime(0, timing.start + timing.fade);
        node.gain.gain.setValueAtTime(0, timing.start);
        node.gain.gain.linearRampToValueAtTime(1, timing.start + timing.fade);
      }
      this.scheduled = node;
    } catch {
      if (version === this.planGeneration) {
        this.status = '다음 곡 준비 실패 · 현재 곡은 계속 재생됩니다';
        this.emit('change');
      }
    }
  }
  update() {
    if (this.streaming && !this.paused) { this.streaming.sample(); this.emit('change'); return; }
    if (!this.current || this.paused) return;
    if (this.scheduled && this.context.currentTime >= this.scheduled.start) {
      const old = this.current;
      this.current = this.scheduled;
      this.scheduled = null;
      if (old.finished) this.flush(old.session, true);
      this.session = this.current.session;
      this.index = this.queue.findIndex(row => row.key === this.current.entry.key);
      this.offset = 0;
      this.status = '재생 중';
      this.changed();
      this.plan();
    }
    if (this.current.finished && !this.scheduled) {
      this.flush(this.session, true);
      const next = this.nextIndex(true);
      const hasNext = next >= 0;
      this.offset = this.duration;
      this.paused = true;
      this.status = hasNext ? '다음 곡 불러오는 중' : '대기열 재생 완료';
      this.current = null;
      if (hasNext) this.select(next);
    }
    this.emit('change');
  }
  destroy() { this.stop(true); clearInterval(this.timer); this.context?.close(); }
}
