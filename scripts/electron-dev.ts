/**
 * Cross-platform electron dev script
 * Replaces platform-specific npm scripts with a unified TypeScript solution
 */

import { spawn, type Subprocess } from "bun";
import "child_process";
import { existsSync, rmSync, statSync, mkdirSync } from "fs";
import "os";
import { join } from "path";
import * as esbuild from "esbuild";
import "./build/common";
import "./build-provenance";

import { ROOT_DIR, DIST_DIR, MAIN_PROCESS_ALIAS, SESSION_SERVER_DIR, PI_AGENT_SERVER_DIR, VITE_BIN, ensureBundledUvForCurrentPlatform, detectInstance, loadEnvFile, configureDevelopmentIdentity, configureDevelopmentBuildProvenance, killProcessOnPort, cleanViteCache, copyResources, getOAuthDefines, ensureMacRobbElectronApp, getElectronEnv } from "./electron-dev-support";









// Build the WhatsApp worker bundle (dist/worker.cjs). Runs the canonical
// `scripts/build-wa-worker.ts` as a subprocess so the dev path stays in
// sync with the packaged/CI build. Cheap (~70ms) so we always rebuild.
async function buildWaWorker(): Promise<void> {
  console.log("📨 Building WhatsApp worker...");
  const proc = spawn({
    cmd: ["bun", "run", "scripts/build-wa-worker.ts"],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("❌ WhatsApp worker build failed");
    process.exit(1);
  }
}

// Build MCP servers for Codex sessions and Pi agent server (one-time, no watch needed)
async function buildMcpServers(): Promise<void> {
  console.log("🌉 Building MCP servers and Pi agent server...");

  // Ensure dist directories exist
  const sessionDistDir = join(SESSION_SERVER_DIR, "dist");
  const piDistDir = join(PI_AGENT_SERVER_DIR, "dist");
  if (!existsSync(sessionDistDir)) mkdirSync(sessionDistDir, { recursive: true });
  if (!existsSync(piDistDir)) mkdirSync(piDistDir, { recursive: true });

  // Build session MCP server (esbuild, packages external — deps resolve from root node_modules)
  const sessionResult = await runEsbuild(
    "packages/session-mcp-server/src/index.ts",
    "packages/session-mcp-server/dist/index.js",
    {},
    { packagesExternal: true }
  );

  if (!sessionResult.success) {
    console.error("❌ Session MCP server build failed:", sessionResult.error);
    process.exit(1);
  }
  console.log("✅ Session MCP server built");

  // Build Pi agent server with bun (not esbuild) because its Pi SDK deps are ESM-only.
  // esbuild with packages:external leaves them as require() calls which fail at runtime.
  // Optional: skip if package directory is missing (e.g., not synced to OSS).
  if (existsSync(join(PI_AGENT_SERVER_DIR, "src"))) {
    const piResult = await buildPiAgentServer();
    if (!piResult.success) {
      console.error("❌ Pi agent server build failed:", piResult.error);
      process.exit(1);
    }
    console.log("✅ Pi agent server built");
  } else {
    console.log("⏭️  Pi agent server skipped (package not found)");
  }
}

// Externals for the main-process bundle.
// - `electron`: the runtime, not bundleable.
// - `@anthropic-ai/claude-agent-sdk`: SDK 0.3.x is pure ESM and calls
//   `createRequire(import.meta.url)` at module-init; esbuild's CJS bundling
//   leaves the synthesized `import_meta.url` undefined and the bundled
//   main.cjs throws ERR_INVALID_ARG_VALUE on load. Externalize so Node loads
//   the SDK natively as ESM. Electron 43 = Node 24.x supports `require()` of
//   TLA-free ESM, so the runtime `require('@anthropic-ai/claude-agent-sdk')`
//   resolves correctly. Mirror of the same flag in `scripts/electron-build-main.ts`
//   and `apps/electron/package.json` build:main.
const MAIN_BUNDLE_EXTERNALS = ["electron", "@anthropic-ai/claude-agent-sdk"];

// Run a one-shot esbuild using the JavaScript API
async function runEsbuild(
  entryPoint: string,
  outfile: string,
  defines: Record<string, string> = {},
  options: { packagesExternal?: boolean; alias?: Record<string, string> } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    await esbuild.build({
      entryPoints: [join(ROOT_DIR, entryPoint)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: join(ROOT_DIR, outfile),
      external: MAIN_BUNDLE_EXTERNALS,
      ...(options.packagesExternal ? { packages: "external" as const } : {}),
      ...(options.alias ? { alias: options.alias } : {}),
      define: defines,
      logLevel: "warning",
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Build Pi agent server using bun instead of esbuild.
// The Pi SDK (@earendil-works/pi-coding-agent) is ESM-only, and esbuild with
// packages:external leaves ESM imports as require() calls that fail at runtime.
// Bun's bundler handles ESM→ESM bundling correctly.
async function buildPiAgentServer(): Promise<{ success: boolean; error?: string }> {
  try {
    const proc = spawn({
      cmd: ["bun", "build", "src/index.ts", "--outdir=dist", "--target=bun", "--format=esm"],
      cwd: PI_AGENT_SERVER_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { success: false, error: stderr };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Verify a built JavaScript bundle is parseable. `node --check` performs
// syntax-only validation — it does NOT execute module-level code or resolve
// `require()`, so Electron-specific top-level requires (e.g. @sentry/electron)
// are safe. This catches truncated writes, FS corruption, and edge cases that
// esbuild's build-success signal doesn't cover.
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  try {
    const proc = spawn({
      cmd: ["node", "--check", filePath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { valid: false, error: stderr.trim() || `node --check exited ${exitCode}` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// Wait for file to stabilize (no size changes)
async function waitForFileStable(filePath: string, timeoutMs = 10000): Promise<boolean> {
  const startTime = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (!existsSync(filePath)) {
      await Bun.sleep(100);
      continue;
    }

    const stats = statSync(filePath);
    if (stats.size === lastSize) {
      stableCount++;
      // File size unchanged for 3 checks (300ms) - consider it stable
      if (stableCount >= 3) {
        return true;
      }
    } else {
      stableCount = 0;
      lastSize = stats.size;
    }

    await Bun.sleep(100);
  }

  return false;
}

async function main(): Promise<void> {
  console.log("🚀 Starting Electron dev environment...\n");

  // Setup
  loadEnvFile();
  detectInstance();
  configureDevelopmentIdentity();
  configureDevelopmentBuildProvenance();
  cleanViteCache();

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  await ensureBundledUvForCurrentPlatform();

  copyResources();

  // Build MCP servers for Codex sessions
  await buildMcpServers();

  // Build WhatsApp worker bundle so the adapter can spawn it on demand
  await buildWaWorker();

  const vitePort = process.env["CRAFT_VITE_PORT"] || "5173";
  const oauthDefines = getOAuthDefines();

  // Kill any existing process on the Vite port
  await killProcessOnPort(vitePort);

  // =========================================================
  // PHASE 1: Initial build (one-shot, wait for completion)
  // =========================================================
  console.log("🔨 Building main process...");

  const mainCjsPath = join(DIST_DIR, "main.cjs");
  const preloadCjsPath = join(DIST_DIR, "bootstrap-preload.cjs");
  const toolbarPreloadCjsPath = join(DIST_DIR, "browser-toolbar-preload.cjs");

  // Remove old build files to ensure fresh build
  if (existsSync(mainCjsPath)) rmSync(mainCjsPath);
  if (existsSync(preloadCjsPath)) rmSync(preloadCjsPath);
  if (existsSync(toolbarPreloadCjsPath)) rmSync(toolbarPreloadCjsPath);

  // Build main and preload entries in parallel
  const [mainResult, preloadResult, toolbarPreloadResult] = await Promise.all([
    runEsbuild(
      "apps/electron/src/main/index.ts",
      "apps/electron/dist/main.cjs",
      oauthDefines,
      { alias: MAIN_PROCESS_ALIAS }
    ),
    runEsbuild(
      "apps/electron/src/preload/bootstrap.ts",
      "apps/electron/dist/bootstrap-preload.cjs"
    ),
    runEsbuild(
      "apps/electron/src/preload/browser-toolbar.ts",
      "apps/electron/dist/browser-toolbar-preload.cjs"
    ),
  ]);

  if (!mainResult.success) {
    console.error("❌ Main process build failed:", mainResult.error);
    process.exit(1);
  }

  if (!preloadResult.success) {
    console.error("❌ Preload build failed:", preloadResult.error);
    process.exit(1);
  }

  if (!toolbarPreloadResult.success) {
    console.error("❌ Browser toolbar preload build failed:", toolbarPreloadResult.error);
    process.exit(1);
  }

  // Wait for files to stabilize (filesystem flush)
  console.log("⏳ Waiting for build files to stabilize...");
  const [mainStable, preloadStable, toolbarPreloadStable] = await Promise.all([
    waitForFileStable(mainCjsPath),
    waitForFileStable(preloadCjsPath),
    waitForFileStable(toolbarPreloadCjsPath),
  ]);

  if (!mainStable || !preloadStable || !toolbarPreloadStable) {
    console.error("❌ Build files did not stabilize");
    process.exit(1);
  }

  // Verify the built files are valid JavaScript
  console.log("🔍 Verifying build output...");
  const [mainValid, preloadValid, toolbarPreloadValid] = await Promise.all([
    verifyJsFile(mainCjsPath),
    verifyJsFile(preloadCjsPath),
    verifyJsFile(toolbarPreloadCjsPath),
  ]);

  if (!mainValid.valid) {
    console.error("❌ main.cjs is invalid:", mainValid.error);
    process.exit(1);
  }

  if (!preloadValid.valid) {
    console.error("❌ bootstrap-preload.cjs is invalid:", preloadValid.error);
    process.exit(1);
  }

  if (!toolbarPreloadValid.valid) {
    console.error("❌ browser-toolbar-preload.cjs is invalid:", toolbarPreloadValid.error);
    process.exit(1);
  }

  console.log("✅ Initial build complete and verified\n");

  // =========================================================
  // PHASE 2: Start dev servers with watch mode
  // =========================================================
  console.log("📡 Starting dev servers...\n");

  const processes: Subprocess[] = [];
  const esbuildContexts: esbuild.BuildContext[] = [];

  // 1. Vite dev server (strictPort ensures we don't silently switch ports)
  const viteProc = spawn({
    cmd: [VITE_BIN, "dev", "--config", "apps/electron/vite.config.ts", "--port", vitePort, "--strictPort"],
    cwd: ROOT_DIR,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });
  processes.push(viteProc);

  // 2. Main process watcher (using esbuild watch API)
  const mainContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, "apps/electron/src/main/index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(ROOT_DIR, "apps/electron/dist/main.cjs"),
    external: MAIN_BUNDLE_EXTERNALS,
    alias: MAIN_PROCESS_ALIAS,
    define: oauthDefines,
    logLevel: "info",
  });
  await mainContext.watch();
  esbuildContexts.push(mainContext);
  console.log("👀 Watching main process...");

  // 3. Preload watcher (using esbuild watch API)
  const preloadContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, "apps/electron/src/preload/bootstrap.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(ROOT_DIR, "apps/electron/dist/bootstrap-preload.cjs"),
    external: ["electron"],
    logLevel: "info",
  });
  await preloadContext.watch();
  esbuildContexts.push(preloadContext);
  console.log("👀 Watching preload...");

  // 4. Browser toolbar preload watcher (dedicated browser window bridge)
  const toolbarPreloadContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, "apps/electron/src/preload/browser-toolbar.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(ROOT_DIR, "apps/electron/dist/browser-toolbar-preload.cjs"),
    external: ["electron"],
    logLevel: "info",
  });
  await toolbarPreloadContext.watch();
  esbuildContexts.push(toolbarPreloadContext);
  console.log("👀 Watching browser toolbar preload...");

  // 5. Start Electron (build already verified)
  console.log("🚀 Starting Electron...\n");

  const electronBinary = ensureMacRobbElectronApp();
  const remoteDebuggingPort = process.env["CRAFT_ELECTRON_REMOTE_DEBUGGING_PORT"];
  const electronArgs = [electronBinary];
  if (remoteDebuggingPort) {
    electronArgs.push(`--remote-debugging-port=${remoteDebuggingPort}`);
  }
  electronArgs.push("apps/electron");
  const electronProc = spawn({
    cmd: electronArgs,
    cwd: ROOT_DIR,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: getElectronEnv(),
  });
  processes.push(electronProc);

  // Handle cleanup on exit
  const cleanup = async () => {
    console.log("\n🛑 Shutting down...");
    // Dispose esbuild contexts
    for (const ctx of esbuildContexts) {
      try {
        await ctx.dispose();
      } catch {
        // Context may already be disposed
      }
    }
    // Kill subprocesses
    for (const proc of processes) {
      try {
        proc.kill();
      } catch {
        // Process may already be dead
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup());
  process.on("SIGTERM", () => cleanup());

  // Windows doesn't have SIGINT/SIGTERM in the same way
  if (process.platform === "win32") {
    process.on("SIGHUP", () => cleanup());
  }

  // Wait for electron to exit (main process)
  await electronProc.exited;
  await cleanup();
}

main().catch((err: unknown) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
