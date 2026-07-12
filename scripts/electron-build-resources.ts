/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

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

// Pi agent subprocesses are executed outside Electron's main bundle. Build and
// stage them as explicit app resources so packaged apps retain Pi providers
// (including the credential-free Mistral Vibe ACP bridge).
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
console.log("📦 Built and staged Pi agent server resources (including Vibe ACP bridge)");
