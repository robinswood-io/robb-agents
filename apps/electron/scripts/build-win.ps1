# Build a distributable Robb Agents Windows NSIS installer.
#
# Public/reproducible packaging script: no password manager, private updater,
# private storage, Defender manipulation, or unrelated process termination.
[CmdletBinding()]
param(
    [ValidateSet("x64")]
    [string]$Arch = "x64",
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)
$BunVersion = "bun-v1.3.10"

function Require-Path([string]$Path, [string]$Description) {
    if (-not (Test-Path $Path)) { throw "Missing ${Description}: $Path" }
}

function Require-Environment([string]$Name) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
        throw "-Release requires $Name"
    }
}

function Require-ValidAuthenticodeSignature([string]$Path, [string]$Description) {
    Require-Path $Path $Description
    $Signature = Get-AuthenticodeSignature $Path
    if ($Signature.Status -ne 'Valid') {
        throw "Release $Description Authenticode verification failed: $($Signature.Status) $($Signature.StatusMessage)"
    }
    Write-Host "Verified Authenticode signature for ${Description}: $($Signature.SignerCertificate.Subject)" -ForegroundColor Green
}

foreach ($command in @("bun", "node", "python")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command not found on PATH: $command"
    }
}

if ($Release) {
    # Verify the exact clean source before any generated-path cleanup, then
    # force production provenance for both the build and beforePack hook.
    $ReleaseCommitOutput = & node "$ScriptDir\releaseIntegrity.cjs" --check-source "$RootDir"
    if ($LASTEXITCODE -ne 0) { throw "Release source integrity validation failed" }
    $ReleaseCommit = ($ReleaseCommitOutput | Select-Object -Last 1).Trim()
    if ($ReleaseCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw "Release source integrity returned an invalid commit: $ReleaseCommit"
    }
    $env:ROBB_BUILD_CHANNEL = "production"
    $env:ROBB_BUILD_COMMIT = $ReleaseCommit
    $env:ROBB_BUILD_DIRTY = "false"
    Remove-Item Env:CRAFT_DEV_RUNTIME -ErrorAction SilentlyContinue

    $SigningMode = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_MODE)) { "pfx" } else { $env:WINDOWS_SIGNING_MODE.ToLowerInvariant() }
    if ($SigningMode -notin @("pfx", "azure")) {
        throw "Unsupported WINDOWS_SIGNING_MODE '$SigningMode'. Expected 'pfx' or 'azure'."
    }
    if ($SigningMode -eq "pfx") {
        if ([string]::IsNullOrWhiteSpace($env:CSC_LINK) -and [string]::IsNullOrWhiteSpace($env:CSC_NAME)) {
            throw "PFX release signing requires CSC_LINK or CSC_NAME."
        }
        if (-not [string]::IsNullOrWhiteSpace($env:CSC_LINK)) {
            Require-Environment "CSC_KEY_PASSWORD"
        }
    } else {
        foreach ($name in @(
            "WINDOWS_AZURE_ENDPOINT",
            "WINDOWS_AZURE_ACCOUNT_NAME",
            "WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME",
            "WINDOWS_AZURE_PUBLISHER_NAME",
            "AZURE_TENANT_ID",
            "AZURE_CLIENT_ID",
            "AZURE_CLIENT_SECRET"
        )) {
            Require-Environment $name
        }
    }
} else {
    # The default wrapper remains an explicit local/CI development artifact.
    $env:ROBB_BUILD_CHANNEL = "development"
    $SigningMode = "unsigned"
}

Write-Host "=== Building Robb Agents Windows Installer ($Arch, release=$Release) ===" -ForegroundColor Cyan

# Bun 1.3.10 can leave a partially materialized patched-package directory in
# its shared Windows cache. A later install then fails before compilation with
# ENOTEMPTY/ENOENT while applying patches/minimatch@3.1.5.patch. Keep the
# immutable lockfile contract, but isolate the package cache per build. CI may
# provide a stable per-job path; local builds get a disposable unique path.
$ConfiguredInstallCache = [Environment]::GetEnvironmentVariable("ROBB_BUN_INSTALL_CACHE_DIR")
$OwnInstallCache = [string]::IsNullOrWhiteSpace($ConfiguredInstallCache)
$InstallCacheDir = if ($OwnInstallCache) {
    Join-Path ([System.IO.Path]::GetTempPath()) "robb-agents-bun-install-cache-$([guid]::NewGuid())"
} else {
    $ConfiguredInstallCache
}
New-Item -ItemType Directory -Force -Path $InstallCacheDir | Out-Null

# Clean exclusively generated/staged paths. Do not terminate unrelated tools.
foreach ($path in @(
    "$ElectronDir\vendor",
    "$ElectronDir\node_modules\@anthropic-ai",
    "$ElectronDir\release"
)) {
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}

Push-Location $RootDir
try {
    bun install --frozen-lockfile --cache-dir $InstallCacheDir
    if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
    bun scripts/prepare-rtk.ts --platform win32 --arch $Arch
    if ($LASTEXITCODE -ne 0) { throw "RTK preparation failed" }
} finally {
    Pop-Location
    if ($OwnInstallCache) {
        Remove-Item -Recurse -Force $InstallCacheDir -ErrorAction SilentlyContinue
    }
}

