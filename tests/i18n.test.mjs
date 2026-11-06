import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, selectLocale } from '../public/i18n.js';
import { messages } from '../public/translations.js';

test('explicit language wins and System uses the first supported preference', () => {
  assert.equal(selectLocale('ja', ['en-US']), 'ja');
  assert.equal(selectLocale('system', ['fr-FR', 'zh-CN', 'ko-KR']), 'zh');
  assert.equal(selectLocale(undefined, ['ko-KR']), 'ko');
  assert.equal(selectLocale('invalid', ['fr-FR']), 'en');
});

test('the three translated catalogs preserve placeholders and caller text', () => {
  const placeholders = text => [...new Set(text.match(/\{\d+\}/g) || [])].sort();
  for (const [source, row] of Object.entries(messages)) {
    assert.equal(row.length, 3, source);
    for (const translation of row) {
      assert(translation.trim(), source);
      assert.deepEqual(placeholders(translation), placeholders(source), source);
    }
  }
  const track = '닫기 {0} "本当"';
  assert.equal(createTranslator('en')('{0} 듣기', track), `Play ${track}`);
  assert.equal(createTranslator('ja')('{0} 듣기', track), `${track}を再生`);
  assert.equal(createTranslator('zh')('{0} 듣기', track), `播放${track}`);
  assert.equal(createTranslator('ko')('{0} 듣기', track), `${track} 듣기`);
});
