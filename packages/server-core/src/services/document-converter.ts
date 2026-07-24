import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const MARKITDOWN_SCRIPT = 'markitdown_cli.py'

interface ExecuteFileOptions {
  timeoutMs: number
  maxOutputBytes: number
}

interface ExecuteFileResult {
  stdout: string
  stderr: string
}

export type DocumentConverterExecutor = (
  executable: string,
  args: readonly string[],
  options: ExecuteFileOptions,
) => Promise<ExecuteFileResult>

export interface DocumentConversionOptions {
  appRootPath: string
  resourcesPath: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  execute?: DocumentConverterExecutor
}

function defaultExecutor(
  executable: string,
  args: readonly string[],
  options: ExecuteFileOptions,
): Promise<ExecuteFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: options.maxOutputBytes,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim()
          reject(new Error(detail || error.message))
          return
        }

        resolve({ stdout, stderr })
      },
    )
  })
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))]
}

export function resolveMarkitdownScript(options: DocumentConversionOptions): string {
  const environment = options.environment ?? process.env
  const resourcesBase = environment.CRAFT_RESOURCES_BASE
  const candidates = uniquePaths([
    environment.CRAFT_SCRIPTS
      ? join(environment.CRAFT_SCRIPTS, MARKITDOWN_SCRIPT)
      : undefined,
    resourcesBase
      ? join(resourcesBase, 'resources', 'scripts', MARKITDOWN_SCRIPT)
      : undefined,
    join(options.resourcesPath, 'app', 'resources', 'scripts', MARKITDOWN_SCRIPT),
    join(options.resourcesPath, 'scripts', MARKITDOWN_SCRIPT),
    join(options.appRootPath, 'resources', 'scripts', MARKITDOWN_SCRIPT),
    join(options.appRootPath, 'apps', 'electron', 'resources', 'scripts', MARKITDOWN_SCRIPT),
  ])

  const scriptPath = candidates.find((candidate) => existsSync(candidate))
  if (!scriptPath) {
    throw new Error('Bundled document converter is unavailable')
  }

  return scriptPath
}

export async function convertDocumentToMarkdown(
  inputPath: string,
  options: DocumentConversionOptions,
): Promise<string> {
  const environment = options.environment ?? process.env
  const executable = environment.CRAFT_UV?.trim() || 'uv'
  const scriptPath = resolveMarkitdownScript(options)
  const execute = options.execute ?? defaultExecutor
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Document conversion timeout must be a positive integer')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('Document conversion output limit must be a positive integer')
  }

  const result = await execute(
    executable,
    ['run', '--python', '3.12', scriptPath, inputPath],
    { timeoutMs, maxOutputBytes },
  )
  if (result.stdout.trim().length === 0) {
    throw new Error('Conversion returned empty result')
  }

  return result.stdout
}
