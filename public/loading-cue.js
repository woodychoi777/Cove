// Delay presentation, never the actual player state or its recovery controls.
export class LoadingCue {
  constructor({ delay = 600, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), onChange = () => {} } = {}) {
    Object.assign(this, { delay, schedule, cancel, onChange });
    this.visible = false;
    this.timer = null;
    this.key = null;
    this.version = 0;
  }
  update(loading, key) {
    if (!loading || key !== this.key) this.reset();
    if (!loading) return false;
    this.key = key;
    if (this.timer === null && !this.visible) {
      const version = this.version;
      this.timer = this.schedule(() => {
        if (version !== this.version) return;
        this.timer = null;
        this.visible = true;
        this.onChange();
      }, this.delay);
    }
    return this.visible;
  }
  reset() {
    this.version++;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.visible = false;
    this.key = null;
  }
}
