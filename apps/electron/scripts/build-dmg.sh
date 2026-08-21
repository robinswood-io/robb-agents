#!/usr/bin/env bash
# Build a distributable Robb Agents macOS artifact.
#
# This script is deliberately self-contained and public: it uses only public
# upstream dependencies and optional standard Apple environment variables. It
# never reads a password manager, private updater, or private object store.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

ARCH="arm64"
RELEASE_BUILD=false
BUN_VERSION="bun-v1.3.10"

usage() {
  cat <<'EOF'
Usage: build-dmg.sh [arm64|x64] [--release]

Builds a local Robb Agents DMG and ZIP plus SHA-256 checksums.

Options:
  arm64|x64  Target macOS architecture (default: arm64)
  --release  Require a clean, identifiable Git source plus Developer ID
             signing and Apple notarization, then verify the final application
             with codesign, spctl and stapler.

Release credentials (provided by the operator/CI; never committed):
  CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME
  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
  or APPLE_API_KEY (absolute .p8 path) + APPLE_API_KEY_ID +
     APPLE_API_ISSUER + APPLE_TEAM_ID

Without --release, the artifact is ad-hoc signed only so macOS can launch the
local smoke build. It remains an unsigned-test artifact for trust purposes.
Distribute only a --release artifact to end users.
EOF
}

require_path() {
  local path="$1" description="$2"
  [[ -e "$path" ]] || { echo "ERROR: missing $description: $path" >&2; exit 1; }
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || { echo "ERROR: --release requires $name" >&2; exit 1; }
}

