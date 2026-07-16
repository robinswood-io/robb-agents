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
$SmokeConfig = Join-Path $Root 'craft-profile'
$DebugPort = 9229
$PreviousConfigDir = $env:CRAFT_CONFIG_DIR
$PreviousInstanceNumber = $env:CRAFT_INSTANCE_NUMBER
$AppProcess = $null

function Restore-EnvironmentVariable([string]$Name, [string]$Value) {
    if ($null -eq $Value) {
        Remove-Item "Env:$Name" -ErrorAction SilentlyContinue
    } else {
        Set-Item "Env:$Name" $Value
    }
}

try {
    New-Item -ItemType Directory -Force -Path $Root, $SmokeConfig, (Join-Path $SmokeConfig 'robb-electron') | Out-Null
    # NSIS requires /D= as its final argument. The installer is per-user, so
    # silent install requires no elevation and remains confined to $InstallDir.
    # NSIS requires /D= as its unquoted final argument. GitHub's runner temp
    # path is the 8.3 no-space form (for example C:\Users\RUNNER~1\...).
    $process = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$InstallDir" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Silent NSIS install exited with $($process.ExitCode)" }

    $app = Join-Path $InstallDir 'Robb Agents.exe'
    $vibeBridge = Join-Path $InstallDir 'resources\app\dist\resources\pi-agent-server\vibe-acp-server.js'
    $bundledBun = Join-Path $InstallDir 'resources\vendor\bun\bun.exe'
    $claudeRuntime = Join-Path $InstallDir 'resources\app\node_modules\@anthropic-ai\claude-agent-sdk-binary\claude.exe'
    $ripgrep = Join-Path $InstallDir 'resources\app\node_modules\@vscode\ripgrep\bin\rg.exe'
    foreach ($required in @($app, $vibeBridge, $bundledBun, $claudeRuntime, $ripgrep)) {
        if (-not (Test-Path $required)) { throw "Installed runtime missing: $required" }
    }

    # Exercise the installed app with an isolated Craft profile and prove that
    # its renderer is live, rather than merely checking that files were copied.
    $env:CRAFT_CONFIG_DIR = $SmokeConfig
    $env:CRAFT_INSTANCE_NUMBER = 'windows-installer-e2e'
    $AppProcess = Start-Process -FilePath $app -ArgumentList "--remote-debugging-port=$DebugPort" -PassThru
    $targets = $null
    $rendererProcess = $null
    $hasCdpRenderer = $false
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 500
        $AppProcess.Refresh()
        if ($AppProcess.HasExited) { throw "Installed app exited during launch smoke test: $($AppProcess.ExitCode)" }
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 3 -ErrorAction Stop
        } catch {
            $targets = $null
        }
        $hasCdpRenderer = @($targets | Where-Object { $_.type -eq 'page' -and $_.title -eq 'Robb Agents' }).Count -gt 0
        # Hosted Windows runners may suppress the DevTools listener for their
        # non-interactive desktop. A Chromium renderer child is the equivalent
        # runtime signal in that environment.
        $rendererProcess = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($AppProcess.Id)" |
            Where-Object { $_.CommandLine -match '--type=renderer' }
    } while (-not $hasCdpRenderer -and $null -eq $rendererProcess -and (Get-Date) -lt $deadline)
    if ($hasCdpRenderer) {
        Write-Output 'OK: installed Robb Agents exposes a renderer through CDP'
    } elseif ($null -ne $rendererProcess) {
        Write-Output 'OK: installed Robb Agents spawned a Chromium renderer on the non-interactive Windows runner'
    } else {
        throw 'Installed app did not expose a CDP page or Chromium renderer within 45 seconds'
    }
    & taskkill.exe /PID $AppProcess.Id /T /F 2>$null | Out-Null
    $AppProcess.WaitForExit()
    $AppProcess = $null

    $uninstaller = Get-ChildItem -Path $InstallDir -Filter 'Uninstall*.exe' | Select-Object -First 1
    if (-not $uninstaller) { throw 'NSIS uninstaller was not installed' }
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Silent NSIS uninstall exited with $($uninstall.ExitCode)" }
    if (Test-Path $app) { throw 'Robb Agents executable remains after silent uninstall' }

    Write-Output 'OK: isolated Windows install exposes the Robb runtime stack'
    Write-Output 'OK: installed Robb Agents exposes a live renderer'
    Write-Output 'OK: isolated Windows uninstall removes app executable'
} finally {
    if ($null -ne $AppProcess -and -not $AppProcess.HasExited) {
        & taskkill.exe /PID $AppProcess.Id /T /F 2>$null | Out-Null
    }
    Restore-EnvironmentVariable 'CRAFT_CONFIG_DIR' $PreviousConfigDir
    Restore-EnvironmentVariable 'CRAFT_INSTANCE_NUMBER' $PreviousInstanceNumber
    Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
}
