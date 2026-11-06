export const noteFields = ['lyricsOriginal', 'lyricsTranslation', 'meaning', 'favoriteReason', 'memory', 'isLifeSong'];
export const noteValues = (track, fields = noteFields) => Object.fromEntries(fields.map(key => [key, key === 'isLifeSong' ? Boolean(track[key]) : track[key] || '']));
const equal = (left, right, fields) => fields.every(key => left[key] === right[key]);

// Memory only. Keep the latest edit even when it matches the old baseline:
// an in-flight submission may soon become the new persisted baseline.
export class TrackDrafts {
  records = new Map();
  constructor(fields = noteFields) { this.fields = fields; }
  values(track) { return noteValues(track, this.fields); }
  get size() { return [...this.records.keys()].filter(id => this.get(id) || this.records.get(id).submitted).length; }
  get(id) {
    const record = this.records.get(id);
    if (record && (!equal(record.latest, record.baseline, this.fields) || record.submitted && !equal(record.latest, record.submitted, this.fields))) return { ...record.latest };
  }
  open(id, persisted) {
    const values = this.values(persisted);
    if (!this.records.has(id) || !this.get(id) && !this.records.get(id).submitted) {
      this.records.set(id, { baseline: values, latest: { ...values }, submitted: null });
    }
    return { ...this.records.get(id).latest };
  }
  update(id, values, baseline) {
    if (!this.records.has(id)) this.open(id, baseline || values);
    const record = this.records.get(id);
    if (baseline && !record.submitted) record.baseline = this.values(baseline);
    record.latest = this.values(values);
  }
  startSave(id, submitted) {
    const record = this.records.get(id);
    record.latest = this.values(submitted);
    record.submitted = this.values(submitted);
  }
  saved(id, submitted) {
    const record = this.records.get(id);
    record.baseline = this.values(submitted);
    record.submitted = null;
  }
  failed(id) {
    this.records.get(id).submitted = null;
  }
}
