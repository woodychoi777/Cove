import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLyrics, buildLyrics, activeLyricIndex } from '../public/lyrics.js';

test('LRC handles metadata, repeated timestamps, fractions, offsets and instrumental gaps', () => {
  const result = parseLyrics('\uFEFF[ar:Example]\r\n[offset:500]\r\n[00:10.25][00:30.125]Repeat\r\n[00:20.5]\r\n[00:01]Start');
  assert.equal(result.timed, true);
  assert.deepEqual(result.rows, [
    { time: 0.5, text: 'Start' }, { time: 9.75, text: 'Repeat' },
    { time: 20, text: '' }, { time: 29.625, text: 'Repeat' }
  ]);
  assert.equal(parseLyrics('[offset:-1000]\n[00:01]Late').rows[0].time, 2);
});

test('active line handles before start, boundaries, backwards seeks and final line', () => {
  const { rows } = parseLyrics('[00:02]First\n[00:04]Second\n[00:06]');
  for (const [time, index] of [[0, -1], [2, 0], [3.99, 0], [4, 1], [6, 2], [100, 2], [2, 0]]) {
    assert.equal(activeLyricIndex(rows, time), index);
  }
  assert.equal(activeLyricIndex([], 1), -1);
});

test('timestamped translation matches time, never shifts across missing lines', () => {
  const model = buildLyrics('[00:01]One\n[00:02]Two\n[00:03]Three', '[00:03]셋\n[00:01.000]하나\n[00:05]별도');
  assert.deepEqual(model.rows.map(row => row.translation), ['하나', '', '셋']);
  assert.deepEqual(model.extraTranslation, ['별도']);
});

test('plain translations pair by line count; mismatched and translation-only content remains readable', () => {
  assert.deepEqual(buildLyrics('One\nTwo', '하나\n둘').rows.map(row => row.translation), ['하나', '둘']);
  const mismatch = buildLyrics('[00:01]One\n[00:02]Two', '한 줄 번역');
  assert.deepEqual(mismatch.rows.map(row => row.translation), ['', '']);
  assert.deepEqual(mismatch.extraTranslation, ['한 줄 번역']);
  assert.deepEqual(buildLyrics('', '번역만').extraTranslation, ['번역만']);
  assert.deepEqual(buildLyrics('', '').rows, []);
});

test('simultaneous bilingual lines and untimed annotations are preserved', () => {
  const model = buildLyrics('[ti:Title]\nA note\n[00:01]Hello\n[00:01]안녕', '');
  assert.equal(model.rows[0].text, 'Hello\n안녕');
  assert.deepEqual(model.extraOriginal, ['A note']);
});

const stamp = value => `[00:${String(value).padStart(2, '0')}.00]`;
function bilingual({ count = 4, same = false, originals = [], end = true } = {}) {
  const rows = Array.from({ length: count }, (_, i) => [
    stamp(1 + i * 2) + (originals[i] || `Original ${i + 1}`),
    stamp(1 + i * 2 + (same ? 0 : 2)) + `翻译第${i + 1}句`
  ]).flat();
  if (end) rows.push(stamp(1 + count * 2));
  return rows.join('\n');
}

test('embedded delayed translations belong to the previous original, including the final pair', () => {
  const source = '[ml:1.0]\n[ti:Synthetic]\n[00:00]词：Tester\n' + bilingual();
  const model = buildLyrics(source, '');
  assert.deepEqual(model.rows.slice(1, 5), [1, 3, 5, 7].map((time, i) => ({ time, text: `Original ${i + 1}`, translation: `翻译第${i + 1}句` })));
  assert.equal(model.rows.at(-1).time, 9);
  assert.equal(model.rows.at(-1).text, '');
  assert.equal(activeLyricIndex(model.rows, 2.99), 1);
  assert.equal(activeLyricIndex(model.rows, 3), 2);
  // Legacy parsing still preserves the uncorrected simultaneous source content.
  assert.equal(parseLyrics(source).rows[2].text, '翻译第1句\nOriginal 2');
});

test('three confirmed delayed links can pair a terminal translation without an empty end cue', () => {
  const model = buildLyrics(bilingual({ end: false }), '');
  assert.equal(model.rows.length, 4);
  assert.equal(model.rows.at(-1).translation, '翻译第4句');
});

