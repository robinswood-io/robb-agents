import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { maintainedSourceFiles } from './source-quality.ts';

const root = resolve(import.meta.dir, '..');
const mode = process.argv[2];
if (mode !== 'syntax' && mode !== 'lint') {
  throw new Error('Usage: bun scripts/check-shell.ts syntax|lint');
}
const sources = maintainedSourceFiles(root);
const files = sources.filter(file => file.endsWith('.sh'));
const powershell = sources.filter(file => file.endsWith('.ps1'));
if (files.length === 0) throw new Error('No maintained shell scripts found');

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  return result.status ?? 1;
}

let status = 0;
if (mode === 'syntax') {
  for (const file of files) status = run('bash', ['-n', file]) || status;
} else {
  const version = spawnSync('shellcheck', ['--version'], { cwd: root, encoding: 'utf8' });
  if (version.error) throw version.error;
  if (version.status !== 0 || !version.stdout.includes('version: 0.11.0')) {
    throw new Error('ShellCheck 0.11.0 is required by the quality toolchain');
  }
  status = run('shellcheck', ['--external-sources', '--severity=style', ...files]);
}
const powerShellResult = spawnSync('pwsh', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts/check-powershell.ps1', '-Mode', mode,
], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, ROBB_POWERSHELL_CHECK_FILES: JSON.stringify(powershell) },
});
if (powerShellResult.error) throw powerShellResult.error;
if (powerShellResult.signal) throw new Error(`PowerShell ${mode} terminated by ${powerShellResult.signal}`);
status = powerShellResult.status || status;
if (powerShellResult.status === null) status = 1;
console.log(`Shell ${mode}: ${files.length} maintained scripts; exit ${status}`);
process.exitCode = status;
