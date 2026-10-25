import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, lstatSync, readdirSync } from "fs";
import { join, dirname } from "path";
import type { Arch, BuildConfig, Platform } from './binary-downloads.ts';

/**
 * Per-platform optional-dep package name for the native `claude` binary.
 * Since SDK 0.2.113 the SDK ships only `sdk.mjs` + types; the native CLI
 * lives in a per-arch sibling package (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}`).
 */
function platformBinaryPkg(config: BuildConfig): string {
  const { platform, arch } = config;
  if (platform === 'darwin') return `claude-agent-sdk-darwin-${arch}`;
  if (platform === 'win32') return `claude-agent-sdk-win32-${arch}`;
  if (platform === 'linux') return `claude-agent-sdk-linux-${arch}`;
  throw new Error(`Unsupported platform for SDK binary lookup: ${platform}`);
}

function nativeBinaryName(config: BuildConfig): string {
  return config.platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * Copy SDK from root node_modules:
 *   1. The thin core (`claude-agent-sdk`) — universal sdk.mjs + types.
 *   2. The matching arch's binary package, staged at the stable alias
 *      `claude-agent-sdk-binary/` so electron-builder.yml stays arch-agnostic
 *      and the runtime resolver finds the binary regardless of host arch.
 */
export function copySDK(config: BuildConfig): void {
  const { rootDir, electronDir } = config;
  const sdkScope = join(electronDir, 'node_modules', '@anthropic-ai');

  const sdkSource = join(rootDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const sdkDest = join(sdkScope, 'claude-agent-sdk');

  if (!existsSync(sdkSource)) {
    throw new Error(`SDK core not found at ${sdkSource}. Run 'bun install' first.`);
  }

  console.log('Copying SDK core...');
  mkdirSync(sdkScope, { recursive: true });
  if (existsSync(sdkDest)) {
    rmSync(sdkDest, { recursive: true, force: true });
  }
  cpSync(sdkSource, sdkDest, { recursive: true, dereference: true });

  const pkg = platformBinaryPkg(config);
  const binSource = join(rootDir, 'node_modules', '@anthropic-ai', pkg);
  if (!existsSync(binSource)) {
    throw new Error(
      `SDK native binary package not found at ${binSource}. ` +
      `For cross-arch builds run \`npm pack @anthropic-ai/${pkg}@<sdk-version>\` ` +
      `to fetch it, or use the platform build script (build-dmg.sh / build-linux.sh / build-win.ps1) ` +
      `which handles the cross-fetch automatically.`,
    );
  }

  const aliasDest = join(sdkScope, 'claude-agent-sdk-binary');
  console.log(`Staging SDK native binary (${pkg}) as claude-agent-sdk-binary alias...`);
  if (existsSync(aliasDest)) {
    rmSync(aliasDest, { recursive: true, force: true });
  }
  cpSync(binSource, aliasDest, { recursive: true, dereference: true });
}

/**
 * Verify the native binary was copied correctly (real file, expected size).
 * Since SDK 0.2.113 the binary is ~210 MB; anything under 50 MB is suspect.
 */
export function verifySDKCopy(config: BuildConfig): void {
  const { electronDir } = config;
  const binaryPath = join(
    electronDir,
    'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary',
    nativeBinaryName(config),
  );

  if (!existsSync(binaryPath)) {
    throw new Error(`SDK verification failed: native binary not found at ${binaryPath}`);
  }

  const stats = lstatSync(binaryPath);
  if (stats.isSymbolicLink()) {
    throw new Error('SDK verification failed: native binary is a symlink (should be real file)');
  }

  const size = stats.size;
  if (size < 50_000_000) {
    throw new Error(`SDK verification failed: native binary too small (${size} bytes, expected ~210 MB)`);
  }

  console.log(`  SDK copy verified: native binary is ${(size / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * Copy @vscode/ripgrep into the staged node_modules. Replaces the previous
 * `vendor/ripgrep/<platform>/rg` shipped by the SDK before 0.2.113.
 */
export function copyRipgrep(config: BuildConfig): void {
  const { rootDir, electronDir } = config;
  const rgSource = join(rootDir, 'node_modules', '@vscode', 'ripgrep');
  const binaryName = config.platform === 'win32' ? 'rg.exe' : 'rg';
  const rgBinary = join(rgSource, 'bin', binaryName);

  if (!existsSync(rgSource) || !existsSync(rgBinary)) {
    throw new Error(
      `@vscode/ripgrep not installed or postinstall did not run. ` +
      `Run 'bun install' and 'bun pm trust @vscode/ripgrep'.`,
    );
  }

  const rgScope = join(electronDir, 'node_modules', '@vscode');
  const rgDest = join(rgScope, 'ripgrep');
  console.log('Copying @vscode/ripgrep...');
  mkdirSync(rgScope, { recursive: true });
  if (existsSync(rgDest)) {
    rmSync(rgDest, { recursive: true, force: true });
  }
  cpSync(rgSource, rgDest, { recursive: true, dereference: true });
}

/**
 * Copy network interceptor source files (Anthropic — runs under Bun via --preload)
 */
export function copyInterceptor(config: BuildConfig): void {
  const { rootDir, electronDir } = config;

  const sharedSrcDir = join('packages', 'shared', 'src');
  const sourceDir = join(rootDir, sharedSrcDir);
  const destDir = join(electronDir, sharedSrcDir);

  const interceptorSource = join(sourceDir, 'unified-network-interceptor.ts');
  if (!existsSync(interceptorSource)) {
    throw new Error(`Interceptor not found at ${interceptorSource}`);
  }

  console.log('Copying interceptor...');
  mkdirSync(destDir, { recursive: true });
  copyFileSync(interceptorSource, join(destDir, 'unified-network-interceptor.ts'));

  // Also copy shared infrastructure (imported by unified-network-interceptor.ts at runtime)
  const commonSource = join(sourceDir, 'interceptor-common.ts');
  if (existsSync(commonSource)) {
    copyFileSync(commonSource, join(destDir, 'interceptor-common.ts'));
  }

  // Copy request utilities (imported by unified-network-interceptor.ts)
  const requestUtilsSource = join(sourceDir, 'interceptor-request-utils.ts');
  if (existsSync(requestUtilsSource)) {
    copyFileSync(requestUtilsSource, join(destDir, 'interceptor-request-utils.ts'));
  }

  // Copy feature flags (imported by unified-network-interceptor.ts for fast mode / source templates)
  const featureFlagsSource = join(sourceDir, 'feature-flags.ts');
  if (existsSync(featureFlagsSource)) {
    copyFileSync(featureFlagsSource, join(destDir, 'feature-flags.ts'));
  }
}

/**
 * Verify the unified interceptor CJS bundle exists (runs under Node.js via --require)
 * Built by `bun run build:interceptor` into apps/electron/dist/
 */
export function copyInterceptorBundle(config: BuildConfig): void {
  const { electronDir } = config;

  const source = join(electronDir, 'dist', 'interceptor.cjs');
  if (!existsSync(source)) {
    console.warn('Warning: Interceptor bundle not found at', source, '— tool metadata will be unavailable for Pi sessions');
    return;
  }

  // Already in dist/ which is included in the packaged app — just verify it exists
  console.log('Interceptor bundle verified at:', source);
}

/**
 * Copy Session MCP Server to packaged app resources.
 * The session server provides session-scoped tools (SubmitPlan, config_validate, etc.) for agent sessions.
 */
export function copySessionServer(config: BuildConfig): void {
  const { rootDir, electronDir } = config;

  const sessionSource = join(rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  const sessionDest = join(electronDir, 'resources', 'session-mcp-server', 'index.js');

  if (!existsSync(sessionSource)) {
    console.warn(`Warning: Session server not found at ${sessionSource}. Session-scoped tools will not work.`);
    return;
  }

  console.log('Copying Session MCP Server...');
  mkdirSync(dirname(sessionDest), { recursive: true });
  copyFileSync(sessionSource, sessionDest);
}

/**
 * Map our Platform type to koffi's directory naming convention.
 * koffi uses: darwin_arm64, darwin_x64, linux_x64, win32_x64, etc.
 */
function koffiPlatformDir(platform: Platform, arch: Arch): string {
  return `${platform}_${arch}`;
}

/**
 * Copy Pi Agent Server to packaged app resources.
 *
 * The bun build uses --external koffi so the bare import resolves through
 * node_modules at runtime. We copy the koffi npm package next to index.js
 * with only the target platform's native binary (~4MB instead of ~80MB).
 */
export function copyPiAgentServer(config: BuildConfig): void {
  const { rootDir, electronDir, platform, arch } = config;

  const piSourceDir = join(rootDir, 'packages', 'pi-agent-server', 'dist');
  const piDestDir = join(electronDir, 'resources', 'pi-agent-server');

  if (!existsSync(join(piSourceDir, 'index.js'))) {
    console.warn(`Warning: Pi agent server not found at ${piSourceDir}/index.js. Pi SDK sessions will not work.`);
    return;
  }

  console.log('Copying Pi Agent Server...');
  mkdirSync(piDestDir, { recursive: true });

  // 1. Copy the Pi runtime and the account-backed external-agent bridges.
  for (const runtimeFile of ['index.js', 'antigravity-server.js', 'vibe-acp-server.js']) {
    const source = join(piSourceDir, runtimeFile);
    if (!existsSync(source)) {
      throw new Error(`Pi agent runtime not found at ${source}`);
    }
    copyFileSync(source, join(piDestDir, runtimeFile));
  }

  // 2. Copy koffi npm package (external import, resolved via node_modules at runtime)
  const koffiSource = join(rootDir, 'node_modules', 'koffi');

  if (!existsSync(koffiSource)) {
    console.warn('  Warning: koffi not found in node_modules. Pi SDK sessions may not work.');
    return;
  }

  const koffiDest = join(piDestDir, 'node_modules', 'koffi');
  mkdirSync(koffiDest, { recursive: true });

  // Copy koffi JS files
  for (const entry of ['package.json', 'index.js', 'indirect.js', 'index.d.ts', 'lib']) {
    const src = join(koffiSource, entry);
    if (existsSync(src)) {
      cpSync(src, join(koffiDest, entry), { recursive: true });
    }
  }

  // Copy only the target platform's native binary
  const targetDir = koffiPlatformDir(platform, arch);
  const nativeSrc = join(koffiSource, 'build', 'koffi', targetDir);
  const nativeDest = join(koffiDest, 'build', 'koffi', targetDir);

  if (existsSync(nativeSrc)) {
    mkdirSync(nativeDest, { recursive: true });
    cpSync(nativeSrc, nativeDest, { recursive: true });
    const size = lstatSync(join(nativeSrc, readdirSync(nativeSrc)[0])).size;
    console.log(`  Copied index.js + koffi/${targetDir} (${(size / 1024 / 1024).toFixed(1)}MB)`);
  } else {
    console.warn(`  Warning: koffi native binary not found for ${targetDir}`);
    cpSync(join(koffiSource, 'build'), join(koffiDest, 'build'), { recursive: true });
    console.log('  Copied index.js + koffi (all platforms as fallback)');
  }
}
