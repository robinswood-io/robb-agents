/** Verify the real Developer ID signature and notarization after electron-builder signs. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { requiresMacReleaseIntegrity, type IntegrityContext } from './releaseIntegrity.ts'

interface SignContext extends IntegrityContext {
  appOutDir: string
  packager: {
    appInfo?: { productFilename?: string | undefined } | undefined
    platformSpecificBuildOptions?: {
      forceCodeSigning?: boolean | undefined
      notarize?: boolean | undefined
    } | undefined
    config?: { forceCodeSigning?: boolean | undefined } | undefined
  }
}
interface CommandResult { returncode: number; text: string }
function commandResult(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return {
    returncode: result.status ?? 1,
    text: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function validateDeveloperIdInspection(returncode: number, text: string) {
  if (returncode !== 0) {
    throw new Error(`Developer ID signature inspection failed: ${text}`)
  }
  if (/Signature=adhoc/i.test(text) || /TeamIdentifier=not set/i.test(text)) {
    throw new Error('Production application is ad-hoc signed')
  }
  if (!text.includes('Identifier=io.robinswood.robbagents')) {
    throw new Error('Production signature has an unexpected application identifier')
  }
  if (!/^Authority=Developer ID Application:/m.test(text)) {
    throw new Error('Production signature is not a Developer ID Application signature')
  }
  if (!/^TeamIdentifier=[A-Z0-9]+$/m.test(text)) {
    throw new Error('Production signature has no valid Apple TeamIdentifier')
  }
}

function validateReleaseVerificationResults({ codesign, gatekeeper, stapler }: {
  codesign: CommandResult; gatekeeper: CommandResult; stapler: CommandResult
}) {
  if (codesign.returncode !== 0) {
    throw new Error(`Developer ID signature verification failed: ${codesign.text}`)
  }
  if (gatekeeper.returncode !== 0 || !gatekeeper.text.includes('Notarized Developer ID')) {
    throw new Error(`Notarization assessment failed: ${gatekeeper.text}`)
  }
  if (stapler.returncode !== 0) {
    throw new Error(`Notarization ticket validation failed: ${stapler.text}`)
  }
}

function verifyReleaseApplication(appPath: string, requireNotarization = true) {
  const inspection = commandResult('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
  validateDeveloperIdInspection(inspection.returncode, inspection.text)
  const codesign = commandResult('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appPath,
  ])
  if (!requireNotarization) {
    if (codesign.returncode !== 0) {
      throw new Error(`Developer ID signature verification failed: ${codesign.text}`)
    }
    return
  }
  validateReleaseVerificationResults({
    codesign,
    gatekeeper: commandResult('/usr/sbin/spctl', [
      '--assess', '--type', 'execute', '--verbose=4', appPath,
    ]),
    stapler: commandResult('/usr/bin/xcrun', ['stapler', 'validate', appPath]),
  })
}

async function afterSign(context: SignContext) {
  if (!requiresMacReleaseIntegrity(context)) return
  const productFilename = context.packager?.appInfo?.productFilename || 'Robb Agents'
  const appPath = path.join(context.appOutDir, `${productFilename}.app`)
  const requireNotarization = context.packager?.platformSpecificBuildOptions?.notarize !== false
  verifyReleaseApplication(appPath, requireNotarization)
  console.log(`release integrity: verified Developer ID signature${requireNotarization ? ' and notarization' : ' (local staging)'} for ${appPath}`)
}

export default Object.assign(afterSign, {
  validateDeveloperIdInspection, validateReleaseVerificationResults, verifyReleaseApplication,
})
