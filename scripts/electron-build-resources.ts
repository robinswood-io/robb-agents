/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join, posix } from "path";
import {
  assertRuntimeIntegrityManifestIncludes,
  createRuntimeIntegrityManifest,
  REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  serializeRuntimeIntegrityManifest,
  type RuntimeIntegritySource,
} from "../packages/shared/src/agent/backend/internal/runtime-integrity.ts";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}

// The main CJS bundle intentionally externalizes the ESM-only Claude SDK.
// With ASAR enabled, Node resolves that import relative to dist/main.cjs, so
// stage the thin JS SDK under dist/node_modules inside app.asar. The native
// Claude executable remains an extraResource on the real filesystem.
const claudeSdkSource = join(ROOT_DIR, "node_modules/@anthropic-ai/claude-agent-sdk");
const claudeSdkDest = join(ELECTRON_DIR, "dist/node_modules/@anthropic-ai/claude-agent-sdk");
if (!existsSync(claudeSdkSource)) {
  throw new Error("Claude Agent SDK core is missing from the workspace install.");
}
mkdirSync(join(ELECTRON_DIR, "dist/node_modules/@anthropic-ai"), { recursive: true });
rmSync(claudeSdkDest, { recursive: true, force: true });
cpSync(claudeSdkSource, claudeSdkDest, { recursive: true, force: true });
console.log("📦 Staged Claude Agent SDK core inside app.asar");

// Pi agent subprocesses are executed outside Electron's main bundle. Build and
// stage them as explicit app resources so packaged apps retain Pi providers
// (including the credential-free Mistral Vibe ACP bridge).
const sessionServer = join(ROOT_DIR, "packages/session-mcp-server/dist/index.js");
const stagedSessionServer = join(destDir, "session-mcp-server/index.js");
if (!existsSync(sessionServer)) {
  throw new Error("Session MCP server output is missing after the Electron main build.");
}
mkdirSync(join(destDir, "session-mcp-server"), { recursive: true });
cpSync(sessionServer, stagedSessionServer, { force: true });
console.log("📦 Staged Session MCP server resource");

const piAgentDir = join(ROOT_DIR, "packages/pi-agent-server");
const piAgentDist = join(piAgentDir, "dist");
const stagedPiAgentDir = join(destDir, "pi-agent-server");
const buildResult = spawnSync("bun", ["run", "build"], {
  cwd: piAgentDir,
  stdio: "inherit",
});
if (buildResult.status !== 0 || !existsSync(piAgentDist)) {
  throw new Error("Failed to build the Pi agent server resources for Electron packaging.");
}
mkdirSync(destDir, { recursive: true });
cpSync(piAgentDist, stagedPiAgentDir, { recursive: true, force: true });
console.log("📦 Built and staged Pi agent server resources (including Antigravity and Vibe bridges)");

function collectRuntimeSources(
  sourceRoot: string,
  destinationRoot: string,
  include: (relativePath: string) => boolean = () => true,
): RuntimeIntegritySource[] {
  if (!existsSync(sourceRoot)) {
    throw new Error(`External runtime source is missing: ${sourceRoot}`);
  }
  const sources: RuntimeIntegritySource[] = [];
  const visit = (directory: string, segments: string[]): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const nextSegments = [...segments, entry.name];
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath, nextSegments);
      } else if (entry.isFile()) {
        const relativePath = nextSegments.join("/");
        if (include(relativePath)) {
          sources.push({
            path: posix.join(destinationRoot, relativePath),
            sourcePath,
          });
        }
      } else {
        throw new Error(`External runtime source contains a non-regular entry: ${sourcePath}`);
      }
    }
  };
  visit(sourceRoot, []);
  return sources;
}

const webuiDist = join(ROOT_DIR, "apps/webui/dist");
const messagingWorker = join(ROOT_DIR, "packages/messaging-whatsapp-worker/dist/worker.cjs");
if (!existsSync(messagingWorker)) {
  throw new Error("WhatsApp worker output is missing after the Electron main build.");
}

const runtimeSources: RuntimeIntegritySource[] = [
  {
    path: "app/dist/interceptor.cjs",
    sourcePath: join(ELECTRON_DIR, "dist/interceptor.cjs"),
  },
  {
    path: "messaging-whatsapp-worker/worker.cjs",
    sourcePath: messagingWorker,
  },
  ...collectRuntimeSources(
    join(destDir, "bridge-mcp-server"),
    "app/resources/bridge-mcp-server",
  ),
  ...collectRuntimeSources(
    join(destDir, "session-mcp-server"),
    "app/resources/session-mcp-server",
  ),
  ...collectRuntimeSources(
    stagedPiAgentDir,
    "app/resources/pi-agent-server",
  ),
  // The WebUI is served from Resources/app rather than ASAR. Source maps are
  // inert debug metadata; every executable and load-bearing asset is sealed.
  ...collectRuntimeSources(
    webuiDist,
    "app/webui",
    (relativePath) => !relativePath.endsWith(".map"),
  ),
  // electron-builder receives a byte-for-byte copy of this JavaScript SDK
  // core from the platform scripts before packaging. Native executables such
  // as ripgrep are deliberately excluded: platform code signing mutates their
  // bytes after this pre-packaging manifest is generated.
  ...collectRuntimeSources(
    claudeSdkSource,
    "app/node_modules/@anthropic-ai/claude-agent-sdk",
  ),
];

const runtimeManifest = createRuntimeIntegrityManifest(runtimeSources);
assertRuntimeIntegrityManifestIncludes(
  runtimeManifest,
  REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
);
const runtimeManifestPath = join(ELECTRON_DIR, "dist/runtime-integrity-manifest.json");
writeFileSync(
  runtimeManifestPath,
  serializeRuntimeIntegrityManifest(runtimeManifest),
  { encoding: "utf8", mode: 0o600 },
);
console.log(`🔐 Sealed ${runtimeManifest.entries.length} external runtime files in the protected ASAR manifest`);
