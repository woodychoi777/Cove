// decodeAudioData expands a complete file to 32-bit PCM. Keep long recordings
// on the browser's range-backed media path instead of allocating hours of PCM.
export function needsStreaming(track = {}) {
  const seconds = Math.max(0, Number(track.durationMs) || 0) / 1000;
  const pcmBytes = seconds * (Number(track.sampleRate) || 48000) * (Number(track.channels) || 2) * 4;
  return seconds >= 600 || pcmBytes >= 128 * 1024 ** 2 || Number(track.fileSize) >= 64 * 1024 ** 2;
}

export class StreamedAudio {
  constructor({ context, destination, session, mediaFactory = () => new Audio(), onStatus, onEnded, onError, onDuration = () => {} }) {
    this.context = context;
    this.session = session;
    this.media = mediaFactory();
    this.media.preload = 'metadata';
    this.output = context.createMediaElementSource(this.media);
    this.output.connect(destination);
    this.listeners = [];
    this.audible = false;
    const on = (name, action) => { this.media.addEventListener(name, action); this.listeners.push([name, action]); };
    on('loadedmetadata', () => {
      if (this.startOffset) this.media.currentTime = this.startOffset >= this.duration ? 0 : this.startOffset;
      this.resetClock();
      onDuration(this.duration);
    });
    on('playing', () => { this.resetClock(); this.audible = true; onStatus('재생 중'); });
    on('waiting', () => { this.sample(); this.audible = false; onStatus('불러오는 중'); });
    on('pause', () => { this.sample(); this.audible = false; });
    on('seeking', () => { this.resetClock(); this.audible = false; });
    on('seeked', () => { this.resetClock(); this.audible = !this.media.paused && this.media.readyState >= 3; });
    on('ended', () => { this.sample(); this.audible = false; onEnded(); });
    on('error', () => onError(new Error(this.media.error?.code === 2 ? '음원을 읽는 중 연결이 끊겼습니다.' : '이 브라우저에서 음원을 재생할 수 없습니다.')));
    this.resetClock();
  }
  get duration() { return Number.isFinite(this.media.duration) ? this.media.duration : 0; }
  get currentTime() { return this.media.readyState >= 1 ? this.media.currentTime || 0 : this.startOffset || 0; }
  resetClock() { this.lastPosition = this.currentTime; this.lastClock = this.context.currentTime; }
  sample() {
    const elapsed = this.context.currentTime - this.lastClock;
    const advanced = this.currentTime - this.lastPosition;
    if (this.audible && elapsed > 0 && advanced > 0) this.session.heard += Math.min(elapsed, advanced);
    this.resetClock();
  }
  start(url, offset) {
    this.startOffset = Math.max(0, offset || 0);
    this.media.src = url;
    // Call play while the initiating user gesture is still active. Metadata
    // arrives before playing, so a resumed position is applied before output.
    return this.media.play();
  }
  destroy() {
    this.sample();
    this.listeners.forEach(([name, action]) => this.media.removeEventListener(name, action));
    this.media.pause();
    this.media.removeAttribute('src');
    this.media.load(); // cancel pending ranges and release decoder/network buffers
    this.output.disconnect();
  }
}