while (($#)); do
  case "$1" in
    arm64|x64) ARCH="$1" ;;
    --release) RELEASE_BUILD=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$RELEASE_BUILD" == true ]]; then
  command -v git >/dev/null || { echo "ERROR: --release requires Git to verify source integrity." >&2; exit 1; }
  command -v node >/dev/null || { echo "ERROR: --release requires Node.js to verify source integrity." >&2; exit 1; }
  # Refuse dirty source before dependency installation or any generated-file
  # cleanup. The Electron main build and electron-builder hook repeat this
  # check so source cannot become dirty between preflight and packaging.
  RELEASE_COMMIT="$(node "$SCRIPT_DIR/releaseIntegrity.cjs" --check-source "$ROOT_DIR")"
  export ROBB_BUILD_CHANNEL=production
  export ROBB_BUILD_COMMIT="$RELEASE_COMMIT"
  export ROBB_BUILD_DIRTY=false
  unset CRAFT_DEV_RUNTIME

  if [[ -z "${CSC_LINK:-}" && -z "${CSC_NAME:-}" ]]; then
    echo "ERROR: --release requires CSC_LINK or CSC_NAME for Developer ID signing." >&2
    exit 1
  fi
  require_env APPLE_TEAM_ID
  if [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" && ( -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ) && ( -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ) ]]; then
    echo "ERROR: --release requires Apple ID, App Store Connect API-key, or keychain notarization credentials." >&2
    exit 1
  fi
else
  # The default contract is a development-channel local smoke artifact.
  export ROBB_BUILD_CHANNEL=development
  # Explicitly disable keychain auto-discovery so duplicate Apple Development identities
  # cannot make a non-release build fail or accidentally sign it.
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME
fi

command -v bun >/dev/null || { echo "ERROR: Bun is required to build Robb Agents." >&2; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl is required to acquire the pinned Bun runtime." >&2; exit 1; }
command -v shasum >/dev/null || { echo "ERROR: shasum is required for checksum verification." >&2; exit 1; }

echo "=== Building Robb Agents macOS ${ARCH} (release=${RELEASE_BUILD}) ==="

# Keep source checkout state intact; clean only generated/staged package files.
rm -rf "$ELECTRON_DIR/vendor" "$ELECTRON_DIR/node_modules/@anthropic-ai" "$ELECTRON_DIR/release"

cd "$ROOT_DIR"
bun install --frozen-lockfile

# Bundle the pinned, checksum-verified RTK token optimizer for this artifact.
bun run scripts/prepare-rtk.ts --platform darwin --arch "$ARCH"

# Bundle a verified, architecture-specific Bun runtime for Pi/Vibe subprocesses.
BUN_DOWNLOAD="bun-darwin-$([[ "$ARCH" == arm64 ]] && echo aarch64 || echo x64)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
curl --fail --location --retry 3 "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl --fail --location --retry 3 "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
(
  cd "$TEMP_DIR"
  grep " ${BUN_DOWNLOAD}.zip$" SHASUMS256.txt | shasum -a 256 -c -
)
unzip -q "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
mkdir -p "$ELECTRON_DIR/vendor/bun"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/bun"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"

# electron-builder runs from apps/electron, so stage the SDK and ripgrep it
# explicitly packages as extra resources.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "Claude Agent SDK core"
require_path "$ROOT_DIR/packages/shared/src/interceptor-request-utils.ts" "network interceptor request utilities"
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
cp -R "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

SDK_BIN_PKG="claude-agent-sdk-darwin-${ARCH}"
SDK_BIN_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/${SDK_BIN_PKG}"
if [[ ! -d "$SDK_BIN_SOURCE" ]]; then
  SDK_VERSION="$(node -p "require('$ROOT_DIR/package.json').dependencies['@anthropic-ai/claude-agent-sdk']" | tr -d '"')"
  mkdir -p "$TEMP_DIR/sdk"
  (
    cd "$TEMP_DIR/sdk"
    npm pack "@anthropic-ai/${SDK_BIN_PKG}@${SDK_VERSION}" >/dev/null
    tar -xzf "$(find . -name 'anthropic-ai-*.tgz' -maxdepth 1 | head -1)"
  )
  SDK_BIN_SOURCE="$TEMP_DIR/sdk/package"
fi
require_path "$SDK_BIN_SOURCE/claude" "Claude Agent SDK native binary"
ALIAS_DEST="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk-binary"
mkdir -p "$ALIAS_DEST"
cp -R "$SDK_BIN_SOURCE/." "$ALIAS_DEST/"
chmod +x "$ALIAS_DEST/claude"

RG_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep"
require_path "$RG_SOURCE/bin/rg" "ripgrep binary"
mkdir -p "$ELECTRON_DIR/node_modules/@vscode"
cp -R "$RG_SOURCE" "$ELECTRON_DIR/node_modules/@vscode/"

# Vite can exceed Node's default old-space limit on macOS runners while
# rendering production chunks for the full desktop UI bundle.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${ROBB_NODE_MAX_OLD_SPACE_SIZE:-8192}"

# The shared Electron build stages Pi/Vibe subprocesses and all bundled assets.
bun run electron:build

cd "$ELECTRON_DIR"
# Publishing is handled only by the verified GitHub Release job, never by
# electron-builder's CI auto-detection.
BUILDER_ARGS=(--config electron-builder.yml --mac --"$ARCH" --publish never)
if [[ "$RELEASE_BUILD" == true ]]; then
  # Repeat the production config's fail-closed setting at the invocation
  # boundary so a future config regression cannot silently disable it.
  BUILDER_ARGS+=(--config.mac.forceCodeSigning=true)
else
  # Preserve explicitly non-release local smoke builds without a certificate.
  # Apple Silicon refuses to launch a mutated Electron bundle without a valid
  # code directory, so use the explicit untrusted ad-hoc identity before DMG
  # and ZIP creation. Public provenance still classifies this as unsigned.
  BUILDER_ARGS+=(--config.mac.forceCodeSigning=false --config.mac.identity=-)
fi
bun x --bun electron-builder "${BUILDER_ARGS[@]}"

PACKAGED_APP_DIR="$ELECTRON_DIR/release/$([[ "$ARCH" == arm64 ]] && echo mac-arm64 || echo mac)/Robb Agents.app"
bun "$ROOT_DIR/scripts/validate-electron-package-security.ts" \
  --binary "$PACKAGED_APP_DIR/Contents/MacOS/Robb Agents" \
  --resources-dir "$PACKAGED_APP_DIR/Contents/Resources"

DMG_PATH="$ELECTRON_DIR/release/Robb-Agents-${ARCH}.dmg"
ZIP_PATH="$ELECTRON_DIR/release/Robb-Agents-${ARCH}.zip"
require_path "$DMG_PATH" "macOS DMG"
require_path "$ZIP_PATH" "macOS ZIP"
CHECKSUM_PATH="$ELECTRON_DIR/release/SHA256SUMS-macos-${ARCH}.txt"
(
  cd "$ELECTRON_DIR/release"
  shasum -a 256 "$(basename "$DMG_PATH")" "$(basename "$ZIP_PATH")" > "$(basename "$CHECKSUM_PATH")"
)

cd "$ROOT_DIR"
if [[ "$RELEASE_BUILD" == true ]]; then
  if [[ "${ROBB_PACKAGE_LAUNCH_SMOKE:-0}" == "1" ]]; then
    python3 scripts/robinswood-packaged-smoke.py --arch "$ARCH" --require-release-signing --launch --launch-seconds 12
  else
    python3 scripts/robinswood-packaged-smoke.py --arch "$ARCH" --require-release-signing
  fi
elif [[ "${ROBB_PACKAGE_LAUNCH_SMOKE:-0}" == "1" ]]; then
  python3 scripts/robinswood-packaged-smoke.py --arch "$ARCH" --launch --launch-seconds 12
else
  python3 scripts/robinswood-packaged-smoke.py --arch "$ARCH"
fi

echo "=== Build complete ==="
echo "DMG: $DMG_PATH"
echo "ZIP: $ZIP_PATH"
echo "Checksums: $CHECKSUM_PATH"
