import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
for (const code of ['ENOSPC', 'EACCES', 'EIO']) {
  test(`asynchronous destination ${code} is caught without terminating the library process`, async () => {
    const worker = fileURLToPath(new URL('./fixtures/import-write-error.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [worker, code], { timeout: 10000 });
    assert.match(stdout, new RegExp(`handled ${code}; source retained; no staged file`));
  });
}