# Bundle a checksum-verified baseline Bun runtime for every x64 CPU.
$BunDownload = "bun-windows-x64-baseline"
$TempDir = Join-Path $env:TEMP "robb-agents-bun-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
try {
    $ZipPath = Join-Path $TempDir "$BunDownload.zip"
    Invoke-WebRequest -Uri "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip" -OutFile $ZipPath
    Invoke-WebRequest -Uri "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt" -OutFile (Join-Path $TempDir "SHASUMS256.txt")
    $ExpectedHash = ((Get-Content (Join-Path $TempDir "SHASUMS256.txt") | Select-String "$BunDownload.zip$").ToString() -split '\s+')[0].ToLower()
    $ActualHash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($ActualHash -ne $ExpectedHash) { throw "Bun checksum verification failed" }
    Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force
    $BunDest = "$ElectronDir\vendor\bun"
    New-Item -ItemType Directory -Force -Path $BunDest | Out-Null
    Copy-Item "$TempDir\$BunDownload\bun.exe" "$BunDest\bun.exe" -Force
    Unblock-File "$BunDest\bun.exe" -ErrorAction SilentlyContinue
} finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

# Stage runtime dependencies which electron-builder copies as extraResources.
$SdkSource = "$RootDir\node_modules\@anthropic-ai\claude-agent-sdk"
$SdkBinarySource = "$RootDir\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64"
$RipgrepSource = "$RootDir\node_modules\@vscode\ripgrep"
Require-Path $SdkSource "Claude Agent SDK core"
Require-Path "$RootDir\packages\shared\src\interceptor-request-utils.ts" "network interceptor request utilities"
Require-Path "$SdkBinarySource\claude.exe" "Claude Agent SDK native binary"
Require-Path "$RipgrepSource\bin\rg.exe" "ripgrep binary"

$AnthropicDest = "$ElectronDir\node_modules\@anthropic-ai"
New-Item -ItemType Directory -Force -Path $AnthropicDest | Out-Null
Copy-Item -Recurse -Force $SdkSource $AnthropicDest
$SdkAliasDest = "$AnthropicDest\claude-agent-sdk-binary"
New-Item -ItemType Directory -Force -Path $SdkAliasDest | Out-Null
Copy-Item -Recurse -Force "$SdkBinarySource\*" $SdkAliasDest
$VscodeDest = "$ElectronDir\node_modules\@vscode"
New-Item -ItemType Directory -Force -Path $VscodeDest | Out-Null
Copy-Item -Recurse -Force $RipgrepSource $VscodeDest

# Use the shared build pipeline: it stages assets and Pi/Vibe subprocesses.
Push-Location $RootDir
try {
    bun run electron:build
    if ($LASTEXITCODE -ne 0) { throw "Electron build failed" }
} finally {
    Pop-Location
}

Push-Location $ElectronDir
try {
    # Publishing is handled only by the verified GitHub Release job, never by
    # electron-builder's CI auto-detection.
    $BuilderConfig = if ($SigningMode -eq "azure") { "electron-builder.azure.yml" } else { "electron-builder.yml" }
    if ($SigningMode -eq "azure") {
        Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
        Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
        Remove-Item Env:CSC_NAME -ErrorAction SilentlyContinue
    }
    Write-Host "Windows signing mode: $SigningMode" -ForegroundColor Cyan
    bun x --bun electron-builder --config $BuilderConfig --win --x64 --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
} finally {
    Pop-Location
}

$UnpackedApp = "$ElectronDir\release\win-unpacked"
$UnpackedBinary = "$UnpackedApp\Robb Agents.exe"
Require-Path $UnpackedBinary "unpacked Electron binary"
bun "$RootDir\scripts\validate-electron-package-security.ts" --binary $UnpackedBinary --resources-dir "$UnpackedApp\resources"
if ($LASTEXITCODE -ne 0) { throw "Electron ASAR/fuse security validation failed" }

$Installer = Get-ChildItem -Path "$ElectronDir\release" -Filter "Robb-Agents-x64*.exe" | Sort-Object Length -Descending | Select-Object -First 1
if (-not $Installer) { throw "Expected Robb Agents NSIS installer was not produced" }

if ($Release) {
    # A public release is valid only when electron-builder signed both the
    # packaged application executable and its NSIS installer.
    Require-ValidAuthenticodeSignature $UnpackedBinary "unpacked Electron binary"
    Require-ValidAuthenticodeSignature $Installer.FullName "NSIS installer"
}

$ChecksumPath = "$ElectronDir\release\SHA256SUMS-windows-x64.txt"
"$((Get-FileHash $Installer.FullName -Algorithm SHA256).Hash.ToLower())  $($Installer.Name)" | Set-Content -NoNewline $ChecksumPath

Push-Location $RootDir
try {
    python scripts/robinswood-windows-packaged-smoke.py --installer $Installer.FullName --checksums $ChecksumPath
    if ($LASTEXITCODE -ne 0) { throw "Windows installer validation failed" }
} finally {
    Pop-Location
}

Write-Host "=== Build complete ===" -ForegroundColor Green
Write-Host "Installer: $($Installer.FullName)"
Write-Host "Checksums: $ChecksumPath"
