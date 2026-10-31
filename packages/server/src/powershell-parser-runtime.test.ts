import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { setPowerShellValidatorRoot } from '@craft-agent/shared/agent/powershell-validator';
import {
  isPowerShellAvailable,
  parseCommand,
  resolveParserScriptPath,
} from '../../shared/src/agent/powershell-validator/parser-process.ts';

test('standalone server initializes the packaged PowerShell parser', () => {
  const entry = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
  const parserRoot = resolve(import.meta.dir, '../../shared/src/agent');
  const parserScript = join(parserRoot, 'powershell-parser.ps1');

  expect(entry).toContain(
    "setPowerShellValidatorRoot(join(import.meta.dir, '..', '..', 'shared', 'src', 'agent'))",
  );
  setPowerShellValidatorRoot(parserRoot);
  expect(resolveParserScriptPath()).toBe(parserScript);
  expect(isPowerShellAvailable()).toBe(true);

  const parsed = parseCommand('Get-Location');
  expect(parsed.success).toBe(true);
});
