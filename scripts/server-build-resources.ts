import { parseJsonObject, isJsonObject } from '../packages/shared/src/utils/json.ts';
import { dirname, join } from 'path';

import { existsSync, mkdirSync, copyFileSync, cpSync, lstatSync, readdirSync, readFileSync, chmodSync } from 'fs';
import { $ } from 'bun';
import { type Arch, type BuildConfig, downloadBun, downloadUv, getPlatformKey } from "./build/common";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerPlatform = 'darwin' | 'linux';


export interface ServerBuildConfig {
  platform: ServerPlatform;
  arch: Arch;
  rootDir: string;
  electronDir: string;  // Source of resources
  outputDir: string;
  compress: boolean;
  skipDownload: boolean;
  version: string;
}


// ---------------------------------------------------------------------------
// Resource assembly
// ---------------------------------------------------------------------------

export function assembleResources(config: ServerBuildConfig): void {
  const { electronDir, outputDir } = config;
  const srcResources = join(electronDir, 'resources');
  const destResources = join(outputDir, 'resources');

  console.log('  Copying docs, themes, permissions, tool-icons...');
  for (const dir of ['docs', 'themes', 'permissions', 'tool-icons']) {
    const src = join(srcResources, dir);
    if (existsSync(src)) {
      cpSync(src, join(destResources, dir), { recursive: true });
    }
  }

  // Config defaults
  const configDefaults = join(srcResources, 'config-defaults.json');
  if (existsSync(configDefaults)) {
    copyFileSync(configDefaults, join(destResources, 'config-defaults.json'));
  }

  // Python scripts (skip tests/)
  console.log('  Copying Python scripts...');
  const scriptsDir = join(srcResources, 'scripts');
  const destScripts = join(destResources, 'scripts');
  mkdirSync(destScripts, { recursive: true });
  if (existsSync(scriptsDir)) {
    for (const entry of readdirSync(scriptsDir)) {
      if (entry === 'tests') continue;
      const src = join(scriptsDir, entry);
      const stat = lstatSync(src);
      if (stat.isFile()) {
        copyFileSync(src, join(destScripts, entry));
      }
    }
  }

  // Shell wrappers for doc tools (not .cmd files — those are Windows-only)
  console.log('  Copying doc tool wrappers...');
  const binDir = join(destResources, 'bin');
  mkdirSync(binDir, { recursive: true });
  const srcBin = join(srcResources, 'bin');
  if (existsSync(srcBin)) {
    for (const entry of readdirSync(srcBin)) {
      const src = join(srcBin, entry);
      const stat = lstatSync(src);
      // Only copy files (not platform directories), skip .cmd
      if (stat.isFile() && !entry.endsWith('.cmd')) {
        copyFileSync(src, join(binDir, entry));
      }
    }
  }

  // MCP servers
  console.log('  Copying MCP servers...');
  for (const server of ['session-mcp-server']) {
    const src = join(srcResources, server);
    if (existsSync(src)) {
      cpSync(src, join(destResources, server), { recursive: true });
    }
  }

  // Also copy session-mcp-server from packages/ build output (dev path fallback)
  const sessionServerDist = join(config.rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  if (existsSync(sessionServerDist)) {
    const destSessionServer = join(destResources, 'session-mcp-server');
    mkdirSync(destSessionServer, { recursive: true });
    copyFileSync(sessionServerDist, join(destSessionServer, 'index.js'));
  }
}


// ---------------------------------------------------------------------------
// uv binary — download into output dir (not electron resources)
// ---------------------------------------------------------------------------

export async function downloadUvForServer(config: ServerBuildConfig): Promise<void> {
  const { platform, arch, outputDir, skipDownload } = config;
  const uvDest = join(outputDir, 'resources', 'bin', 'uv');

  if (skipDownload && existsSync(uvDest)) {
    console.log('  uv already present, skipping download');
    return;
  }

  // Use common.ts downloadUv which writes to electronDir/resources/bin/{platform-arch}/
  // Then we'll copy the binary to our flat layout
  const platformKey = getPlatformKey(platform, arch);
  const electronUvPath = join(config.electronDir, 'resources', 'bin', platformKey, 'uv');

  if (!existsSync(electronUvPath)) {
    // Download using the shared helper
    const buildConfig: BuildConfig = {
      platform,
      arch,
      upload: false,
      uploadLatest: false,
      uploadScript: false,
      rootDir: config.rootDir,
      electronDir: config.electronDir,
    };
    await downloadUv(buildConfig);
  }

  if (!existsSync(electronUvPath)) {
    throw new Error(`uv binary not found after download at ${electronUvPath}`);
  }

  // Flatten: copy to resources/bin/uv (no platform subdirectory in server dist)
  const binDir = join(outputDir, 'resources', 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(electronUvPath, uvDest);
  await $`chmod +x ${uvDest}`.quiet();
  console.log(`  uv binary installed (${(lstatSync(uvDest).size / 1024 / 1024).toFixed(1)} MB)`);
}


/** Use exactly the desktop's pinned/checksummed artifact for standalone hosts. */
export async function stageRtkForServer(config: ServerBuildConfig): Promise<void> {
  await $`${process.execPath} run ${join(config.rootDir, 'scripts', 'prepare-rtk.ts')} --platform ${config.platform} --arch ${config.arch}`;
  const targetKey = `${config.platform}-${config.arch}`;
  const source = join(config.electronDir, 'resources', 'bin', targetKey, 'rtk');
  const targetDir = join(config.outputDir, 'resources', 'bin', targetKey);
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, join(targetDir, 'rtk'));
  copyFileSync(`${source}.provenance.json`, join(targetDir, 'rtk.provenance.json'));
  chmodSync(join(targetDir, 'rtk'), 0o755);
}


// ---------------------------------------------------------------------------
// Bun runtime — download into output dir
// ---------------------------------------------------------------------------

export async function downloadBunForServer(config: ServerBuildConfig): Promise<void> {
  const { platform, arch, outputDir, skipDownload } = config;
  const runtimeDir = join(outputDir, 'vendor', 'bun');
  const bunDest = join(runtimeDir, 'bun');

  if (skipDownload && existsSync(bunDest)) {
    console.log('  Bun already present, skipping download');
    return;
  }

  // Download to electron's vendor dir using shared helper, then copy
  const buildConfig: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: config.rootDir,
    electronDir: config.electronDir,
  };
  await downloadBun(buildConfig);

  const electronBunPath = join(config.electronDir, 'vendor', 'bun', 'bun');
  if (!existsSync(electronBunPath)) {
    throw new Error(`Bun binary not found after download at ${electronBunPath}`);
  }

  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(electronBunPath, bunDest);
  await $`chmod +x ${bunDest}`.quiet();
  console.log(`  Bun runtime installed (${(lstatSync(bunDest).size / 1024 / 1024).toFixed(1)} MB)`);
}


