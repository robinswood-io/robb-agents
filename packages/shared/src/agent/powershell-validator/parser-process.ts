/**
 * PowerShell Command Validator
 *
 * Uses PowerShell's native System.Management.Automation.Language.Parser to create
 * a proper AST and validate commands in Explore mode. This mirrors the approach
 * used by bash-validator.ts but for PowerShell syntax.
 *
 * AST Node Types (from PowerShell):
 * - ScriptBlockAst: Root node
 * - PipelineAst: Pipeline of commands
 * - CommandAst: Simple command with elements
 * - CommandExpressionAst: Expression used as command
 * - SubExpressionAst: $(...) substitution
 * - ScriptBlockExpressionAst: { ... } script blocks
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { debug } from "../../utils/debug.ts";
import type { ParseResult } from './ast-types.ts';
import { _validatorRoot } from './parser-location.ts';

// ============================================================
// PowerShell Process Management
// ============================================================

let powershellAvailable: boolean | null = null;

let powershellPath: string | null = null;

/**
 * Check if PowerShell (pwsh) is available on this system.
 * Uses synchronous check for compatibility with existing validation flow.
 */
export function isPowerShellAvailable(): boolean {
  if (powershellAvailable !== null) {
    return powershellAvailable;
  }

  // Try pwsh first (PowerShell Core - cross-platform), then Windows PowerShell by name
  const candidates: string[] = ['pwsh', 'powershell'];

  // On Windows, also try the full path to powershell.exe as a fallback.
  // Spawned subprocesses (e.g. from Electron) may not inherit the full system
  // PATH, so 'powershell' by name can fail even though it's always installed.
  if (process.platform === 'win32') {
    const systemRoot = process.env["SystemRoot"] || process.env["SYSTEMROOT"] || 'C:\\Windows';
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }

  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        encoding: 'utf8',
        shell: true,
      });

      if (result.status === 0) {
        powershellPath = cmd;
        powershellAvailable = true;
        debug('[PowerShellValidator] Found PowerShell:', powershellPath);
        return true;
      }
    } catch {
      // Try next option
    }
  }

  powershellAvailable = false;
  debug('[PowerShellValidator] PowerShell not available');
  return false;
}

/**
 * Get the path to the PowerShell parser script.
 * Requires setPowerShellValidatorRoot() to have been called at startup.
 */
export function resolveParserScriptPath(): string {
  if (_validatorRoot) {
    return join(_validatorRoot, 'powershell-parser.ps1');
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(moduleDir, '..', 'powershell-parser.ps1'),
    join(moduleDir, 'powershell-parser.ps1'),
    join(moduleDir, 'resources', 'powershell-parser.ps1'),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'PowerShell validator root not set. Call setPowerShellValidatorRoot() at startup.'
  );
}

function getParserScriptPath(): string {
  return resolveParserScriptPath();
}

/**
 * Parse a PowerShell command using the native parser.
 * Synchronous for compatibility with existing validation flow.
 */
export function parseCommand(command: string): ParseResult {
  if (!powershellPath) {
    return { success: false, error: 'PowerShell not available' };
  }

  const scriptPath = getParserScriptPath();

  try {
    const result = spawnSync(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-Command', command],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10MB for large ASTs
      }
    );

    if (result.error) {
      return {
        success: false,
        error: `Failed to spawn PowerShell: ${result.error.message}`,
      };
    }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    if (result.status !== 0 && !stdout) {
      return {
        success: false,
        error: stderr || `PowerShell exited with code ${result.status}`,
      };
    }

    try {
      return JSON.parse(stdout) as ParseResult;
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse PowerShell output: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } catch (e) {
    return {
      success: false,
      error: `PowerShell execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
