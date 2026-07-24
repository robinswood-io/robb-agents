#!/usr/bin/env bash
# Install and update Robb Agents from a verified public GitHub Release.
#
# Latest stable:
#   curl -fsSL https://github.com/robinswood-io/robb-agents/releases/latest/download/install-app.sh | bash
#
# Specific stable version:
#   bash install-app.sh --version 1.2.3
set -euo pipefail

REPOSITORY="${ROBB_GITHUB_REPOSITORY:-robinswood-io/robb-agents}"
REQUESTED_VERSION=""
RELEASE_BASE_URL="${ROBB_RELEASE_BASE_URL:-}"
DOWNLOAD_DIR="${ROBB_DOWNLOAD_DIR:-${TMPDIR:-/tmp}/robb-agents-downloads}"
DRY_RUN=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info() { printf "%b\n" "${BLUE}>${NC} $1"; }
success() { printf "%b\n" "${GREEN}>${NC} $1"; }
warn() { printf "%b\n" "${YELLOW}!${NC} $1"; }
error() { printf "%b\n" "${RED}x${NC} $1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install-app.sh [--version X.Y.Z] [--dry-run]

Downloads a stable Robb Agents release from GitHub, verifies the manifest
SHA-512 and artifact size, then installs it for the current platform.

Options:
  --version X.Y.Z  Install a specific stable release instead of latest.
  --dry-run        Resolve and verify release metadata without downloading.

Environment overrides (primarily for mirrors/tests):
  ROBB_RELEASE_BASE_URL, ROBB_DOWNLOAD_DIR, ROBB_INSTALL_DIR, ROBB_APP_DIR
EOF
}

