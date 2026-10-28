import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (inventory.error) throw inventory.error;
if (inventory.status !== 0) {
  process.stderr.write(inventory.stderr);
  process.exit(inventory.status ?? 1);
}
const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.mjs') });
const groups = new Map<string, string[]>();
for (const file of [...new Set(inventory.stdout.split('\0'))].sort()) {
  if (!extensions.has(extname(file)) || !existsSync(resolve(root, file))) continue;
  if (await eslint.isPathIgnored(file)) continue;
  const parts = file.split('/');
  const group = (file.startsWith('apps/') || file.startsWith('packages/')) && parts.length > 2
    ? parts.slice(0, 2).join('/') : 'root-and-tools';
  const groupFiles = groups.get(group) ?? [];
  groupFiles.push(file);
  groups.set(group, groupFiles);
}
let failure = 0;
let total = 0;
for (const [group, files] of groups) {
  // Release each TypeScript project service between batches instead of retaining
  // every monorepo program in one ESLint process.
  for (let offset = 0; offset < files.length; offset += 250) {
    const batch = files.slice(offset, offset + 250);
    console.log(`Lint ${group}: ${offset + 1}-${offset + batch.length}/${files.length}`);
    const result = spawnSync(process.execPath, [
      resolve(root, 'node_modules/eslint/bin/eslint.js'),
      '--config', 'eslint.config.mjs', '--max-warnings', '0', ...batch,
    ], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal) {
      console.error(`ESLint terminated by ${result.signal}`);
      process.kill(process.pid, result.signal);
    }
    if (result.status !== 0 && failure === 0) failure = result.status ?? 1;
    total += batch.length;
  }
}
console.log(`Lint coverage: ${total} maintained files; ${groups.size} groups; exit ${failure}`);
process.exitCode = failure;