test('repeated same-time originals and translations are displayed as one original/translation pair', () => {
  const model = buildLyrics(bilingual({ same: true }), '');
  assert.deepEqual(model.rows.slice(0, 4).map(row => row.translation), [1, 2, 3, 4].map(i => `翻译第${i}句`));
  assert.deepEqual(model.rows.slice(0, 4).map(row => row.time), [1, 3, 5, 7]);
});

test('separate timestamped translations override embedded pairs without duplicate inline text', () => {
  const source = bilingual();
  const model = buildLyrics(source, '[00:01]명시 번역\n[00:05]\n[00:20]연결할 수 없는 번역');
  assert.equal(model.rows[0].translation, '명시 번역');
  assert.equal(model.rows[1].translation, '翻译第2句');
  assert.equal(model.rows[2].translation, '');
  assert.deepEqual(model.extraTranslation, ['연결할 수 없는 번역']);
  assert(model.rows.every(row => !row.text.includes('翻译')));
  assert.equal(source, bilingual());
});

test('separate plain translations use corrected row counts; mismatches remain readable', () => {
  const source = bilingual({ end: false });
  assert.deepEqual(buildLyrics(source, '하나\n둘\n셋\n넷').rows.map(row => row.translation), ['하나', '둘', '셋', '넷']);
  const mismatch = buildLyrics(source, '별도 한 줄');
  assert.equal(mismatch.rows[0].translation, '翻译第1句');
  assert.deepEqual(mismatch.extraTranslation, ['별도 한 줄']);
});

test('single-language Chinese, mixed originals, simultaneous vocals and ml alone are not translation evidence', () => {
  for (const source of [
    '[ml:1.0]\n[00:01]Chinese title\n[00:02]中文原文\n[00:03]第二句原文',
    '[00:01]中文原文\n[00:01]English vocal\n[00:02]第二句原文\n[00:02]Second vocal',
    '[00:01]First vocal\n[00:01]Second vocal\n[00:03]Third vocal',
    bilingual({ count: 1 }), bilingual({ count: 2 }),
    '[00:01]가사 中文 혼합\n[00:01]동시 보컬 English'
  ]) {
    const model = buildLyrics(source, '');
    assert.deepEqual(model.rows.map(({ translation, ...row }) => row), parseLyrics(source).rows);
    assert(model.rows.every(row => !row.translation));
  }
});

test('credits, blank gaps, mismatched clocks and multiple stamps do not establish an embedded pair chain', () => {
  for (const source of [
    '[ml:1.0]\n[00:01]Words: Test\n[00:03]作词：测试\n[00:03]Music: Test\n[00:05]作曲：测试\n[00:05]Vocals: Test\n[00:07]演唱：测试',
    bilingual().replace('[00:03.00]Original 2', '[00:04.00]Original 2'),
    bilingual().replace('[00:03.00]Original 2', '\n[00:03.00]Original 2'),
    bilingual().replace('[00:05.00]Original 3', '[00:05.00][00:15.00]Original 3')
  ]) {
    const model = buildLyrics(source, '');
    assert.deepEqual(model.rows.map(({ translation, ...row }) => row), parseLyrics(source).rows);
    assert(model.rows.every(row => !row.translation));
  }
});

test('a bounded Han-only Japanese original requires three strong delayed pairs on both sides', () => {
  const originals = Array.from({ length: 9 }, (_, i) => `Original ${i + 1}`);
  originals[3] = '未開拓領域';
  const model = buildLyrics(bilingual({ count: 9, originals }), '');
  assert.equal(model.rows[3].text, '未開拓領域');
  assert.equal(model.rows[3].translation, '翻译第4句');
  assert(model.rows.slice(0, 9).every(row => row.translation));
  // Two consecutive Han-only originals remain ambiguous and are preserved.
  originals[4] = '中文或日文原文';
  const uncertain = buildLyrics(bilingual({ count: 9, originals }), '');
  assert(uncertain.rows.some(row => row.text.includes('未開拓領域') && row.text.includes('翻译')));
});

test('embedded pairing applies LRC offsets once and preserves annotations and repeated-time structure', () => {
  const source = '\uFEFF[offset:500]\n注释不会消失\n' + bilingual();
  const model = buildLyrics(source, '');
  assert.deepEqual(model.rows.map(row => row.time), [0.5, 2.5, 4.5, 6.5, 8.5]);
  assert.deepEqual(model.extraOriginal, ['注释不会消失']);
  const negative = buildLyrics('[offset:-1000]\n' + bilingual(), '');
  assert.equal(negative.rows[0].time, 2);
});
