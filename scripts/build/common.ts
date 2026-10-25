/**
 * Common build utilities shared across all platforms
 */
import { $ } from "bun";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import "crypto";

import type { Arch, BuildConfig, Platform } from './common/binary-downloads.ts';

/**
 * Clean previous build artifacts
 */
export function cleanBuildArtifacts(config: BuildConfig): void {
  const { electronDir } = config;

  console.log('Cleaning previous builds...');

  const foldersToClean = [
    join(electronDir, 'vendor'),
    join(electronDir, 'node_modules', '@anthropic-ai'),
    join(electronDir, 'packages'),
    join(electronDir, 'release'),
  ];

  for (const folder of foldersToClean) {
    if (existsSync(folder)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

/**
 * Install dependencies
 * On Windows, uses hoisted linker to avoid .bun symlink directory
 */
export async function installDependencies(config: BuildConfig): Promise<void> {
  const { rootDir, platform } = config;

  if (platform === 'win32') {
    // Use hoisted linker on Windows - Bun's default isolated mode creates
    // node_modules/.bun/ with symlinks that esbuild can't traverse on Windows
    // ("Access is denied" errors with junction points)
    // Hoisted mode creates flat npm-style node_modules without .bun
    console.log('Installing dependencies (Windows hoisted mode)...');
    await $`cd ${rootDir} && bun install --linker=hoisted`.quiet();
  } else {
    console.log('Installing dependencies...');
    await $`cd ${rootDir} && bun install`.quiet();
  }
}

/**
 * Build MCP servers (session) and Pi agent server.
 * Shared across all platforms to avoid drift.
 */
export function buildMcpServers(config: BuildConfig): void {
  const { rootDir } = config;

  const sessionDir = join(rootDir, 'packages', 'session-mcp-server');
  const sessionOut = join(sessionDir, 'dist', 'index.js');
  const piDir = join(rootDir, 'packages', 'pi-agent-server');
  const piOut = join(piDir, 'dist', 'index.js');

  console.log('Building MCP servers...');

  mkdirSync(join(sessionDir, 'dist'), { recursive: true });

  execSync(
    `bun build "${join(sessionDir, 'src', 'index.ts')}" --outfile "${sessionOut}" --target node --format cjs`,
    { cwd: rootDir, stdio: 'inherit', shell: true }
  );

  if (!existsSync(sessionOut)) {
    throw new Error(`Session MCP server output not found at ${sessionOut}`);
  }

  // Pi agent server uses --target=bun --format=esm because its Pi SDK deps are ESM-only.
  // --target=node --format=cjs leaves ESM deps as external require() calls that fail at runtime.
  // koffi is marked external because it's a native N-API module — bun can't inline .node binaries
  // and inlining its JS breaks the native binary resolution paths.
  // Optional: skip if package directory is missing (e.g., not synced to OSS).
  if (existsSync(join(piDir, 'src'))) {
    mkdirSync(join(piDir, 'dist'), { recursive: true });
    execSync(
      `bun build "${join(piDir, 'src', 'index.ts')}" "${join(piDir, 'src', 'antigravity-server.ts')}" "${join(piDir, 'src', 'vibe-acp-server.ts')}" --outdir "${join(piDir, 'dist')}" --target bun --format esm --external koffi`,
      { cwd: rootDir, stdio: 'inherit', shell: true }
    );
    if (!existsSync(piOut)) {
      throw new Error(`Pi agent server output not found at ${piOut}`);
    }
  } else {
    console.warn('Warning: Pi agent server package not found. Pi SDK sessions will not work.');
  }
}

/**
 * Build the WhatsApp worker subprocess (Baileys + Node runtime bundle).
 * Output ships as an extraResource at resources/messaging-whatsapp-worker/worker.cjs
 * and is spawned by WhatsAppAdapter. See electron-builder.yml `extraResources`.
 */
export function buildWhatsAppWorker(config: BuildConfig): void {
  const { rootDir } = config;
  const workerOut = join(rootDir, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs');

  console.log('Building WhatsApp worker...');

  execSync('bun run build:wa-worker', { cwd: rootDir, stdio: 'inherit', shell: true });

  if (!existsSync(workerOut)) {
    throw new Error(`WhatsApp worker output not found at ${workerOut}`);
  }
}

/**
 * Verify MCP helper servers and Pi agent server are present in packaged resources.
 */
export function verifyMcpServersExist(config: BuildConfig): void {
  const { electronDir } = config;

  const sessionPath = join(electronDir, 'resources', 'session-mcp-server', 'index.js');
  const piPath = join(electronDir, 'resources', 'pi-agent-server', 'index.js');
  const antigravityPath = join(electronDir, 'resources', 'pi-agent-server', 'antigravity-server.js');
  const vibePath = join(electronDir, 'resources', 'pi-agent-server', 'vibe-acp-server.js');

  if (!existsSync(sessionPath)) {
    throw new Error(`Session MCP server not found at ${sessionPath}`);
  }
  if (!existsSync(piPath)) {
    console.warn(`Warning: Pi agent server not found at ${piPath}. Pi SDK sessions will not work.`);
  }
  if (!existsSync(antigravityPath)) {
    throw new Error(`Google Antigravity bridge not found at ${antigravityPath}`);
  }
  if (!existsSync(vibePath)) {
    throw new Error(`Mistral Vibe bridge not found at ${vibePath}`);
  }
}

/**
 * Build the Electron app (main, preload, renderer)
 */
export async function buildElectronApp(config: BuildConfig): Promise<void> {
  const { rootDir } = config;

  console.log('Building Electron app...');
  await $`cd ${rootDir} && bun run electron:build`;
}

/**
 * Create manifest.json for upload
 */
export async function createManifest(config: BuildConfig): Promise<string> {
  const { rootDir, electronDir } = config;

  const packageJson = await Bun.file(join(electronDir, 'package.json')).json();
  const version = packageJson.version;

  const uploadDir = join(rootDir, '.build', 'upload');
  mkdirSync(uploadDir, { recursive: true });

  const manifestPath = join(uploadDir, 'manifest.json');
  await Bun.write(manifestPath, JSON.stringify({ version }, null, 2));

  console.log(`Created manifest.json (version: ${version})`);
  return version;
}

/**
 * Upload to S3
 */
export async function uploadToS3(config: BuildConfig): Promise<void> {
  const { rootDir, upload, uploadLatest, uploadScript } = config;

  if (!upload) return;

  // Check for required env vars
  const required = [
    'S3_VERSIONS_BUCKET_ENDPOINT',
    'S3_VERSIONS_BUCKET_ACCESS_KEY_ID',
    'S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing S3 credentials: ${missing.join(', ')}`);
  }

  console.log('\n=== Uploading to S3 ===');

  const flags = ['--electron'];
  if (uploadLatest) flags.push('--latest');
  if (uploadScript) flags.push('--script');

  await $`cd ${rootDir} && bun run scripts/upload.ts ${flags}`;

  console.log('Upload complete ✓');
}

/**
 * Load environment variables from .env file
 */
export async function loadEnvFile(config: BuildConfig): Promise<void> {
  const envPath = join(config.rootDir, '.env');

  if (existsSync(envPath)) {
    const content = await Bun.file(envPath).text();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').replace(/^["']|["']$/g, '');
          process.env[key] = value;
        }
      }
    }
  }
}

/**
 * Get output artifact name for a platform/arch
 */
export function getArtifactName(platform: Platform, arch: Arch): string {
  switch (platform) {
    case 'darwin':
      return `Craft-Agents-${arch}.dmg`;
    case 'win32':
      return `Craft-Agents-${arch}.exe`;
    case 'linux':
      return `Craft-Agents-${arch}.AppImage`;
  }
}

/** Native responsibilities with unchanged entry points and side effects. */
export type { Platform, Arch, BuildConfig } from './common/binary-downloads.ts';
export { BUN_VERSION, UV_VERSION, getPlatformKey, getBunDownloadName, getUvDownloadName, verifySha256, downloadBun, downloadUv } from './common/binary-downloads.ts';
export { copySDK, verifySDKCopy, copyRipgrep, copyInterceptor, copyInterceptorBundle, copySessionServer, copyPiAgentServer } from './common/runtime-assets.ts';
