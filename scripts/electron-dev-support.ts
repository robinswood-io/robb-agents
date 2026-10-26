import { spawn } from "bun";
import { execFileSync } from "child_process";
import { existsSync, rmSync, cpSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, basename, resolve } from "path";

import { downloadUv, type Platform, type Arch } from "./build/common";
import { resolveBuildCommit, resolveBuildDirty } from "./build-provenance";


export const ROOT_DIR = join(import.meta.dir, "..");

export const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

export const DIST_DIR = join(ELECTRON_DIR, "dist");


// Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3) with
// native Node globals. esbuild otherwise renames the polyfill's `class
// AbortSignal` to `_AbortSignal` to dodge collision with the global, which
// breaks node-fetch@2's `constructor.name === 'AbortSignal'` check and fails
// every Telegram API call with a TypeError. Kept in sync with
// `apps/electron/package.json` build:main and `scripts/electron-build-main.ts`.
export const MAIN_PROCESS_ALIAS: Record<string, string> = {
  "node-fetch": join(ROOT_DIR, "apps/electron/src/main/shims/node-fetch.cjs"),
  "abort-controller": join(ROOT_DIR, "apps/electron/src/main/shims/abort-controller.cjs"),
};


// MCP server paths
export const SESSION_SERVER_DIR = join(ROOT_DIR, "packages/session-mcp-server");

export const SESSION_SERVER_OUTPUT = join(SESSION_SERVER_DIR, "dist/index.js");

// Pi agent server path (subprocess for Pi SDK sessions)
export const PI_AGENT_SERVER_DIR = join(ROOT_DIR, "packages/pi-agent-server");

export const PI_AGENT_SERVER_OUTPUT = join(PI_AGENT_SERVER_DIR, "dist/index.js");


// Platform-specific binary paths (bun creates .exe on Windows, no extension on Unix)
export const IS_WINDOWS = process.platform === "win32";

export const BIN_EXT = IS_WINDOWS ? ".exe" : "";

export const VITE_BIN = join(ROOT_DIR, `node_modules/.bin/vite${BIN_EXT}`);

export const ELECTRON_BIN = join(ROOT_DIR, `node_modules/.bin/electron${BIN_EXT}`);

export const ELECTRON_MAC_APP = join(ROOT_DIR, "node_modules/electron/dist/Electron.app");

// Keep the runnable development bundle outside `apps/electron/`: electron-
// builder's Bun collector can otherwise include it in a production payload.
export const ROBB_MAC_APP = join(ROOT_DIR, ".robb-dev-runtime", "Robb Agents Dev.app");

export const PRODUCTION_CONFIG_DIR = join(homedir(), ".craft-agent");

export const DEVELOPMENT_CONFIG_DIR = join(homedir(), ".craft-agent-dev");


export function resolveBuildPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported platform for uv bootstrap: ${process.platform}`);
}


export function resolveBuildArch(): Arch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported architecture for uv bootstrap: ${process.arch}`);
}


export async function ensureBundledUvForCurrentPlatform(): Promise<void> {
  const platform = resolveBuildPlatform();
  const arch = resolveBuildArch();
  const platformKey = `${platform}-${arch}`;
  const uvBinary = platform === "win32" ? "uv.exe" : "uv";
  const uvPath = join(ELECTRON_DIR, "resources", "bin", platformKey, uvBinary);

  if (existsSync(uvPath)) {
    console.log(`✅ Bundled uv present: ${uvPath}`);
    return;
  }

  console.log(`⬇️  Bundled uv missing, bootstrapping ${platformKey}...`);
  await downloadUv({
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  });
}


// Multi-instance detection (matches detect-instance.sh logic)
// Detects instance number from folder name suffix (e.g., robinswood-agents-1 → instance 1)
export function detectInstance(): void {
  // Don't override if already set (e.g., by sourcing detect-instance.sh first)
  if (process.env.CRAFT_VITE_PORT) return;

  const folderName = basename(ROOT_DIR);
  const match = folderName.match(/-(\d+)$/);

  if (match) {
    const instanceNum = match[1];
    process.env.CRAFT_INSTANCE_NUMBER = instanceNum;
    process.env.CRAFT_VITE_PORT = `${instanceNum}173`;
    console.log(`🔢 Development instance ${instanceNum} detected: port=${process.env.CRAFT_VITE_PORT}`);
  }
}