// ---------------------------------------------------------------------------
// Production node_modules
// ---------------------------------------------------------------------------

/**
 * Recursively resolve and copy a package and its entire dependency tree.
 * Reads each package's package.json to discover transitive deps.
 */
export function copyDependencyTree(
  dep: string,
  srcModules: string,
  destModules: string,
  visited: Set<string>,
): void {
  if (visited.has(dep)) return;
  visited.add(dep);

  const src = join(srcModules, dep);
  if (!existsSync(src)) return;

  // Ensure scope directory exists
  if (dep.startsWith('@')) {
    const scope = dep.split('/')[0]!;
    mkdirSync(join(destModules, scope), { recursive: true });
  }

  const dest = join(destModules, dep);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });

  // Recurse into dependencies
  const pkgPath = join(src, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = parseJsonObject(readFileSync(pkgPath, 'utf-8'));
      const dependencies = pkg['dependencies'];
      if (dependencies !== undefined && !isJsonObject(dependencies)) throw new Error('Invalid dependencies');
      for (const childDep of Object.keys(dependencies ?? {})) {
        copyDependencyTree(childDep, srcModules, destModules, visited);
      }
    } catch {
      // Skip if package.json is malformed
    }
  }
}


/**
 * Scan all .ts files in a directory tree for import/require statements
 * and return the set of external npm package names (not relative paths,
 * not node: builtins, not workspace @craft-agent/* packages).
 */
export function scanImports(dir: string): Set<string> {
  const packages = new Set<string>();
  // Match: import ... from 'pkg', require('pkg'), import('pkg')
  const importRe = /(?:from\s+['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"]+)['"]/g;

  function walk(d: string): void {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'tests' && entry.name !== '__tests__') {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        const content = readFileSync(full, 'utf-8');
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(content)) !== null) {
          const spec = match[1]!;
          // Skip relative imports, node: builtins, workspace packages
          if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('@craft-agent/')) continue;
          // Extract package name (handle scoped: @scope/name)
          const parts = spec.split('/');
          const pkgName = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
          packages.add(pkgName);
        }
      }
    }
  }

  walk(dir);
  return packages;
}


