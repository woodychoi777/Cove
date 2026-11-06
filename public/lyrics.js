// Positive LRC offsets make lyrics appear earlier, in milliseconds.
function readLyrics(source = '') {
  const text = String(source).replace(/^\uFEFF/, '');
  const offsets = [...text.matchAll(/\[offset:\s*([+-]?\d+)\s*\]/gi)];
  const offset = offsets.length ? Number(offsets.at(-1)[1]) : 0;
  const entries = [], plain = [];
  for (const [line, value] of text.split(/\r?\n/).entries()) {
    const stamps = [...value.matchAll(/\[(\d+):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    const content = value.replace(/\[(\d+):([0-5]\d)(?:[.:](\d{1,3}))?\]/g, '')
      .replace(/\[[a-z]+:[^\]]*\]/gi, '').trim();
    if (!stamps.length) {
      if (content) plain.push(content);
      continue;
    }
    for (const stamp of stamps) {
      const milliseconds = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000
        + Number((stamp[3] || '').padEnd(3, '0')) - offset;
      // Keep file order and individual, unclamped times until pairing is done.
      entries.push({ time: Math.max(0, milliseconds) / 1000, sourceTime: milliseconds,
        text: content, line, stampCount: stamps.length });
    }
  }
  return { entries, plain };
}

function groupRows(entries) {
  const rows = [];
  for (const entry of [...entries].sort((a, b) => a.time - b.time)) {
    const last = rows.at(-1);
    if (last?.time === entry.time) {
      last.text = [last.text, entry.text].filter(Boolean).join('\n');
      if (entry.translation) last.translation = [last.translation, entry.translation].filter(Boolean).join('\n');
    } else rows.push({ time: entry.time, text: entry.text, ...(entry.translation ? { translation: entry.translation } : {}) });
  }
  return rows;
}

export function parseLyrics(source = '') {
  const { entries, plain } = readLyrics(source);
  const rows = groupRows(entries);
  return { timed: rows.length > 0, rows: rows.length ? rows : plain.map(text => ({ time: null, text })), plain };
}

const credit = /^(?:(?:作[词詞曲]|[词詞曲]|编曲|編曲|制作|製作|翻[译譯]|译者|譯者|歌手|演唱|混音|录音|錄音|监制|監製)\s*[:：]|(?:lyrics?|words?|music|compos(?:er|ed)|arrang(?:er|ed)|translat(?:ion|ed)|vocals?)\s*(?:by\b|[:：]))/i;
function originalLine(entry) {
  if (!entry || entry.stampCount !== 1 || credit.test(entry.text)) return false;
  // Han-only lines can be original Chinese or Japanese: never infer their role.
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(entry.text)
    || (!/\p{Script=Han}/u.test(entry.text) && /\p{Script=Latin}/u.test(entry.text));
}
function translationLine(entry) {
  if (!entry || entry.stampCount !== 1 || credit.test(entry.text)
    || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(entry.text)) return false;
  const han = (entry.text.match(/\p{Script=Han}/gu) || []).length;
  const letters = (entry.text.match(/\p{Letter}/gu) || []).length;
  return han > 0 && han >= letters / 2;
}

function embeddedRows(entries) {
  const pairs = new Map(), removed = new Set();
  const lastText = entries.findLastIndex(entry => entry.text);
  const originals = new Set(entries.flatMap((entry, index) => originalLine(entry) ? [index] : []));
  // A single Han-only original (e.g. Japanese without kana) is identifiable only
  // inside a strict delayed chain with three strong pairs on either side.
  // Longer Han-only/mixed passages remain untouched rather than guessed.
  for (let index = 6; index + 8 < entries.length; index++) {
    if (!translationLine(entries[index])) continue;
    const anchored = [-6, -4, -2, 0, 2, 4, 6].every(delta => {
      const position = index + delta;
      const a = entries[position], b = entries[position + 1], next = entries[position + 2];
      return (delta === 0 || originalLine(a)) && (delta === -2 || originalLine(next))
        && translationLine(b) && b.line === a.line + 1 && next.line === b.line + 1
        && b.sourceTime > a.sourceTime && b.sourceTime === next.sourceTime;
    });
    if (anchored) originals.add(index);
  }
  function candidate(index) {
    const a = entries[index], b = entries[index + 1], next = entries[index + 2];
    // Do not bridge annotations, gaps, multiple stamps or reversed source times.
    if (!originals.has(index) || !translationLine(b) || b.line !== a.line + 1 || b.sourceTime < a.sourceTime) return null;
    if (b.sourceTime === a.sourceTime) {
      if (next && next.sourceTime <= a.sourceTime) return null;
      return 'same';
    }
    if (originals.has(index + 2) && next.line === b.line + 1 && b.sourceTime === next.sourceTime) return 'delayed';
    // The final translation may have its own end stamp, followed by an empty end cue.
    if (!next || (next.sourceTime === b.sourceTime && index + 2 > lastText)) return 'end';
    return null;
  }
  for (let start = 0; start < entries.length; start++) {
    const kind = candidate(start);
    if (kind !== 'same' && kind !== 'delayed') continue;
    const run = [];
    let index = start;
    while (candidate(index) === kind) {
      run.push(index);
      index += 2;
    }
    // Three consecutive pairs establish a local pattern, not a song-wide language rule.
    // A lone bilingual/simultaneous line or ml:1.0 tag provides no such evidence.
    if (run.length < 3) continue;
    if (kind === 'delayed' && candidate(index) === 'end') run.push(index);
    for (const position of run) {
      pairs.set(position, entries[position + 1].text);
      removed.add(position + 1);
    }
    start = run.at(-1) + 1;
  }
  return groupRows(entries.flatMap((entry, index) => removed.has(index) ? [] : [{ ...entry, translation: pairs.get(index) }]));
}

export function buildLyrics(original, translation) {
  const source = readLyrics(original);
  const lyrics = { timed: source.entries.length > 0, plain: source.plain,
    rows: source.entries.length ? embeddedRows(source.entries) : source.plain.map(text => ({ time: null, text })) };
  const translated = parseLyrics(translation);
  const used = new Set();
  const rows = lyrics.rows.map((row, index) => {
    const match = lyrics.timed && translated.timed
      ? translated.rows.findIndex(item => Math.abs(item.time - row.time) < 0.001)
      : !translated.timed && lyrics.rows.length === translated.rows.length ? index : -1;
    if (match >= 0) used.add(match);
    return { ...row, translation: match >= 0 ? translated.rows[match].text : row.translation || '' };
  });
  return {
    timed: lyrics.timed, rows,
    extraOriginal: lyrics.timed ? lyrics.plain : [],
    extraTranslation: [...translated.rows.filter((_, index) => !used.has(index)).map(row => row.text),
      ...(translated.timed ? translated.plain : [])].filter(Boolean)
  };
}

export function activeLyricIndex(rows, seconds) {
  let low = 0;
  let high = rows.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].time !== null && rows[middle].time <= seconds) {
      active = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return active;
}
