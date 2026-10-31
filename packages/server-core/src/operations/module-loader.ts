import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  registerRobbOperationsExtension,
  type RobbOperationsExtension,
} from '@craft-agent/shared/operations';

export interface RobbOperationsHostContext {
  dataRoot: string;
  appVersion: string;
  buildChannel: 'development' | 'production';
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export interface RobbOperationsModule {
  createRobbOperationsExtension(
    host: RobbOperationsHostContext,
  ): Promise<RobbOperationsExtension> | RobbOperationsExtension;
}

export interface LoadRobbOperationsModuleOptions extends RobbOperationsHostContext {
  /** Explicit path wins. Missing path means the OSS no-op behavior. */
  modulePath?: string | undefined;
}

function assertSafeModulePath(input: string): string {
  if (!isAbsolute(input)) {
    throw new Error(`Robb Operations module path must be absolute: ${input}`);
  }
  const candidate = resolve(input);
  if (!existsSync(candidate)) {
    throw new Error(`Robb Operations module does not exist: ${candidate}`);
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Robb Operations module must be a regular non-symlink file: ${candidate}`);
  }
  return realpathSync(candidate);
}

/**
 * Load a separately distributed commercial module.
 *
 * No path is auto-discovered from the public source tree. Commercial packaging
 * must provide an explicit file (or ROBB_OPERATIONS_MODULE_PATH), which keeps
 * OSS builds free of proprietary implementation code.
 */
export async function loadRobbOperationsModule(
  options: LoadRobbOperationsModuleOptions,
): Promise<RobbOperationsExtension | null> {
  // Runtime environment injection is a development convenience only. A
  // packaged/production host must pass the fixed bundled path explicitly.
  const developmentPath = !options.isPackaged && options.buildChannel === 'development'
    ? options.env["ROBB_OPERATIONS_MODULE_PATH"]
    : undefined;
  const requestedPath = options.modulePath ?? developmentPath;
  if (!requestedPath) return null;

  const modulePath = assertSafeModulePath(requestedPath);
  const imported = await import(pathToFileURL(modulePath).href) as Partial<RobbOperationsModule>;
  if (typeof imported.createRobbOperationsExtension !== 'function') {
    throw new Error('Robb Operations module does not export createRobbOperationsExtension()');
  }

  const extension = await imported.createRobbOperationsExtension({
    dataRoot: options.dataRoot,
    appVersion: options.appVersion,
    buildChannel: options.buildChannel,
    isPackaged: options.isPackaged,
    env: options.env,
  });
  registerRobbOperationsExtension(extension);
  return extension;
}
