import { describe, expect, it } from 'bun:test';
import { looksLikePowerShell } from './command-syntax.ts';

describe('PowerShell command detection', () => {
  it.each([
    'touch /fixture/new-target',
    'cat /tmp/Get-Content.txt',
    'cat /tmp/Select-Object.txt',
    'cat /tmp/gci/report.txt',
    'echo New-Item',
    'echo "Get-Content"',
  ])('keeps Bash paths and arguments in the Bash validator: %s', command => {
    expect(looksLikePowerShell(command)).toBe(false);
  });

  it.each([
    'Get-Content report.txt',
    '  New-Item report.txt',
    'pwd; Get-Content report.txt',
    'echo input | Select-Object Name',
    '& Get-Content report.txt',
    '{ Get-Content report.txt }',
    'gci C:\\',
    '$value -eq 5',
    '@{key = "value"}',
  ])('retains PowerShell syntax detection: %s', command => {
    expect(looksLikePowerShell(command)).toBe(true);
  });
});