// Load .env file if it exists
export function loadEnvFile(): void {
  const envPath = join(ROOT_DIR, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          // Remove surrounding quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = value;
          }
        }
      }
    }
    console.log("📄 Loaded .env file");
  }
}


export function configureDevelopmentIdentity(): void {
  const instance = process.env.CRAFT_INSTANCE_NUMBER;
  const suffix = instance ? ` [${instance}]` : "";
  const profileSuffix = instance && instance !== "e2e" ? `-${instance}` : "";
  const schemeSuffix = instance && instance !== "e2e" ? instance : "";

  process.env.ROBB_BUILD_CHANNEL = "development";
  process.env.CRAFT_APP_NAME ||= `Robb Agents Dev${suffix}`;
  process.env.CRAFT_CONFIG_DIR ||= `${DEVELOPMENT_CONFIG_DIR}${profileSuffix}`;
  process.env.CRAFT_DEEPLINK_SCHEME ||= `robbagentsdev${schemeSuffix}`;

  if (resolve(process.env.CRAFT_CONFIG_DIR) === resolve(PRODUCTION_CONFIG_DIR)) {
    throw new Error(
      `Development profile isolation refused: CRAFT_CONFIG_DIR cannot target production (${PRODUCTION_CONFIG_DIR})`,
    );
  }
  if (process.env.CRAFT_APP_NAME === "Robb Agents") {
    throw new Error("Development identity isolation refused: CRAFT_APP_NAME cannot be Robb Agents");
  }
  if (process.env.CRAFT_DEEPLINK_SCHEME === "craftagents") {
    throw new Error("Development deep-link isolation refused: CRAFT_DEEPLINK_SCHEME cannot be craftagents");
  }

  console.log(
    `🧪 Development identity: app="${process.env.CRAFT_APP_NAME}", config=${process.env.CRAFT_CONFIG_DIR}, scheme=${process.env.CRAFT_DEEPLINK_SCHEME}`,
  );
}


export function configureDevelopmentBuildProvenance(): void {
  let gitCommit: string | undefined;
  let gitPorcelain: string | undefined;
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    });
    gitPorcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    });
  } catch {
    // Source archives may not include git metadata.
  }

  const buildCommit = resolveBuildCommit(
    process.env.ROBB_BUILD_COMMIT,
    gitCommit,
    process.env.GITHUB_SHA,
  );
  const buildDirty = resolveBuildDirty(process.env.ROBB_BUILD_DIRTY, gitPorcelain);
  if (buildCommit) process.env.ROBB_BUILD_COMMIT = buildCommit;
  if (buildDirty !== undefined) process.env.ROBB_BUILD_DIRTY = String(buildDirty);
}


