/**
 * Fail-closed integrity checks shared by the macOS production packaging flow.
 *
 * The default export is an electron-builder beforePack hook. The CLI mode is
 * used by build-dmg.sh to reject a dirty checkout before expensive build work.
 */
const { execFileSync } = require('child_process')
const path = require('path')

function parseDirtyFlag(value) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'dirty') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'clean') return false
  return undefined
}

function validateReleaseSourceState({ declaredDirty, gitPorcelain }) {
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

function inspectReleaseSource(rootDir, env = process.env) {
  let gitPorcelain
  let gitCommit
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

  validateReleaseSourceState({ declaredDirty: env.ROBB_BUILD_DIRTY, gitPorcelain })

  const declaredCommit = env.ROBB_BUILD_COMMIT?.trim()
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

function requiresMacReleaseIntegrity(context) {
  if (context?.electronPlatformName !== 'darwin') return false
  const platformValue = context?.packager?.platformSpecificBuildOptions?.forceCodeSigning
  if (typeof platformValue === 'boolean') return platformValue
  return context?.packager?.config?.forceCodeSigning === true
}

function resolveRepositoryRoot(projectDir) {
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

async function beforePack(context) {
  if (!requiresMacReleaseIntegrity(context)) return
  const projectDir = context.packager?.projectDir
  if (!projectDir) throw new Error('Release build refused: electron-builder project directory is unavailable')
  const rootDir = resolveRepositoryRoot(projectDir)
  const commit = inspectReleaseSource(rootDir)
  console.log(`release integrity: verified clean source ${commit}`)
}

module.exports = beforePack
module.exports.inspectReleaseSource = inspectReleaseSource
module.exports.parseDirtyFlag = parseDirtyFlag
module.exports.requiresMacReleaseIntegrity = requiresMacReleaseIntegrity
module.exports.resolveRepositoryRoot = resolveRepositoryRoot
module.exports.validateReleaseSourceState = validateReleaseSourceState

if (require.main === module) {
  const [command, rootDir] = process.argv.slice(2)
  if (command !== '--check-source' || !rootDir) {
    console.error('Usage: node releaseIntegrity.cjs --check-source <repository-root>')
    process.exit(2)
  }
  try {
    process.stdout.write(`${inspectReleaseSource(path.resolve(rootDir))}\n`)
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
