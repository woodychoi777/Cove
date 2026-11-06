import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { MusicLibrary } from '../../src/library.mjs';
import { playableFlac } from '../fixtures.mjs';

const code = process.argv[2];
const root = await mkdtemp(join(tmpdir(), 'cove-write-error-'));
const source = join(root, 'original.flac');
const bytes = playableFlac({ seconds: .2 });
await writeFile(source, bytes);
const library = new MusicLibrary({ rootPath: join(root, 'library'), store: { findByChecksum: () => null } });
await library.init();
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = () => new Writable({ write(_chunk, _encoding, callback) {
  setImmediate(() => callback(Object.assign(Error(`simulated ${code}`), { code })));
} });
syncBuiltinESMExports();
try {
  const input = Readable.from((async function* () {
    yield bytes.subarray(0, 8);
    await new Promise(ok => setTimeout(ok, 30));
    yield bytes.subarray(8);
  })());
  await assert.rejects(library.stage(input, 'song.flac'), { code });
  assert.deepEqual(await readFile(source), bytes);
  assert.deepEqual(await readdir(library.incomingPath), []);
  assert.equal(library.staged.size, 0);
  console.log(`handled ${code}; source retained; no staged file`);
} finally {
  fs.createWriteStream = createWriteStream;
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
