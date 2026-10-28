#!/usr/bin/env bash
# Native release source preflight; the caller supplies the existing CI environment.
set -euo pipefail
version="$(node -p "require('./apps/electron/package.json').version")"
root_version="$(node -p "require('./package.json').version")"
[[ "$version" == "$root_version" ]] || { echo "::error::Electron version $version must match root version $root_version"; exit 1; }
source_commit="$(git rev-parse HEAD)"
tag="${REQUESTED_TAG:-${GITHUB_REF_NAME}}"
mode="${REQUESTED_MODE:-test-artifacts}"
# A pushed stable tag is always a release-grade publication request.
# macOS remains signed and notarized; Windows follows the explicit
# unsigned, PFX, or Azure signing policy below.
if [[ "${GITHUB_REF_TYPE}" == "tag" ]]; then mode="${REQUESTED_MODE:-publish-signed}"; fi
if [[ "$mode" != "test-artifacts" && "$mode" != "stage-signed" && "$mode" != "publish-signed" ]]; then
  echo "::error::Unknown release mode: $mode"; exit 1
fi

publish=false
if [[ "$mode" == "publish-signed" ]]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::Only stable X.Y.Z versions can be published: $version"; exit 1; }
  [[ "$tag" == "v${version}" ]] || { echo "::error::Tag $tag must match Electron version v${version}"; exit 1; }
  tag_commit="$(git rev-list -n 1 "$tag")"
  checked_out_commit="$(git rev-parse HEAD)"
  [[ -n "$tag_commit" && "$tag_commit" == "$checked_out_commit" ]] || {
    echo "::error::Checked-out source $checked_out_commit does not match immutable tag $tag ($tag_commit)"
    exit 1
  }
  python3 scripts/robinswood-signing-preflight.py --ci --strict

  if [[ "${WINDOWS_SIGNING_MODE}" == "unsigned" ]]; then
    echo "::notice::Windows will be published unsigned with explicit provenance and checksum verification."
  elif [[ "${WINDOWS_SIGNING_MODE}" == "pfx" ]]; then
    [[ -n "${WINDOWS_CSC_LINK:-}" && -n "${WINDOWS_CSC_KEY_PASSWORD:-}" ]] || {
      echo "::error::publish-signed requires WINDOWS_CSC_LINK and WINDOWS_CSC_KEY_PASSWORD when WINDOWS_SIGNING_MODE=pfx"
      exit 1
    }
  elif [[ "${WINDOWS_SIGNING_MODE}" == "azure" ]]; then
    missing=()
    for name in WINDOWS_AZURE_ENDPOINT WINDOWS_AZURE_ACCOUNT_NAME WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME WINDOWS_AZURE_PUBLISHER_NAME AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET; do
      [[ -n "${!name:-}" ]] || missing+=("$name")
    done
    ((${#missing[@]} == 0)) || { printf "::error::publish-signed Azure signing is missing: %s\n" "${missing[*]}"; exit 1; }
  else
    echo "::error::Unsupported WINDOWS_SIGNING_MODE: ${WINDOWS_SIGNING_MODE}; expected unsigned, pfx, or azure"; exit 1
  fi

  if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    echo "::error::GitHub Release $tag already exists; refusing to overwrite it"; exit 1
  fi
  publish=true
elif [[ "$mode" == "stage-signed" ]]; then
  python3 scripts/robinswood-signing-preflight.py --ci --strict
  tag="stage-${source_commit::12}"
  echo "::notice::Signed macOS staging artifacts stay in CI; no GitHub Release is created."
else
  tag="test-${source_commit::12}"
  echo "::notice::Test artifacts will be retained in CI only; no GitHub Release will be created."
fi
echo "publish=$publish" >> "$GITHUB_OUTPUT"
echo "tag=$tag" >> "$GITHUB_OUTPUT"
echo "version=$version" >> "$GITHUB_OUTPUT"
echo "source_commit=$source_commit" >> "$GITHUB_OUTPUT"
echo "release_mode=$mode" >> "$GITHUB_OUTPUT"
