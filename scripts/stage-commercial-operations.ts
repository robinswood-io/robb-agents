import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface OperationsBuildManifest {
  schemaVersion: 1;
  product: 'robb-operations';
  edition: 'commercial';
  channel: 'production';
  licenseKeyFingerprint: string;
}

function regularFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return realpathSync(resolved);
}

export function stageCommercialOperations(bundleInput: string, repositoryRoot: string): string {
  const bundle = regularFile(bundleInput, 'Robb Operations bundle');
  const manifestPath = regularFile(join(dirname(bundle), 'build-manifest.json'), 'Robb Operations manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<OperationsBuildManifest>;
  if (manifest.schemaVersion !== 1 || manifest.product !== 'robb-operations' ||
      manifest.edition !== 'commercial' || manifest.channel !== 'production' ||
      typeof manifest.licenseKeyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.licenseKeyFingerprint)) {
    throw new Error('Robb Operations manifest is not an entitled production artifact');
  }

  const target = join(repositoryRoot, 'apps', 'electron', 'dist', 'resources', 'operations');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  // The bundle is ESM and runs outside app.asar; .mjs makes its module format
  // independent of package.json resolution in the unpacked resources folder.
  copyFileSync(bundle, join(target, 'index.mjs'));
  copyFileSync(manifestPath, join(target, 'build-manifest.json'));
  return target;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { bundle: { type: 'string' } } });
  if (!values.bundle) throw new Error('--bundle is required');
  const repositoryRoot = join(import.meta.dir, '..');
  console.log(`Staged commercial operations at ${stageCommercialOperations(values.bundle, repositoryRoot)}`);
}