// Kill any process using the specified port
export async function killProcessOnPort(port: string): Promise<void> {
  const isWindows = process.platform === "win32";

  try {
    if (isWindows) {
      // Windows: use netstat to find PID, then taskkill
      const netstat = spawn({
        cmd: ["cmd", "/c", `netstat -ano | findstr :${port}`],
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(netstat.stdout).text();
      await netstat.exited;

      // Parse PIDs from netstat output (last column)
      const pids = new Set<string>();
      for (const line of output.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== "0") {
            pids.add(pid);
          }
        }
      }

      // Kill each PID
      for (const pid of pids) {
        const kill = spawn({
          cmd: ["taskkill", "/PID", pid, "/F"],
          stdout: "pipe",
          stderr: "pipe",
        });
        await kill.exited;
      }

      if (pids.size > 0) {
        console.log(`🔪 Killed ${pids.size} process(es) on port ${port}`);
      }
    } else {
      // Mac/Linux: use lsof and kill
      const lsof = spawn({
        cmd: ["sh", "-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`],
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(lsof.stdout).text();
      await lsof.exited;

      if (output.trim()) {
        console.log(`🔪 Killed process(es) on port ${port}`);
      }
    }
  } catch {
    // Ignore errors - port may not be in use
  }
}


// Clean Vite cache directory
export function cleanViteCache(): void {
  const viteCacheDir = join(ELECTRON_DIR, "node_modules/.vite");
  if (existsSync(viteCacheDir)) {
    rmSync(viteCacheDir, { recursive: true, force: true });
    console.log("🧹 Cleaned Vite cache");
  }
}


// Copy resources to dist
export function copyResources(): void {
  const srcDir = join(ELECTRON_DIR, "resources");
  const destDir = join(ELECTRON_DIR, "dist/resources");
  if (existsSync(srcDir)) {
    cpSync(srcDir, destDir, { recursive: true, force: true });
    console.log("📦 Copied resources to dist");
  }
}


// Get OAuth defines for esbuild API
export function getOAuthDefines(): Record<string, string> {
  const oauthVars = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "SLACK_OAUTH_CLIENT_ID",
    "SLACK_OAUTH_CLIENT_SECRET",
    "MICROSOFT_OAUTH_CLIENT_ID",
    "MICROSOFT_OAUTH_CLIENT_SECRET",
  ];

  const defines: Record<string, string> = {};
  for (const varName of oauthVars) {
    const value = process.env[varName] || "";
    defines[`process.env.${varName}`] = JSON.stringify(value);
  }
  defines["process.env.ROBB_BUILD_CHANNEL"] = JSON.stringify("development");
  defines["process.env.ROBB_BUILD_COMMIT"] = JSON.stringify(process.env.ROBB_BUILD_COMMIT || "");
  defines["process.env.ROBB_BUILD_DIRTY"] = JSON.stringify(process.env.ROBB_BUILD_DIRTY || "");
  return defines;
}


export function ensureMacRobbElectronApp(): string {
  if (process.platform !== "darwin") return ELECTRON_BIN;

  const sourceStat = statSync(ELECTRON_MAC_APP);
  const needsCopy = !existsSync(ROBB_MAC_APP) || statSync(ROBB_MAC_APP).mtimeMs < sourceStat.mtimeMs;

  if (needsCopy) {
    rmSync(ROBB_MAC_APP, { recursive: true, force: true });
    cpSync(ELECTRON_MAC_APP, ROBB_MAC_APP, { recursive: true });

    const infoPlistPath = join(ROBB_MAC_APP, "Contents/Info.plist");
    const iconSource = join(ELECTRON_DIR, "resources/robinswood-icon.icns");
    const iconTarget = join(ROBB_MAC_APP, "Contents/Resources/robb-agents.icns");
    if (existsSync(iconSource)) {
      cpSync(iconSource, iconTarget, { force: true });
    }

    let plist = readFileSync(infoPlistPath, "utf-8");
    plist = plist
      .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, "<key>CFBundleDisplayName</key>\n\t<string>Robb Agents Dev</string>")
      .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, "<key>CFBundleName</key>\n\t<string>Robb Agents Dev</string>")
      .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, "<key>CFBundleIdentifier</key>\n\t<string>io.robinswood.robbagents.dev</string>")
      .replace(/<key>CFBundleIconFile<\/key>\s*<string>[^<]*<\/string>/, "<key>CFBundleIconFile</key>\n\t<string>robb-agents.icns</string>");
    writeFileSync(infoPlistPath, plist, "utf-8");

    console.log(`🍎 Prepared macOS Robb Agents Dev bundle: ${ROBB_MAC_APP}`);
  }

  return join(ROBB_MAC_APP, "Contents/MacOS/Electron");
}


// Get environment variables for electron process
export function getElectronEnv(): Record<string, string> {
  const vitePort = process.env.CRAFT_VITE_PORT || "5173";

  // Codex binary path is resolved at runtime by the binary-resolver module.
  // It checks: CODEX_PATH env var > bundled binary > local dev fork > system PATH.
  // You can override with CODEX_PATH env var if needed for debugging.

  return {
    ...process.env as Record<string, string>,
    VITE_DEV_SERVER_URL: `http://localhost:${vitePort}`,
    ROBB_BUILD_CHANNEL: "development",
    CRAFT_CONFIG_DIR: process.env.CRAFT_CONFIG_DIR || DEVELOPMENT_CONFIG_DIR,
    CRAFT_APP_NAME: process.env.CRAFT_APP_NAME || "Robb Agents Dev",
    CRAFT_DEEPLINK_SCHEME: process.env.CRAFT_DEEPLINK_SCHEME || "robbagentsdev",
    CRAFT_INSTANCE_NUMBER: process.env.CRAFT_INSTANCE_NUMBER || "",
  };
}
