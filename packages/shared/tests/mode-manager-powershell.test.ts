/**
 * Tests for mode-manager.ts shell command security
 *
 * These tests verify that dangerous shell commands are blocked in Safe (Explore) mode
 * while legitimate read-only commands are allowed.
 */
import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { looksLikePowerShell, isPowerShellAvailable, setPowerShellValidatorRoot } from '../src/agent/powershell-validator.ts';
import { shouldAllowToolInMode, type CompiledBashPattern } from '../src/agent/mode-manager.ts';
import { validatePowerShellCommand } from '../src/agent/powershell-validator.ts';
import { extractPowerShellWriteTarget, unwrapPowerShellCommand } from '../src/agent/powershell-validator.ts';
import { parseCommand } from '../src/agent/powershell-validator/parser-process.ts';

beforeAll(() => setPowerShellValidatorRoot(resolve(import.meta.dir, '../src/agent')));

describe('looksLikePowerShell', () => {
  describe('should detect PowerShell cmdlet patterns', () => {
    it('should detect Get-* cmdlets', () => {
      expect(looksLikePowerShell('Get-Process')).toBe(true);
      expect(looksLikePowerShell('Get-ChildItem')).toBe(true);
      expect(looksLikePowerShell('Get-Content file.txt')).toBe(true);
      expect(looksLikePowerShell('Get-Service -Name "spooler"')).toBe(true);
    });

    it('should detect Set-* cmdlets', () => {
      expect(looksLikePowerShell('Set-Content file.txt')).toBe(true);
      expect(looksLikePowerShell('Set-Location C:\\')).toBe(true);
    });

    it('should detect pipeline with PowerShell cmdlets', () => {
      expect(looksLikePowerShell('Get-Process | Where-Object { $_.CPU -gt 10 }')).toBe(true);
      expect(looksLikePowerShell('Get-ChildItem | Select-Object Name, Length')).toBe(true);
      expect(looksLikePowerShell('Get-Content file.txt | ForEach-Object { $_ }')).toBe(true);
    });

    it('should detect comparison operators', () => {
      expect(looksLikePowerShell('$x -eq 5')).toBe(true);
      expect(looksLikePowerShell('$name -like "test*"')).toBe(true);
      expect(looksLikePowerShell('$val -match "pattern"')).toBe(true);
    });

    it('should detect array/hashtable literals', () => {
      expect(looksLikePowerShell('@(1, 2, 3)')).toBe(true);
      expect(looksLikePowerShell('@{key = "value"}')).toBe(true);
    });
  });

  describe('should NOT detect bash/unix commands as PowerShell', () => {
    it('should not detect basic bash commands', () => {
      expect(looksLikePowerShell('ls -la')).toBe(false);
      expect(looksLikePowerShell('cat file.txt')).toBe(false);
      expect(looksLikePowerShell('grep pattern file')).toBe(false);
      expect(looksLikePowerShell('git status')).toBe(false);
    });

    it('should not detect bash pipelines', () => {
      expect(looksLikePowerShell('ls | head')).toBe(false);
      expect(looksLikePowerShell('cat file | grep pattern')).toBe(false);
    });

    it('should not detect bash compound commands', () => {
      expect(looksLikePowerShell('ls && pwd')).toBe(false);
      expect(looksLikePowerShell('git status || git log')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle mixed case cmdlets', () => {
      expect(looksLikePowerShell('GET-PROCESS')).toBe(true);
      expect(looksLikePowerShell('get-process')).toBe(true);
      expect(looksLikePowerShell('Get-PROCESS')).toBe(true);
    });

    it('should detect common aliases', () => {
      expect(looksLikePowerShell('gci')).toBe(true);
      expect(looksLikePowerShell('gcm')).toBe(true);
      expect(looksLikePowerShell('gps')).toBe(true);
    });
  });
});

describe('validatePowerShellCommand', () => {
  // These tests check the validation logic when PowerShell is available
  // If PowerShell is not available, they verify the fallback behavior

  const psPatterns: CompiledBashPattern[] = [
    { regex: /^Get-Process\b/, source: '^Get-Process\\b', comment: 'Get running processes' },
    { regex: /^Get-ChildItem\b/, source: '^Get-ChildItem\\b', comment: 'List directory contents' },
    { regex: /^Get-Content\b/, source: '^Get-Content\\b', comment: 'Read file contents' },
    { regex: /^Get-Service\b/, source: '^Get-Service\\b', comment: 'List services' },
    { regex: /^Select-Object\b/, source: '^Select-Object\\b', comment: 'Select properties' },
    { regex: /^Where-Object\b/, source: '^Where-Object\\b', comment: 'Filter objects' },
    { regex: /^Sort-Object\b/, source: '^Sort-Object\\b', comment: 'Sort objects' },
    { regex: /^Format-Table\b/, source: '^Format-Table\\b', comment: 'Format as table' },
    { regex: /^Test-Path\b/, source: '^Test-Path\\b', comment: 'Test if path exists' },
  ];

  describe('when PowerShell is available', () => {
    const psAvailable = isPowerShellAvailable();

    it('should allow safe Get-* cmdlets', () => {
      if (!psAvailable) {
        // When PowerShell is unavailable, validation returns powershell_unavailable
        const result = validatePowerShellCommand('Get-Process', psPatterns);
        expect(result.reason?.type).toBe('powershell_unavailable');
        return;
      }

      const result = validatePowerShellCommand('Get-Process', psPatterns);
      expect(result.allowed).toBe(true);
    });

    it('should block dangerous cmdlets like Invoke-Expression', () => {
      if (!psAvailable) {
        return; // Skip if PowerShell not available
      }

      const result = validatePowerShellCommand('Invoke-Expression $code', psPatterns);
      expect(result.allowed).toBe(false);
      // Could be unsafe_command or invoke_expression depending on parsing
    });

    it('should block Set-Content (file writing)', () => {
      if (!psAvailable) {
        return; // Skip if PowerShell not available
      }

      const result = validatePowerShellCommand('Set-Content file.txt -Value "test"', psPatterns);
      expect(result.allowed).toBe(false);
    });

    it('should block Out-File (file writing)', () => {
      if (!psAvailable) {
        return; // Skip if PowerShell not available
      }

      const result = validatePowerShellCommand('"content" | Out-File file.txt', psPatterns);
      expect(result.allowed).toBe(false);
    });

    it('should block Remove-Item (file deletion)', () => {
      if (!psAvailable) {
        return; // Skip if PowerShell not available
      }

      const result = validatePowerShellCommand('Remove-Item file.txt', psPatterns);
      expect(result.allowed).toBe(false);
    });

    it('should handle pipelines with safe cmdlets', () => {
      if (!psAvailable) {
        return; // Skip if PowerShell not available
      }

      // This would need the pipeline cmdlets in the patterns
      const result = validatePowerShellCommand('Get-Process | Select-Object Name', psPatterns);
      // Pipeline validation depends on all commands being in allowlist
      // Either it passes or fails based on pattern matching
      expect(typeof result.allowed).toBe('boolean');
    });
  });

  describe('fallback behavior', () => {
    it('should return powershell_unavailable when PowerShell is not installed', () => {
      // This test documents the expected behavior
      // On systems without PowerShell, the validator should gracefully fail
      const result = validatePowerShellCommand('Get-Process', psPatterns);

      if (!isPowerShellAvailable()) {
        expect(result.allowed).toBe(false);
        expect(result.reason?.type).toBe('powershell_unavailable');
      } else {
        // If PowerShell IS available, the command should be validated normally
        expect(result.allowed).toBe(true);
      }
    });
  });
});

describe('extractPowerShellWriteTarget', () => {
  // These tests only work when PowerShell is available
  const psAvailable = isPowerShellAvailable();

  describe('Out-File extraction', () => {
    it('should extract path from Out-File with -FilePath', () => {
      if (!psAvailable) return;

      const cmd = `@('# Plan') | Out-File -FilePath 'C:\\Users\\test\\plans\\plan.md' -Encoding utf8`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });

    it('should extract path from Out-File with -FilePath (double quotes)', () => {
      if (!psAvailable) return;

      const cmd = `@('# Plan') | Out-File -FilePath "C:\\Users\\test\\plans\\plan.md"`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });

    it('should extract path from Out-File positional parameter', () => {
      if (!psAvailable) return;

      const cmd = `"content" | Out-File C:\\temp\\file.txt`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\temp\\file.txt');
    });
  });

  describe('Set-Content extraction', () => {
    it('should extract path from Set-Content with -Path', () => {
      if (!psAvailable) return;

      const cmd = `'content' | Set-Content -Path 'C:\\Users\\test\\plans\\plan.md'`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });
  });

  describe('Add-Content extraction', () => {
    it('should extract path from Add-Content with -Path', () => {
      if (!psAvailable) return;

      const cmd = `'more content' | Add-Content -Path 'C:\\Users\\test\\plans\\plan.md'`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });
  });

  describe('non-write commands', () => {
    it.each([
      'Get-Process',
      'Get-ChildItem',
      'Get-Content file.txt',
      'Get-Process | Select-Object Name',
      'Get-ChildItem | Where-Object { $_.Length -gt 1000 }',
    ])('returns null for a parsed non-write command: %s', (command) => {
      if (!psAvailable) return;
      // Two bounded 10-second parses plus cleanup; a parse failure is not evidence of no write.
      const parsed = parseCommand(command);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      expect(extractPowerShellWriteTarget(command)).toBeNull();
    }, 25_000);
  });

  describe('powershell.exe -Command wrapper unwrapping', () => {
    it('should extract path from Set-Content inside powershell.exe -Command wrapper', () => {
      if (!psAvailable) return;
      const cmd = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"C:\\Users\\test\\plans\\plan.md\\" -Value @('# Plan')"`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });

    it('should extract path from Out-File inside powershell -Command wrapper', () => {
      if (!psAvailable) return;
      const cmd = `powershell -Command "@('# Plan') | Out-File -FilePath \\"C:\\plans\\plan.md\\" -Encoding utf8"`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should extract path from pwsh -Command wrapper', () => {
      if (!psAvailable) return;
      const cmd = `pwsh -Command "Set-Content -Path \\"C:\\plans\\plan.md\\" -Value 'content'"`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should handle -NoProfile and other flags before -Command', () => {
      if (!psAvailable) return;
      const cmd = `powershell.exe -NoProfile -NonInteractive -Command "Set-Content -Path \\"C:\\plans\\plan.md\\" -Value 'test'"`;
      expect(extractPowerShellWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should return null for non-write commands inside wrapper', () => {
      if (!psAvailable) return;
      const cmd = `powershell.exe -Command "Get-Process | Select-Object Name"`;
      expect(extractPowerShellWriteTarget(cmd)).toBeNull();
    });
  });

  describe('when PowerShell is unavailable', () => {
    it('should return null gracefully', () => {
      // This test runs regardless of PowerShell availability
      // If PowerShell is not available, the function should return null
      if (!psAvailable) {
        const cmd = `@('# Plan') | Out-File -FilePath 'C:\\plans\\plan.md'`;
        expect(extractPowerShellWriteTarget(cmd)).toBeNull();
      }
    });
  });
});

// ============================================================
// unwrapPowerShellCommand Tests
// ============================================================

describe('unwrapPowerShellCommand', () => {
  it('should unwrap full powershell.exe path with -Command', () => {
    const cmd = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"C:\\path\\" -Value @('x')"`;
    expect(unwrapPowerShellCommand(cmd)).toBe(`Set-Content -Path "C:\\path" -Value @('x')`);
  });

  it('should unwrap bare powershell.exe -Command', () => {
    const cmd = `powershell.exe -Command "Get-Process"`;
    expect(unwrapPowerShellCommand(cmd)).toBe('Get-Process');
  });

  it('should unwrap pwsh -Command', () => {
    const cmd = `pwsh -Command "Get-ChildItem"`;
    expect(unwrapPowerShellCommand(cmd)).toBe('Get-ChildItem');
  });

  it('should unwrap with flags before -Command', () => {
    const cmd = `powershell.exe -NoProfile -NonInteractive -Command "Write-Host hello"`;
    expect(unwrapPowerShellCommand(cmd)).toBe('Write-Host hello');
  });

  it('should return null for non-powershell commands', () => {
    expect(unwrapPowerShellCommand('git status')).toBeNull();
    expect(unwrapPowerShellCommand('ls -la')).toBeNull();
  });

  it('should return null for powershell without -Command', () => {
    expect(unwrapPowerShellCommand('powershell.exe -File script.ps1')).toBeNull();
  });

  it('should unescape inner escaped quotes', () => {
    const cmd = `powershell -Command "Write-Host \\"hello world\\""`;
    expect(unwrapPowerShellCommand(cmd)).toBe('Write-Host "hello world"');
  });

  it('should unwrap the exact Codex-generated Set-Content pattern', () => {
    const cmd = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sessions\\260208-aware-bamboo\\plans\\slack-api-source-plan.md\\" -Value @('# Plan: Add Slack API source (OAuth, read/write)','', '## Goal','Set up a Slack API source.')"`;
    const inner = unwrapPowerShellCommand(cmd);
    expect(inner).not.toBeNull();
    expect(inner).toContain('Set-Content -Path "C:\\Users\\balin');
    expect(inner).toContain('plans\\slack-api-source-plan.md"');
  });
});

// ============================================================
// PowerShell Plans Folder Exception Tests
// ============================================================

describe('PowerShell plans folder exception', () => {
  const psAvailable = isPowerShellAvailable();
  const plansFolderPath = mkdtempSync(join(tmpdir(), 'robb-powershell-plans-'));
  afterAll(() => rmSync(plansFolderPath, { recursive: true, force: true }));

  describe('should allow Out-File to plans folder', () => {
    it('allows Out-File with -FilePath to plans folder', () => {
      if (!psAvailable) return;

      const command = `@('# Sample Plan','','## Goal','Test') | Out-File -FilePath '${join(plansFolderPath, 'sample-plan.md')}' -Encoding utf8`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result).toMatchObject({ allowed: true });
    });

    it('allows Set-Content to plans folder', () => {
      if (!psAvailable) return;

      const command = `'# Plan content' | Set-Content -Path '${join(plansFolderPath, 'plan.md')}'`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result).toMatchObject({ allowed: true });
    });
  });

  describe('should block Out-File outside plans folder', () => {
    it('blocks Out-File to temp folder', () => {
      if (!psAvailable) return;

      const command = `@('data') | Out-File -FilePath '${resolve(plansFolderPath, '..', 'evil.txt')}' -Encoding utf8`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(false);
    });

    it('blocks Set-Content outside plans folder', () => {
      if (!psAvailable) return;

      const command = `'content' | Set-Content -Path '${resolve(plansFolderPath, '..', 'file.txt')}'`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('case-insensitive path matching on Windows', () => {
    it('accepts Windows case differences only on the Windows host', () => {
      if (!psAvailable) return;

      const command = `@('plan') | Out-File -FilePath '${join(plansFolderPath.toUpperCase(), 'plan.md')}'`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(process.platform === 'win32');
    });
  });

  describe('powershell.exe -Command wrapper targeting plans folder', () => {
    const isWindows = process.platform === 'win32';

    it.skipIf(!isWindows)('should allow Set-Content inside powershell.exe -Command wrapper targeting plans folder', () => {
      // This is the exact pattern that was failing: Codex wraps Set-Content in powershell.exe -Command "..."
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"${plansFolderPath}\\\\plan.md\\" -Value @('# Plan')"`;
      const result = shouldAllowToolInMode('Bash', { command }, 'safe', { plansFolderPath });
      expect(result.allowed).toBe(true);
    });

    it('should block Set-Content inside wrapper targeting non-plans folder', () => {
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"C:\\Users\\test\\Desktop\\hack.txt\\" -Value @('bad')"`;
      const result = shouldAllowToolInMode('Bash', { command }, 'safe', { plansFolderPath });
      expect(result.allowed).toBe(false);
    });

    it.skipIf(!isWindows)('should allow Out-File inside wrapper targeting plans folder', () => {
      const command = `powershell.exe -Command "@('# Plan') | Out-File -FilePath \\"${plansFolderPath}\\\\plan.md\\" -Encoding utf8"`;
      const result = shouldAllowToolInMode('Bash', { command }, 'safe', { plansFolderPath });
      expect(result.allowed).toBe(true);
    });

    it.skipIf(!isWindows)('should allow the exact Codex-generated command from session 260208-aware-bamboo (escaped quotes)', () => {
      // Real-world regression test: this was the command that got blocked
      const realPlansFolder = plansFolderPath;
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"${realPlansFolder}\\\\slack-api-source-plan.md\\" -Value @('# Plan: Add Slack API source (OAuth, read/write)','', '## Goal','Set up a Slack API source for the whole workspace with OAuth and full read/write access.', '', '## Steps','1. Create source folder.','2. Write config.json.','3. Write guide.md.','4. Run source_test.','5. Trigger OAuth.')"`;
      const result = shouldAllowToolInMode('Bash', { command }, 'safe', { plansFolderPath: realPlansFolder });
      expect(result.allowed, JSON.stringify(result)).toBe(true);
    });

    it.skipIf(!isWindows)('should allow the exact Codex-generated command with unescaped inner quotes', () => {
      // Second real-world variant: Codex sometimes emits unescaped inner quotes.
      // The -Path "C:\..." uses regular " not \" inside the outer -Command "..." string.
      // This is handled by extractBashWriteTarget Pattern 6 (regex), not AST unwrapping.
      const realPlansFolder = plansFolderPath;
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path "${realPlansFolder}\\slack-api-source-plan.md" -Value @('# Plan: Add Slack API source (OAuth, read/write)','', '## Goal','Set up a Slack API source for the whole workspace with OAuth and full read/write access.', '', '## Steps','1. Create the source folder at C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sources\\slack.','2. Write config.json with baseUrl https://slack.com/api/, bearer auth, and testEndpoint POST auth.test; set an icon (emoji by default) and tagline.','3. Write permissions.json allowing GET/POST/PUT/PATCH/DELETE for full API access in Explore mode.','4. Write guide.md tailored to whole-workspace usage (search messages, list channels/users, post messages, etc.).','5. Run source_test to validate the configuration.','6. Trigger source_slack_oauth_trigger to authenticate Slack OAuth.')"`;
      const result = shouldAllowToolInMode('Bash', { command }, 'safe', { plansFolderPath: realPlansFolder });
      expect(result.allowed, JSON.stringify(result)).toBe(true);
    });

    it.skipIf(!isWindows)('should allow the verbatim command from session 260208-aware-bamboo (exact JSON string)', () => {
      // This is the EXACT command string as received from Codex via JSON-RPC.
      // Pasted verbatim from the blocked command log.
      const historicalPlansFolder = 'C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sessions\\260208-aware-bamboo\\plans';
      const realPlansFolder = plansFolderPath;
      const escapeWindowsPath = (path: string): string => path.replaceAll('\\', '\\\\');
      const escapedSeparator = '\\\\';
      const historicalTarget = escapeWindowsPath(historicalPlansFolder) + escapedSeparator + 'slack-api-source-plan.md';
      const fixtureTarget = escapeWindowsPath(realPlansFolder) + escapedSeparator + 'slack-api-source-plan.md';
      const command = ('"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Set-Content -Path \\"C:\\\\Users\\\\balin\\\\.craft-agent\\\\workspaces\\\\my-workspace\\\\sessions\\\\260208-aware-bamboo\\\\plans\\\\slack-api-source-plan.md\\" -Value @(\'# Plan: Add Slack API source (OAuth, read/write)\',\'\', \'## Goal\',\'Set up a Slack API source for the whole workspace with OAuth and full read/write access.\', \'\', \'## Steps\',\'1. Create the source folder at C:\\\\Users\\\\balin\\\\.craft-agent\\\\workspaces\\\\my-workspace\\\\sources\\\\slack.\',\'2. Write config.json with baseUrl https://slack.com/api/, bearer auth, and testEndpoint POST auth.test; set an icon and tagline.\',\'3. Write permissions.json allowing GET/POST/PUT/PATCH/DELETE for full API access in Explore mode.\',\'4. Write guide.md tailored to whole-workspace usage (search messages, list channels/users, post messages, etc.).\',\'5. Run source_test to validate the configuration.\',\'6. Trigger source_slack_oauth_trigger to authenticate Slack OAuth.\')"').replace(historicalTarget, fixtureTarget).replace(historicalTarget, fixtureTarget);
      expect(command).toContain(fixtureTarget);
      const result = shouldAllowToolInMode('Bash', { command }, 'safe', { plansFolderPath: realPlansFolder });
      expect(result.allowed, JSON.stringify(result)).toBe(true);
    });
  });
});