while (($#)); do
  case "$1" in
    --version)
      (($# >= 2)) || error "--version requires X.Y.Z"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown argument: $1"
      ;;
  esac
done

if [[ -n "$REQUESTED_VERSION" && ! "$REQUESTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  error "Only stable X.Y.Z versions can be installed: $REQUESTED_VERSION"
fi

if [[ -z "$RELEASE_BASE_URL" ]]; then
  if [[ -n "$REQUESTED_VERSION" ]]; then
    RELEASE_BASE_URL="https://github.com/${REPOSITORY}/releases/download/v${REQUESTED_VERSION}"
  else
    RELEASE_BASE_URL="https://github.com/${REPOSITORY}/releases/latest/download"
  fi
fi

case "$(uname -s)" in
  Darwin) OS_TYPE="darwin" ;;
  Linux) OS_TYPE="linux" ;;
  *) error "Unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) error "Unsupported architecture: $(uname -m)" ;;
esac

if [[ "$OS_TYPE" == "darwin" ]]; then
  MANIFEST_NAME="latest-mac.yml"
  EXPECTED_ARTIFACT="Robb-Agents-${ARCH}.zip"
else
  [[ "$ARCH" == "x64" ]] || error "Linux releases currently support x64 only (detected: $ARCH)"
  MANIFEST_NAME="latest-linux.yml"
  EXPECTED_ARTIFACT="Robb-Agents-x64.AppImage"
fi

for command in openssl awk; do
  command -v "$command" >/dev/null 2>&1 || error "Required command not found: $command"
done

if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
else
  error "curl or wget is required"
fi

download_file() {
  local url="$1" output="$2" show_progress="${3:-false}"
  if [[ "$DOWNLOADER" == "curl" ]]; then
    if [[ "$show_progress" == true ]]; then
      curl --fail --location --retry 3 --progress-bar --output "$output" "$url"
    else
      curl --fail --location --retry 3 --silent --show-error --output "$output" "$url"
    fi
  else
    if [[ "$show_progress" == true ]]; then
      wget --show-progress --output-document "$output" "$url"
    else
      wget --quiet --output-document "$output" "$url"
    fi
  fi
}

manifest_version() {
  awk '/^version:[[:space:]]*/ { sub(/^version:[[:space:]]*/, ""); print; exit }' "$1"
}

manifest_entry() {
  local manifest="$1" expected="$2"
  awk -v expected="$expected" '
    /^[[:space:]]*-[[:space:]]*url:[[:space:]]*/ {
      url = $0
      sub(/^[[:space:]]*-[[:space:]]*url:[[:space:]]*/, "", url)
      sha = ""
      size = ""
      selected = (url == expected)
      next
    }
    selected && /^[[:space:]]*sha512:[[:space:]]*/ {
      sha = $0
      sub(/^[[:space:]]*sha512:[[:space:]]*/, "", sha)
      next
    }
    selected && /^[[:space:]]*size:[[:space:]]*/ {
      size = $0
      sub(/^[[:space:]]*size:[[:space:]]*/, "", size)
      if (url != "" && sha != "" && size ~ /^[0-9]+$/) {
        print url "\t" sha "\t" size
        exit
      }
    }
  ' "$manifest"
}

mkdir -p "$DOWNLOAD_DIR"
MANIFEST_PATH="$DOWNLOAD_DIR/$MANIFEST_NAME"
info "Fetching ${MANIFEST_NAME} from GitHub Releases..."
download_file "${RELEASE_BASE_URL}/${MANIFEST_NAME}" "$MANIFEST_PATH"

VERSION="$(manifest_version "$MANIFEST_PATH")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || error "Manifest contains an invalid stable version: ${VERSION:-missing}"
if [[ -n "$REQUESTED_VERSION" && "$VERSION" != "$REQUESTED_VERSION" ]]; then
  error "Manifest version $VERSION does not match requested $REQUESTED_VERSION"
fi

ENTRY="$(manifest_entry "$MANIFEST_PATH" "$EXPECTED_ARTIFACT")"
[[ -n "$ENTRY" ]] || error "Artifact $EXPECTED_ARTIFACT is missing from $MANIFEST_NAME"
IFS=$'\t' read -r ARTIFACT_NAME EXPECTED_SHA512 EXPECTED_SIZE <<< "$ENTRY"
[[ "$ARTIFACT_NAME" == "$EXPECTED_ARTIFACT" ]] || error "Unsafe artifact name in manifest: $ARTIFACT_NAME"
[[ "$EXPECTED_SHA512" =~ ^[A-Za-z0-9+/]{86}==$ ]] || error "Invalid SHA-512 in $MANIFEST_NAME"
[[ "$EXPECTED_SIZE" =~ ^[0-9]+$ && "$EXPECTED_SIZE" -gt 0 ]] || error "Invalid artifact size in $MANIFEST_NAME"

info "Resolved Robb Agents ${VERSION} for ${OS_TYPE}-${ARCH}: ${ARTIFACT_NAME}"
if [[ "$DRY_RUN" == true ]]; then
  success "Release metadata is valid (dry run)"
  exit 0
fi

ARTIFACT_PATH="$DOWNLOAD_DIR/$ARTIFACT_NAME"
PARTIAL_PATH="${ARTIFACT_PATH}.part"
rm -f "$PARTIAL_PATH"
info "Downloading ${ARTIFACT_NAME}..."
download_file "${RELEASE_BASE_URL}/${ARTIFACT_NAME}" "$PARTIAL_PATH" true

ACTUAL_SIZE="$(wc -c < "$PARTIAL_PATH" | tr -d '[:space:]')"
if [[ "$ACTUAL_SIZE" != "$EXPECTED_SIZE" ]]; then
  rm -f "$PARTIAL_PATH"
  error "Size verification failed (expected $EXPECTED_SIZE, got $ACTUAL_SIZE)"
fi

ACTUAL_SHA512="$(openssl dgst -sha512 -binary "$PARTIAL_PATH" | openssl base64 -A)"
if [[ "$ACTUAL_SHA512" != "$EXPECTED_SHA512" ]]; then
  rm -f "$PARTIAL_PATH"
  error "SHA-512 verification failed for $ARTIFACT_NAME"
fi
mv -f "$PARTIAL_PATH" "$ARTIFACT_PATH"
success "Artifact size and SHA-512 verified"

if [[ "$OS_TYPE" == "darwin" ]]; then
  for command in unzip codesign spctl ditto osascript; do
    command -v "$command" >/dev/null 2>&1 || error "Required macOS command not found: $command"
  done

  INSTALL_DIR="${ROBB_INSTALL_DIR:-/Applications}"
  APP_NAME="Robb Agents.app"
  APP_BUNDLE_ID="io.robinswood.robbagents"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/robb-agents-install.XXXXXX")"
  cleanup_macos() { rm -rf "$TEMP_DIR"; }
  trap cleanup_macos EXIT

  unzip -q "$ARTIFACT_PATH" -d "$TEMP_DIR"
  APP_SOURCE="$TEMP_DIR/$APP_NAME"
  [[ -d "$APP_SOURCE" ]] || error "Archive does not contain $APP_NAME"
  codesign --verify --deep --strict --verbose=2 "$APP_SOURCE"
  spctl --assess --type execute --verbose=2 "$APP_SOURCE"
  success "Developer ID signature and Gatekeeper assessment verified"

  osascript -e "tell application id \"$APP_BUNDLE_ID\" to quit" 2>/dev/null || true
  for _ in {1..20}; do
    pgrep -x "Robb Agents" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -x "Robb Agents" >/dev/null 2>&1; then
    error "Robb Agents is still running; close it and retry"
  fi

  mkdir -p "$INSTALL_DIR"
  TARGET_APP="$INSTALL_DIR/$APP_NAME"
  BACKUP_APP="$INSTALL_DIR/.Robb Agents.app.backup.$$"
  if [[ -d "$TARGET_APP" ]]; then
    mv "$TARGET_APP" "$BACKUP_APP"
  fi
  if ! ditto "$APP_SOURCE" "$TARGET_APP"; then
    rm -rf "$TARGET_APP"
    [[ -d "$BACKUP_APP" ]] && mv "$BACKUP_APP" "$TARGET_APP"
    error "Installation failed; the previous application was restored"
  fi
  rm -rf "$BACKUP_APP" "$ARTIFACT_PATH"
  success "Robb Agents ${VERSION} installed at $TARGET_APP"
  printf "Launch with: %bopen -a 'Robb Agents'%b\n" "$BOLD" "$NC"
else
  APP_DIR="${ROBB_APP_DIR:-$HOME/.local/share/robb-agents}"
  INSTALL_DIR="${ROBB_INSTALL_DIR:-$HOME/.local/bin}"
  APPIMAGE_PATH="$APP_DIR/Robb-Agents-x64.AppImage"
  WRAPPER_PATH="$INSTALL_DIR/robb-agents"

  mkdir -p "$APP_DIR" "$INSTALL_DIR"
  pkill -TERM -f "$APPIMAGE_PATH" 2>/dev/null || true
  sleep 1

  STAGED_APPIMAGE="$APP_DIR/.Robb-Agents-x64.AppImage.new"
  cp "$ARTIFACT_PATH" "$STAGED_APPIMAGE"
  chmod +x "$STAGED_APPIMAGE"
  mv -f "$STAGED_APPIMAGE" "$APPIMAGE_PATH"
  rm -f "$ARTIFACT_PATH"

  cat > "$WRAPPER_PATH" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -euo pipefail
APPIMAGE_PATH="${ROBB_APPIMAGE_PATH:-$HOME/.local/share/robb-agents/Robb-Agents-x64.AppImage}"
if [[ ! -x "$APPIMAGE_PATH" ]]; then
  echo "Robb Agents is not installed at $APPIMAGE_PATH" >&2
  exit 1
fi
export APPIMAGE="$APPIMAGE_PATH"
exec "$APPIMAGE_PATH" "$@"
WRAPPER_EOF
  chmod +x "$WRAPPER_PATH"

  success "Robb Agents ${VERSION} installed"
  printf "AppImage: %b%s%b\n" "$BOLD" "$APPIMAGE_PATH" "$NC"
  printf "Launcher: %b%s%b\n" "$BOLD" "$WRAPPER_PATH" "$NC"
  [[ ":$PATH:" == *":$INSTALL_DIR:"* ]] || warn "Add $INSTALL_DIR to PATH to run robb-agents"
fi
