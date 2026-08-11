# Install or update Robb Agents from a verified public GitHub Release.
# Latest stable:
#   irm https://github.com/robinswood-io/robb-agents/releases/latest/download/install-app.ps1 | iex
[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Repository = if ($env:ROBB_GITHUB_REPOSITORY) { $env:ROBB_GITHUB_REPOSITORY } else { 'robinswood-io/robb-agents' }
$ReleaseBaseUrl = $env:ROBB_RELEASE_BASE_URL
if (-not $ReleaseBaseUrl) {
    if ($Version) {
        $ReleaseBaseUrl = "https://github.com/$Repository/releases/download/v$Version"
    } else {
        $ReleaseBaseUrl = "https://github.com/$Repository/releases/latest/download"
    }
}
$DownloadDir = if ($env:ROBB_DOWNLOAD_DIR) { $env:ROBB_DOWNLOAD_DIR } else { Join-Path $env:TEMP 'robb-agents-downloads' }

function Write-Info([string]$Message) { Write-Host "> $Message" -ForegroundColor Blue }
function Write-Success([string]$Message) { Write-Host "> $Message" -ForegroundColor Green }

if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows only.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Robb Agents supports Windows x64 only.' }

New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
$ManifestPath = Join-Path $DownloadDir 'latest.yml'
Write-Info 'Fetching latest.yml from GitHub Releases...'
Invoke-WebRequest -Uri "$ReleaseBaseUrl/latest.yml" -OutFile $ManifestPath -UseBasicParsing
$Manifest = Get-Content $ManifestPath -Raw

if ($Manifest -notmatch '(?m)^version:\s*(\d+\.\d+\.\d+)\s*$') {
    throw 'latest.yml does not contain a stable X.Y.Z version.'
}
$ManifestVersion = $Matches[1]
if ($Version -and $ManifestVersion -ne $Version) {
    throw "Manifest version $ManifestVersion does not match requested $Version."
}

function Get-ManifestFiles([string]$Yaml) {
    $Entries = [System.Collections.Generic.List[object]]::new()
    $Current = $null
    foreach ($Line in ($Yaml -split "`r?`n")) {
        if ($Line -match '^\s*-\s*url:\s*(.+?)\s*$') {
            if ($Current) { $Entries.Add($Current) }
            $Current = [ordered]@{ Url = $Matches[1]; Sha512 = $null; Size = $null }
        } elseif ($Current -and $Line -match '^\s*sha512:\s*(.+?)\s*$') {
            $Current.Sha512 = $Matches[1]
        } elseif ($Current -and $Line -match '^\s*size:\s*(\d+)\s*$') {
            $Current.Size = [long]$Matches[1]
        }
    }
    if ($Current) { $Entries.Add($Current) }
    return $Entries
}

$MatchesForPlatform = @(Get-ManifestFiles $Manifest | Where-Object {
    $_.Url -match '^Robb-Agents-x64[^/\\]*\.exe$' -and $_.Sha512 -and $_.Size
})
if ($MatchesForPlatform.Count -ne 1) {
    throw "Expected exactly one Windows x64 installer in latest.yml; found $($MatchesForPlatform.Count)."
}
$Entry = $MatchesForPlatform[0]
if ($Entry.Sha512 -notmatch '^[A-Za-z0-9+/]{86}==$') { throw 'Invalid SHA-512 in latest.yml.' }
if ($Entry.Size -le 0) { throw 'Invalid installer size in latest.yml.' }

Write-Info "Resolved Robb Agents $ManifestVersion for Windows x64: $($Entry.Url)"
if ($DryRun) {
    Write-Success 'Release metadata is valid (dry run).'
    return
}

$InstallerPath = Join-Path $DownloadDir $Entry.Url
$PartialPath = "$InstallerPath.part"
Remove-Item $PartialPath -Force -ErrorAction SilentlyContinue
Write-Info "Downloading $($Entry.Url)..."
Invoke-WebRequest -Uri "$ReleaseBaseUrl/$($Entry.Url)" -OutFile $PartialPath -UseBasicParsing

$ActualSize = (Get-Item $PartialPath).Length
if ($ActualSize -ne $Entry.Size) {
    Remove-Item $PartialPath -Force
    throw "Size verification failed (expected $($Entry.Size), got $ActualSize)."
}

$Sha512 = [System.Security.Cryptography.SHA512]::Create()
try {
    $Stream = [System.IO.File]::OpenRead($PartialPath)
    try {
        $ActualHash = [Convert]::ToBase64String($Sha512.ComputeHash($Stream))
    } finally {
        $Stream.Dispose()
    }
} finally {
    $Sha512.Dispose()
}
if ($ActualHash -ne $Entry.Sha512) {
    Remove-Item $PartialPath -Force
    throw 'SHA-512 verification failed.'
}
Move-Item $PartialPath $InstallerPath -Force
Write-Success 'Installer size and SHA-512 verified.'

$ProvenancePath = Join-Path $DownloadDir 'PROVENANCE-windows-x64.txt'
Write-Info 'Fetching Windows provenance...'
Invoke-WebRequest -Uri "$ReleaseBaseUrl/PROVENANCE-windows-x64.txt" -OutFile $ProvenancePath -UseBasicParsing
$Provenance = @{}
foreach ($Line in (Get-Content $ProvenancePath)) {
    if ($Line -match '^([^=]+)=(.*)$') {
        $Provenance[$Matches[1]] = $Matches[2]
    }
}
if ($Provenance.product -ne 'Robb Agents') { throw 'Windows provenance has invalid product.' }
if ($Provenance.version -ne $ManifestVersion) { throw "Windows provenance version $($Provenance.version) does not match manifest version $ManifestVersion." }
if ($Provenance.platform -ne 'windows-x64') { throw 'Windows provenance has invalid platform.' }
$DeclaredSigning = $Provenance.signing
if ($DeclaredSigning -notin @('verified-authenticode', 'unsigned-github-release')) {
    throw "Windows provenance has unsupported signing state: $DeclaredSigning"
}

$Signature = Get-AuthenticodeSignature $InstallerPath
if ($DeclaredSigning -eq 'verified-authenticode') {
    if ($Signature.Status -ne 'Valid') {
        Remove-Item $InstallerPath -Force
        throw "Authenticode verification failed: $($Signature.Status) $($Signature.StatusMessage)"
    }
    Write-Success "Authenticode signature verified: $($Signature.SignerCertificate.Subject)"
} elseif ($Signature.Status -eq 'Valid') {
    Write-Success "Authenticode signature verified despite unsigned-release provenance: $($Signature.SignerCertificate.Subject)"
} else {
    Write-Info 'This GitHub Release explicitly declares the Windows installer as unsigned.'
    Write-Info 'Windows may show an unknown-publisher or SmartScreen warning. Continue only if SHA-512 and GitHub provenance verification match your trust policy.'
}

$Running = @(Get-Process -Name 'Robb Agents' -ErrorAction SilentlyContinue)
if ($Running.Count -gt 0) {
    Write-Info 'Closing Robb Agents...'

    foreach ($Process in $Running) {
        $Process.CloseMainWindow() | Out-Null
    }

    foreach ($Process in $Running) {
        $Process.WaitForExit(10000) | Out-Null
    }

    if (Get-Process -Name 'Robb Agents' -ErrorAction SilentlyContinue) {
        throw 'Robb Agents is still running; close every window and retry.'
    }
}

Write-Info 'Starting the per-user Robb Agents installer...'
$InstallerProcess = Start-Process -FilePath $InstallerPath -Wait -PassThru
if ($InstallerProcess.ExitCode -ne 0) {
    throw "Installation failed with exit code $($InstallerProcess.ExitCode)."
}
Remove-Item $InstallerPath -Force -ErrorAction SilentlyContinue

$InstallRoot = if ($env:ROBB_INSTALL_DIR) {
    $env:ROBB_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA 'Programs\Robb Agents'
}
$Executable = Join-Path $InstallRoot 'Robb Agents.exe'
if (-not (Test-Path $Executable)) {
    Write-Info "Installation completed; executable location was customized (default not found at $Executable)."
} else {
    $BinDir = Join-Path $env:LOCALAPPDATA 'Robb Agents\bin'
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $CommandFile = Join-Path $BinDir 'robb-agents.cmd'
    Set-Content -Path $CommandFile -Encoding ASCII -Value "@echo off`r`nstart `"`" `"$Executable`" %*"

    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $PathEntries = @($UserPath -split ';' | Where-Object { $_ })
    if ($PathEntries -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable('Path', (($PathEntries + $BinDir) -join ';'), 'User')
        Write-Info "Added $BinDir to the user PATH; restart the terminal before using robb-agents."
    }
}

Write-Success "Robb Agents $ManifestVersion installation completed."
