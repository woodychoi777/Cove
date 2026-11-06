import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicStore } from '../src/store.mjs';
const { chooseLibrary, isLibrary, createLibraryDirectory } = createRequire(import.meta.url)('../desktop/library-location.cjs');

test('first launch uses Music/Cove, saved library is reused, and override bypasses prompts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cove-location-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'Music', 'Cove'); let prompts = 0;
  const dialog = { showMessageBox: async () => { prompts++; return { response: 0 }; } };
  assert.equal(await chooseLibrary({ settings: {}, defaultDirectory: path, dialog }), path);
  await mkdir(join(path, 'library')); new MusicStore(join(path, 'soriseojae.sqlite')).close();
  assert(isLibrary(path));
  assert.equal(await chooseLibrary({ settings: { dataDirectory: path }, defaultDirectory: 'unused', dialog }), path);
  assert.equal(await chooseLibrary({ settings: {}, override: root, dialog }), root);
  assert.equal(prompts, 1);
});

test('missing/invalid library and canceled selection preserve settings and existing files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cove-location-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'keep.txt'), 'preserve'); assert.throws(() => createLibraryDirectory(root), /빈 폴더/);
  const settings = { dataDirectory: join(root, 'missing') }, before = { ...settings };
  const responses = [2, 2, 3]; let errors = 0, picks = 0;
  const dialog = {
    showMessageBox: async options => { if (options.type === 'error') { errors++; return { response: 0 }; } return { response: responses.shift() }; },
    showOpenDialog: async () => ++picks === 1 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [root] }
  };
  assert.equal(await chooseLibrary({ settings, defaultDirectory: join(root, 'new'), dialog }), null);
  assert.deepEqual(settings, before); assert.equal(errors, 1); assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'preserve');
});
