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
$BunVersion = "bun-v1.3.9"

function Require-Path([string]$Path, [string]$Description) {
    if (-not (Test-Path $Path)) { throw "Missing ${Description}: $Path" }
}

function Require-Environment([string]$Name) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
        throw "-Release requires $Name"
    }
}

if ($Release) {
    if ([string]::IsNullOrWhiteSpace($env:CSC_LINK) -and [string]::IsNullOrWhiteSpace($env:CSC_NAME)) {
        throw "-Release requires CSC_LINK or CSC_NAME for Authenticode signing."
    }
}

foreach ($command in @("bun", "node", "npx", "python")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command not found on PATH: $command"
    }
}

Write-Host "=== Building Robb Agents Windows Installer ($Arch, release=$Release) ===" -ForegroundColor Cyan

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
    bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
} finally {
    Pop-Location
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
    npx electron-builder --config electron-builder.yml --win --x64 --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
} finally {
    Pop-Location
}

$Installer = Get-ChildItem -Path "$ElectronDir\release" -Filter "Robb-Agents-x64*.exe" | Sort-Object Length -Descending | Select-Object -First 1
if (-not $Installer) { throw "Expected Robb Agents NSIS installer was not produced" }
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
