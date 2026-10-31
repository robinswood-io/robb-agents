#!/usr/bin/env bun
import { parseJsonObject } from '../packages/shared/src/utils/json.ts';
/**
 * Build script for standalone Craft Agent server.
 *
 * Assembles a self-contained distribution directory with all runtime
 * dependencies, resources, and platform-specific binaries.
 *
 * Usage:
 *   bun run scripts/build-server.ts
 *   bun run scripts/build-server.ts --platform=linux --arch=x64
 *   bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
 *
 * Options:
 *   --platform       Target platform: darwin, linux (default: current)
 *   --arch           Target architecture: x64, arm64 (default: current)
 *   --output         Output directory (default: dist/server)
 *   --compress       Create .tar.gz archive after assembly
 *   --skip-download  Skip Bun/uv downloads (use existing if present)
 *   --help           Show help
 */

import { parseArgs } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, rmSync, lstatSync, readdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync } from 'fs';
import { $ } from 'bun';
import { type Arch, type BuildConfig, BUN_VERSION, UV_VERSION, buildMcpServers } from './build/common';

import { type ServerPlatform, type ServerBuildConfig, assembleResources, downloadUvForServer, stageRtkForServer, downloadBunForServer, copyProductionDeps, getDirSize, copyWorkspacePackages } from "./server-build-resources";
process.on('uncaughtException', (error) => {
  console.error('\n  Build failed (uncaught):', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n  Build failed (unhandled):', reason);
  process.exit(1);
});








// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Standalone server build script for Craft Agent

Usage:
  bun run scripts/build-server.ts [options]

Options:
  --platform=<platform>  Target platform: darwin, linux
                         (default: ${process.platform})
  --arch=<arch>          Target architecture: x64, arm64
                         (default: ${process.arch === 'arm64' ? 'arm64' : 'x64'})
  --output=<path>        Output directory (default: dist/server)
  --compress             Create .tar.gz after assembly
  --skip-download        Reuse existing Bun/uv binaries
  --help                 Show this help message

Examples:
  # Build for current platform
  bun run scripts/build-server.ts

  # Build Linux x64 tarball
  bun run scripts/build-server.ts --platform=linux --arch=x64 --compress

  # Build Linux ARM64 tarball
  bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
`);
}

// ---------------------------------------------------------------------------
// Root config files for workspace resolution
// ---------------------------------------------------------------------------

function createRootConfig(config: ServerBuildConfig): void {
  const { outputDir, version } = config;

  // Root package.json with workspaces (Bun resolves @craft-agent/* through this)
  const rootPkg = {
    name: 'craft-server-dist',
    version,
    private: true,
    workspaces: ['packages/*'],
  };
  writeFileSync(join(outputDir, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');

  // Root tsconfig.json for path resolution
  const rootTsconfig = {
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      paths: {
        '@craft-agent/server-core/*': ['./packages/server-core/src/*'],
        '@craft-agent/shared/*': ['./packages/shared/src/*'],
        '@craft-agent/core/*': ['./packages/core/src/*'],
        '@craft-agent/session-tools-core/*': ['./packages/session-tools-core/src/*'],
      },
    },
  };
  writeFileSync(join(outputDir, 'tsconfig.json'), JSON.stringify(rootTsconfig, null, 2) + '\n');

  // Create workspace symlinks in node_modules/@craft-agent/
  // Bun needs these to resolve workspace package imports at runtime
  const scopeDir = join(outputDir, 'node_modules', '@craft-agent');
  mkdirSync(scopeDir, { recursive: true });

  const packagesDir = join(outputDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      const pkgJsonPath = join(packagesDir, pkg, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      try {
        const pkgJson = parseJsonObject(readFileSync(pkgJsonPath, 'utf-8'));
        const name = typeof pkgJson['name'] === 'string' ? pkgJson['name'] : '';
        if (name.startsWith('@craft-agent/')) {
          const shortName = name.replace('@craft-agent/', '');
          const linkPath = join(scopeDir, shortName);
          const target = join('..', '..', 'packages', pkg);
          if (!existsSync(linkPath)) {
            symlinkSync(target, linkPath, 'dir');
            console.log(`  Symlink: ${name} -> packages/${pkg}`);
          }
        }
      } catch {
        // Skip if package.json is malformed
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry scripts
// ---------------------------------------------------------------------------

function createEntryScripts(config: ServerBuildConfig): void {
  const { outputDir } = config;
  const binDir = join(outputDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // bin/craft-server — main entry wrapper
  const craftServer = `#!/bin/sh
set -e

# Resolve the distribution root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

# Set environment for resource resolution
export CRAFT_BUNDLED_ASSETS_ROOT="$ROOT"
export CRAFT_IS_PACKAGED=true
export CRAFT_APP_ROOT="$ROOT"
export CRAFT_RESOURCES_PATH="$ROOT/resources"

# CLI tools (doc tools use uv + Python scripts)
export CRAFT_UV="$ROOT/resources/bin/uv"
export CRAFT_SCRIPTS="$ROOT/resources/scripts"

# Prepend resource bin to PATH (makes doc tool wrappers available)
export PATH="$ROOT/resources/bin:$ROOT/vendor/bun:$PATH"

# Use bundled Bun runtime
exec "$ROOT/vendor/bun/bun" run "$ROOT/packages/server/src/index.ts" "$@"
`;
  writeFileSync(join(binDir, 'craft-server'), craftServer);

  // start.sh — convenience entry
  const startSh = `#!/bin/sh
# Craft Agent Server — convenience entry point
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/bin/craft-server" "$@"
`;
  writeFileSync(join(outputDir, 'start.sh'), startSh);

  // install.sh — setup + optional systemd
  const installSh = `#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Craft Agent Server Setup ==="
echo ""

# Make binaries executable
chmod +x "$DIR/bin/craft-server" "$DIR/start.sh"
[ -f "$DIR/vendor/bun/bun" ] && chmod +x "$DIR/vendor/bun/bun"
[ -f "$DIR/resources/bin/uv" ] && chmod +x "$DIR/resources/bin/uv"

# Make doc tool wrappers executable
for wrapper in "$DIR/resources/bin/"*; do
  [ -f "$wrapper" ] && chmod +x "$wrapper"
done

echo "Binaries configured."

# Generate token if not set
if [ -z "\${CRAFT_SERVER_TOKEN:-}" ]; then
  TOKEN=\$(openssl rand -hex 32)
  cat > "$DIR/.env" <<ENVFILE
CRAFT_SERVER_TOKEN=$TOKEN

# TLS — uncomment and set paths to enable wss://
# CRAFT_RPC_TLS_CERT=/path/to/cert.pem
# CRAFT_RPC_TLS_KEY=/path/to/key.pem
# CRAFT_RPC_TLS_CA=/path/to/ca.pem
ENVFILE
  echo ""
  echo "Generated server token (saved to $DIR/.env)"
else
  TOKEN="\$CRAFT_SERVER_TOKEN"
  echo ""
  echo "Using CRAFT_SERVER_TOKEN from environment."
fi

# Systemd installation
if [ "\${1:-}" = "--systemd" ]; then
  if [ "\$(id -u)" -ne 0 ]; then
    echo "Error: --systemd requires root. Run with sudo."
    exit 1
  fi

  SERVICE_USER="\${CRAFT_USER:-\$(logname 2>/dev/null || echo craft)}"
  SERVICE_FILE="/etc/systemd/system/craft-server.service"

  cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Craft Agent Server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
Environment=CRAFT_RPC_HOST=127.0.0.1
Environment=CRAFT_RPC_PORT=9100
ExecStart=$DIR/bin/craft-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable craft-server

  echo ""
  echo "Systemd service installed."
  echo "  Start:   sudo systemctl start craft-server"
  echo "  Status:  sudo systemctl status craft-server"
  echo "  Logs:    journalctl -u craft-server -f"
  echo ""
  exit 0
fi

echo ""
echo "Quick start:"
echo "  CRAFT_SERVER_TOKEN=$TOKEN $DIR/start.sh"
echo ""
echo "Or with systemd:"
echo "  sudo $DIR/install.sh --systemd"
echo ""
`;
  writeFileSync(join(outputDir, 'install.sh'), installSh);

  // Make scripts executable at build time
  for (const script of [
    join(binDir, 'craft-server'),
    join(outputDir, 'start.sh'),
    join(outputDir, 'install.sh'),
  ]) {
    chmodSync(script, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

function createDockerFiles(config: ServerBuildConfig): void {
  const { outputDir } = config;

  const dockerfile = `FROM oven/bun:1.3-slim

WORKDIR /app

# Copy pre-assembled server distribution
COPY . .

# Make binaries executable
RUN chmod +x bin/craft-server vendor/bun/bun resources/bin/uv && \\
    for f in resources/bin/*; do [ -f "$f" ] && chmod +x "$f"; done

ENV CRAFT_IS_PACKAGED=true
ENV CRAFT_BUNDLED_ASSETS_ROOT=/app
ENV CRAFT_APP_ROOT=/app
ENV CRAFT_RESOURCES_PATH=/app/resources
ENV CRAFT_UV=/app/resources/bin/uv
ENV CRAFT_SCRIPTS=/app/resources/scripts
ENV CRAFT_RPC_HOST=0.0.0.0
ENV CRAFT_RPC_PORT=9100
ENV PATH="/app/resources/bin:/app/vendor/bun:\${PATH}"

EXPOSE 9100

ENTRYPOINT ["/app/bin/craft-server"]
`;
  writeFileSync(join(outputDir, 'Dockerfile'), dockerfile);

  const dockerCompose = `version: "3.8"
services:
  craft-server:
    build: .
    ports:
      - "9100:9100"
    environment:
      - CRAFT_SERVER_TOKEN=\${CRAFT_SERVER_TOKEN:?Set CRAFT_SERVER_TOKEN}
      - CRAFT_RPC_PORT=9100
      # TLS — uncomment to enable wss://
      # - CRAFT_RPC_TLS_CERT=/certs/cert.pem
      # - CRAFT_RPC_TLS_KEY=/certs/key.pem
    volumes:
      - craft-data:/root/.craft-agent
      # TLS — mount cert directory
      # - ./certs:/certs:ro
    restart: unless-stopped

volumes:
  craft-data:
`;
  writeFileSync(join(outputDir, 'docker-compose.yml'), dockerCompose);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch === 'arm64' ? 'arm64' : 'x64' },
      output: { type: 'string', default: 'dist/server' },
      compress: { type: 'boolean', default: false },
      'skip-download': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  const platform = values.platform as ServerPlatform;
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`Unsupported platform: ${platform}. Use darwin or linux.`);
    process.exit(1);
  }

  const arch = values.arch as Arch;
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error(`Unsupported arch: ${arch}. Use x64 or arm64.`);
    process.exit(1);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptDir);
  const electronDir = join(rootDir, 'apps', 'electron');

  if (!existsSync(join(rootDir, 'package.json'))) {
    console.error('Must run from the repository root');
    process.exit(1);
  }

  // Read version from electron package.json
  const electronPkg = parseJsonObject(readFileSync(join(electronDir, 'package.json'), 'utf-8'));
  const version = electronPkg['version'];
  if (typeof version !== 'string' || !version) throw new Error('Electron package version is missing');

  const outputDir = join(rootDir, values.output!);

  const config: ServerBuildConfig = {
    platform,
    arch,
    rootDir,
    electronDir,
    outputDir,
    compress: values.compress ?? false,
    skipDownload: values['skip-download'] ?? false,
    version,
  };

  console.log(`=== Building Craft Agent Server ${version} for ${platform}-${arch} ===`);
  console.log(`  Output: ${outputDir}`);

  // Step 1: Clean
  console.log('\n[1/8] Cleaning output directory...');
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // Step 2: Download Bun runtime
  console.log(`\n[2/8] Downloading Bun ${BUN_VERSION}...`);
  await downloadBunForServer(config);

  // Step 3: Download uv
  console.log(`\n[3/8] Downloading uv ${UV_VERSION}...`);
  await downloadUvForServer(config);
  await stageRtkForServer(config);

  // Step 4: Build MCP servers
  console.log('\n[4/8] Building MCP servers...');
  const buildConfig: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir,
  };
  buildMcpServers(buildConfig);

  // Build the WhatsApp worker bundle. Must happen before copyWorkspacePackages
  // so dist/worker.cjs exists when we copy the messaging-whatsapp-worker package.
  // The bundle embeds Baileys + transitive deps; see scripts/build-wa-worker.ts.
  console.log('  Building WhatsApp worker bundle...');
  await $`bun run ${join(rootDir, 'scripts', 'build-wa-worker.ts')}`.cwd(rootDir);

  // Step 5: Assemble resources
  console.log('\n[5/8] Assembling resources...');
  assembleResources(config);

  // Step 6: Copy production node_modules
  console.log('\n[6/8] Copying production dependencies...');
  copyProductionDeps(config);

  // Step 7: Copy workspace packages
  console.log('\n[7/8] Copying workspace packages...');
  copyWorkspacePackages(config);
  createRootConfig(config);

  // Step 8: Create entry scripts + Docker files
  console.log('\n[8/8] Creating entry scripts...');
  createEntryScripts(config);
  createDockerFiles(config);

  // Calculate total size
  const totalSize = getDirSize(outputDir);
  console.log(`\n  Assembly complete: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);

  // Compress if requested
  if (config.compress) {
    const archiveName = `craft-server-${version}-${platform}-${arch}.tar.gz`;
    const archivePath = join(dirname(outputDir), archiveName);
    console.log(`\nCompressing to ${archiveName}...`);
    await $`tar -czf ${archivePath} -C ${outputDir} .`;
    const archiveSize = lstatSync(archivePath).size;
    console.log(`  Archive: ${(archiveSize / 1024 / 1024).toFixed(0)} MB`);
    console.log(`  Path: ${archivePath}`);
  }

  console.log('\n  Build completed successfully!');
  console.log(`\nQuick start:`);
  console.log(`  CRAFT_SERVER_TOKEN=<secret> ${outputDir}/start.sh`);
}

main();
