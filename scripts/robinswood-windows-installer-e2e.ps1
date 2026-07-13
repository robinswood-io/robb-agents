# Exercise a Robb Agents NSIS installer in an isolated per-user directory.
# No machine-wide state, credentials, or existing user installation is touched.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Installer)) { throw "Missing installer: $Installer" }

$Root = Join-Path $env:TEMP "robb-agents-installer-e2e-$([guid]::NewGuid())"
$InstallDir = Join-Path $Root 'RobbAgents'
try {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    # NSIS requires /D= as its final argument. The installer is per-user, so
    # silent install requires no elevation and remains confined to $InstallDir.
    $process = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$InstallDir" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Silent NSIS install exited with $($process.ExitCode)" }

    $app = Join-Path $InstallDir 'Robb Agents.exe'
    $vibeBridge = Join-Path $InstallDir 'resources\app\dist\resources\pi-agent-server\vibe-acp-server.js'
    if (-not (Test-Path $app)) { throw "Installed app missing: $app" }
    if (-not (Test-Path $vibeBridge)) { throw "Installed Mistral Vibe ACP bridge missing: $vibeBridge" }

    $uninstaller = Get-ChildItem -Path $InstallDir -Filter 'Uninstall*.exe' | Select-Object -First 1
    if (-not $uninstaller) { throw 'NSIS uninstaller was not installed' }
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Silent NSIS uninstall exited with $($uninstall.ExitCode)" }
    if (Test-Path $app) { throw 'Robb Agents executable remains after silent uninstall' }

    Write-Output 'OK: isolated Windows install exposes app and Vibe bridge'
    Write-Output 'OK: isolated Windows uninstall removes app executable'
} finally {
    Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
}
