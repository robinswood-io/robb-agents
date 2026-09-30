import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRtkBinary } from '../prepare-rtk.ts';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(executable: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'robb-rtk-package-')); scratch.push(dir);
  const file = join(dir, 'rtk');
  writeFileSync(file, (executable ? '#!/bin/sh\nprintf "rtk 0.43.0\\n"\n#' : 'cross-target-binary') + ' '.repeat(1_000_000));
  chmodSync(file, 0o755);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  const receipt = { version: '0.43.0', archiveSha256: 'pinned-archive-sha', binarySha256: digest };
  writeFileSync(`${file}.provenance.json`, JSON.stringify(receipt));
  return { file, receipt };
}
it('accepts a native artifact only with matching version and hash provenance', () => {
  const f = fixture(true);
  expect(validateRtkBinary(f.file, '0.43.0', 'pinned-archive-sha', true)).toBe(true);
  expect(validateRtkBinary(f.file, '0.43.1', 'pinned-archive-sha', true)).toBe(false);
  expect(validateRtkBinary(f.file, '0.43.0', 'different-archive', true)).toBe(false);
  writeFileSync(f.file, 'tampered');
  expect(validateRtkBinary(f.file, '0.43.0', 'pinned-archive-sha', true)).toBe(false);
});
it('verifies cross-target bytes without trying to execute them on the build host', () => {
  const f = fixture(false);
  expect(validateRtkBinary(f.file, '0.43.0', 'pinned-archive-sha', false)).toBe(true);
  rmSync(`${f.file}.provenance.json`);
  expect(validateRtkBinary(f.file, '0.43.0', 'pinned-archive-sha', false)).toBe(false);
});