export function copyProductionDeps(config: ServerBuildConfig): void {
  const { rootDir, outputDir, platform, arch } = config;
  const srcModules = join(rootDir, 'node_modules');
  const destModules = join(outputDir, 'node_modules');

  // Track all copied packages to avoid duplicates
  const copied = new Set<string>();

  // -------------------------------------------------------------------------
  // 1. Scan source code for ALL external imports across server packages
  //    This catches everything — declared deps, undeclared deps, transitive
  //    imports that happen to work due to hoisting. No more whack-a-mole.
  // -------------------------------------------------------------------------
  // messaging-gateway is included so its runtime deps (grammy, etc.) land in node_modules.
  // messaging-whatsapp-worker is intentionally OMITTED: Baileys and its transitive deps
  // are bundled directly into packages/messaging-whatsapp-worker/dist/worker.cjs by
  // scripts/build-wa-worker.ts — pulling them into node_modules would duplicate the tree.
  const SERVER_PACKAGES = ['server', 'server-core', 'shared', 'core', 'session-tools-core', 'session-mcp-server', 'messaging-gateway'];

  const allImports = new Set<string>();
  for (const pkg of SERVER_PACKAGES) {
    const pkgSrc = join(rootDir, 'packages', pkg, 'src');
    const imports = scanImports(pkgSrc);
    for (const imp of imports) allImports.add(imp);
  }
  console.log(`  Found ${allImports.size} external packages referenced in source`);

  // Also include declared dependencies (catches deps used only at runtime / dynamically)
  for (const pkg of SERVER_PACKAGES) {
    const pkgJsonPath = join(rootDir, 'packages', pkg, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = parseJsonObject(readFileSync(pkgJsonPath, 'utf-8'));
      const dependencies = pkgJson['dependencies'];
      const peerDependencies = pkgJson['peerDependencies'];
      if (dependencies !== undefined && !isJsonObject(dependencies)) throw new Error('Invalid dependencies');
      if (peerDependencies !== undefined && !isJsonObject(peerDependencies)) throw new Error('Invalid peer dependencies');
      for (const [dep, version] of Object.entries(dependencies ?? {})) {
        if (typeof version === 'string' && version.startsWith('workspace:')) continue;
        allImports.add(dep);
      }
      // Also peer dependencies (they're real runtime deps)
      for (const dep of Object.keys(peerDependencies ?? {})) {
        allImports.add(dep);
      }
    } catch { /* skip */ }
  }

  // Copy each discovered package and its full transitive dependency tree
  for (const dep of allImports) {
    copyDependencyTree(dep, srcModules, destModules, copied);
  }
  console.log(`  Source imports + declared deps: ${copied.size} packages`);

  // -------------------------------------------------------------------------
  // 2. Platform-specific native binaries (optionalDependencies, not in dep trees)
  // -------------------------------------------------------------------------
  // NOTE on `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`: since SDK
  // 0.2.113 the SDK ships only sdk.mjs in the main package; the native
  // `claude` binary lives in this per-platform optional dep. The server runs
  // on its host platform/arch so we ship only the matching one.
  const sdkPlatformPkg = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;

  const PLATFORM_DEPS = [
    `@img/sharp-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`,
    `@img/sharp-libvips-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`,
    '@img/colour',
    sdkPlatformPkg,
    '@vscode/ripgrep',
  ];

  for (const dep of PLATFORM_DEPS) {
    if (copied.has(dep)) continue;
    const src = join(srcModules, dep);
    if (!existsSync(src)) {
      console.log(`  Skipping ${dep} (not installed for current platform)`);
      continue;
    }
    if (dep.startsWith('@')) {
      const scope = dep.split('/')[0]!;
      mkdirSync(join(destModules, scope), { recursive: true });
    }
    mkdirSync(dirname(join(destModules, dep)), { recursive: true });
    cpSync(src, join(destModules, dep), { recursive: true, dereference: true });
    copied.add(dep);
  }

  console.log(`  Total: ${copied.size} packages copied to node_modules`);
}


export function getDirSize(dir: string): number {
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      size += lstatSync(fullPath).size;
    } else if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    }
  }
  return size;
}


// ---------------------------------------------------------------------------
// Workspace packages
// ---------------------------------------------------------------------------

export function copyWorkspacePackages(config: ServerBuildConfig): void {
  const { rootDir, outputDir } = config;

  // messaging-whatsapp-worker is included so dist/worker.cjs (built in step 4) ships.
  // The worker is spawned as a Node subprocess against that file at runtime; see
  // CRAFT_MESSAGING_WA_WORKER env resolution in packages/server/src/index.ts.
  const packages = [
    'server',
    'server-core',
    'shared',
    'core',
    'session-tools-core',
    'session-mcp-server',
    'messaging-gateway',
    'messaging-whatsapp-worker',
  ];

  for (const pkg of packages) {
    const src = join(rootDir, 'packages', pkg);
    const dest = join(outputDir, 'packages', pkg);

    if (!existsSync(src)) {
      console.warn(`  Warning: package ${pkg} not found`);
      continue;
    }

    mkdirSync(dest, { recursive: true });

    // Copy package.json
    copyFileSync(join(src, 'package.json'), join(dest, 'package.json'));

    // Copy tsconfig.json if present
    const tsconfig = join(src, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      copyFileSync(tsconfig, join(dest, 'tsconfig.json'));
    }

    // Copy src/ directory
    const srcDir = join(src, 'src');
    if (existsSync(srcDir)) {
      cpSync(srcDir, join(dest, 'src'), { recursive: true });
    }

    // Copy dist/ directory if present (built artifacts like session-mcp-server)
    const distDir = join(src, 'dist');
    if (existsSync(distDir)) {
      cpSync(distDir, join(dest, 'dist'), { recursive: true });
    }
  }
}
