/**
 * electron-builder afterPack hook
 *
 * Copies the pre-compiled macOS 26+ Liquid Glass icon (robinswood-Assets.car) into the
 * app bundle when present. The Robinswood .icon source catalog lives in
 * resources/robinswood-icon.icon/, but the local actool CLI does not currently emit a
 * new Assets.car from that input in CI/dev smoke-tests. Do not commit a
 * robinswood-Assets.car unless it is verified to differ from the upstream Assets.car.
 *
 * Until a verified Robinswood Assets.car is available, the app falls back to
 * robinswood-icon.icns which is
 * included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Arch } = require('builder-util');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function requireRegularExecutable(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  if ((stats.mode & 0o111) === 0) {
    throw new Error(`${label} must be executable: ${filePath}`);
  }
}

function verifyPackagedUvMatchesStaged(context, resourcesDir) {
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS architecture for packaged uv verification: ${String(arch)}`);
  }

  const platformKey = `darwin-${arch}`;
  const stagedUv = path.join(context.packager.projectDir, 'resources', 'bin', platformKey, 'uv');
  const packagedUv = path.join(resourcesDir, 'app', 'resources', 'bin', platformKey, 'uv');
  requireRegularExecutable(stagedUv, 'checksum-verified staged uv runtime');
  requireRegularExecutable(packagedUv, 'packaged uv runtime');

  const stagedHash = sha256File(stagedUv);
  const packagedHash = sha256File(packagedUv);
  if (packagedHash !== stagedHash) {
    throw new Error(
      `Packaged uv runtime differs from the checksum-verified staged binary `
      + `(expected ${stagedHash}, received ${packagedHash})`,
    );
  }
  console.log(`afterPack: verified exact staged uv payload for ${platformKey} (${stagedHash})`);
}

module.exports = async function afterPack(context) {
  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const productFilename = context.packager?.appInfo?.productFilename || context.packager?.appInfo?.productName || 'Robb Agents';
  const resourcesDir = path.join(appPath, `${productFilename}.app`, 'Contents', 'Resources');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'robinswood-Assets.car');

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  console.log(`afterPack: looking for robinswood-Assets.car at ${precompiledAssets}`);
  // extraResources have been copied at this point, but electron-builder has not
  // signed nested Mach-O files yet. This is the only stage where the complete
  // uv file hash can be compared exactly with the checksum-verified download;
  // codesign legitimately rewrites the Mach-O signature bytes afterwards.
  verifyPackagedUvMatchesStaged(context, resourcesDir);

  // Check if pre-compiled Robinswood Assets.car exists
  if (!fs.existsSync(precompiledAssets)) {
    console.log('Warning: Pre-compiled robinswood-Assets.car not found in resources/');
    console.log('The app will use the fallback robinswood-icon.icns on all macOS versions');
    return;
  }

  // Copy pre-compiled Robinswood Assets.car to the app bundle
  const destAssetsCar = path.join(resourcesDir, 'Assets.car');
  try {
    fs.copyFileSync(precompiledAssets, destAssetsCar);
    console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
  } catch (err) {
    // Don't fail the build if robinswood-Assets.car can't be copied - app will use fallback robinswood-icon.icns
    console.log(`Warning: Could not copy robinswood-Assets.car: ${err.message}`);
    console.log('The app will use the fallback robinswood-icon.icns on all macOS versions');
  }
};

module.exports.verifyPackagedUvMatchesStaged = verifyPackagedUvMatchesStaged;
