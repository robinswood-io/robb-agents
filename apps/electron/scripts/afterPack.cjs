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

module.exports = async function afterPack(context) {
  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const productFilename = context.packager?.appInfo?.productFilename || context.packager?.appInfo?.productName || 'Robinswood Agents';
  const resourcesDir = path.join(appPath, `${productFilename}.app`, 'Contents', 'Resources');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'robinswood-Assets.car');

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  console.log(`afterPack: looking for robinswood-Assets.car at ${precompiledAssets}`);

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
