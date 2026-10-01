/** Verify the real Developer ID signature and notarization after electron-builder signs. */
const { spawnSync } = require('child_process')
const path = require('path')
const { requiresMacReleaseIntegrity } = require('./releaseIntegrity.cjs')

function commandResult(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return {
    returncode: result.status ?? 1,
    text: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function validateDeveloperIdInspection(returncode, text) {
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

function validateReleaseVerificationResults({ codesign, gatekeeper, stapler }) {
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

function verifyReleaseApplication(appPath) {
  const inspection = commandResult('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
  validateDeveloperIdInspection(inspection.returncode, inspection.text)
  validateReleaseVerificationResults({
    codesign: commandResult('/usr/bin/codesign', [
      '--verify', '--deep', '--strict', '--verbose=2', appPath,
    ]),
    gatekeeper: commandResult('/usr/sbin/spctl', [
      '--assess', '--type', 'execute', '--verbose=4', appPath,
    ]),
    stapler: commandResult('/usr/bin/xcrun', ['stapler', 'validate', appPath]),
  })
}

module.exports = async function afterSign(context) {
  if (!requiresMacReleaseIntegrity(context)) return
  const productFilename = context.packager?.appInfo?.productFilename || 'Robb Agents'
  const appPath = path.join(context.appOutDir, `${productFilename}.app`)
  verifyReleaseApplication(appPath)
  console.log(`release integrity: verified Developer ID signature and notarization for ${appPath}`)
}

module.exports.validateDeveloperIdInspection = validateDeveloperIdInspection
module.exports.validateReleaseVerificationResults = validateReleaseVerificationResults
module.exports.verifyReleaseApplication = verifyReleaseApplication
