/**
 * Fail-closed source-integrity checks shared by every production packaging
 * flow. macOS signature/notarization verification remains platform-specific
 * in afterSign.ts.
 *
 * The default export is an electron-builder beforePack hook. The CLI mode is
 * used by build-dmg.sh to reject a dirty checkout before expensive build work.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export interface IntegrityContext {
  electronPlatformName?: string | undefined
  packager?: {
    projectDir?: string | undefined
    platformSpecificBuildOptions?: { forceCodeSigning?: boolean | undefined } | undefined
    config?: { forceCodeSigning?: boolean | undefined } | undefined
  } | undefined
}
interface SourceState {
  declaredDirty?: string | undefined
  gitPorcelain?: string | undefined
}
function parseDirtyFlag(value?: string) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'dirty') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'clean') return false
  return undefined
}

function validateReleaseSourceState({ declaredDirty, gitPorcelain }: SourceState) {
  const parsed = parseDirtyFlag(declaredDirty)
  if (declaredDirty?.trim() && parsed === undefined) {
    throw new Error(`Invalid ROBB_BUILD_DIRTY value for release build: ${declaredDirty}`)
  }
  if (parsed === true) {
    throw new Error('Release build refused: source is declared dirty')
  }
  if (gitPorcelain !== undefined && gitPorcelain.trim()) {
    throw new Error(
      `Release build refused: Git checkout has uncommitted or untracked changes:\n${gitPorcelain.trim()}`,
    )
  }
  if (gitPorcelain === undefined && parsed !== false) {
    throw new Error('Release build refused: clean source state could not be verified')
  }
}

function inspectReleaseSource(rootDir: string, env: NodeJS.ProcessEnv = process.env) {
  let gitPorcelain: string | undefined
  let gitCommit: string | undefined
  try {
    gitPorcelain = execFileSync(
      'git',
      ['-C', rootDir, 'status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    gitCommit = execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    // A release source archive may omit .git only when CI explicitly attests
    // both clean state and source commit through build metadata.
  }

  validateReleaseSourceState({ declaredDirty: env['ROBB_BUILD_DIRTY'], gitPorcelain })

  const declaredCommit = env['ROBB_BUILD_COMMIT']?.trim()
  if (gitCommit && declaredCommit && gitCommit !== declaredCommit) {
    throw new Error(
      `Release build refused: ROBB_BUILD_COMMIT ${declaredCommit} does not match checkout ${gitCommit}`,
    )
  }
  const resolvedCommit = gitCommit || declaredCommit
  if (!resolvedCommit || !/^[0-9a-f]{40}$/i.test(resolvedCommit)) {
    throw new Error('Release build refused: exact 40-character source commit could not be verified')
  }
  return resolvedCommit
}

export function requiresMacReleaseIntegrity(context?: IntegrityContext | null) {
  if (context?.electronPlatformName !== 'darwin') return false
  const platformValue = context?.packager?.platformSpecificBuildOptions?.forceCodeSigning
  if (typeof platformValue === 'boolean') return platformValue
  return context?.packager?.config?.forceCodeSigning === true
}

function requiresReleaseSourceIntegrity(context?: IntegrityContext | null, env: NodeJS.ProcessEnv = process.env) {
  const channel = env['ROBB_BUILD_CHANNEL']?.trim().toLowerCase()
  if (channel === 'production') return true
  if (channel === 'development') return false

  // Keep the historical fail-closed macOS behavior for callers which have not
  // yet supplied explicit build-channel metadata. Windows and Linux release
  // wrappers always set the channel before electron-builder starts.
  return requiresMacReleaseIntegrity(context)
}

function resolveRepositoryRoot(projectDir: string) {
  try {
    return execFileSync('git', ['-C', projectDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    // Source archives have no .git; use the known apps/electron layout and
    // require explicit clean/commit attestations in inspectReleaseSource.
    return path.resolve(projectDir, '..', '..')
  }
}

async function beforePack(context: IntegrityContext) {
  if (!requiresReleaseSourceIntegrity(context)) return
  const projectDir = context.packager?.projectDir
  if (!projectDir) throw new Error('Release build refused: electron-builder project directory is unavailable')
  const rootDir = resolveRepositoryRoot(projectDir)
  const commit = inspectReleaseSource(rootDir)
  console.log(`release integrity: verified clean ${context.electronPlatformName || 'unknown'} source ${commit}`)
}

export default Object.assign(beforePack, {
  inspectReleaseSource, parseDirtyFlag, requiresMacReleaseIntegrity,
  requiresReleaseSourceIntegrity, resolveRepositoryRoot, validateReleaseSourceState,
})
if (import.meta.main) {
  const [command, rootDir] = process.argv.slice(2)
  if (command !== '--check-source' || !rootDir) {
    console.error('Usage: node releaseIntegrity.ts --check-source <repository-root>')
    process.exit(2)
  }
  try {
    process.stdout.write(`${inspectReleaseSource(path.resolve(rootDir))}\n`)
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
