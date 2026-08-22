# Exercise a Robb Agents NSIS installer in an isolated per-user directory.
# No machine-wide state, credentials, or existing user installation is touched.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [switch]$RequireAuthenticode,
    # ASAR integrity keeps the immutable Electron app in app.asar while native
    # subprocess runtimes remain unpacked. The secured Windows baseline is
    # 953 MiB; a 1 GiB ceiling leaves bounded headroom without weakening the
    # tighter cross-platform default used by the package audit itself.
    [ValidateRange(1, 4096)]
    [int]$MaxInstalledMiB = 1024
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Installer)) { throw "Missing installer: $Installer" }

$Root = Join-Path $env:TEMP "robb-agents-installer-e2e-$([guid]::NewGuid())"
$InstallDir = Join-Path $Root 'RobbAgents'
$SmokeConfig = Join-Path $Root 'craft-profile'
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

function Get-AvailableLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
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
    $vibeBridge = Join-Path $InstallDir 'resources\app\resources\pi-agent-server\vibe-acp-server.js'
    $bundledBun = Join-Path $InstallDir 'resources\app\vendor\bun\bun.exe'
    $claudeRuntime = Join-Path $InstallDir 'resources\app\node_modules\@anthropic-ai\claude-agent-sdk-binary\claude.exe'
    $ripgrep = Join-Path $InstallDir 'resources\app\node_modules\@vscode\ripgrep\bin\rg.exe'
    $rtk = Join-Path $InstallDir 'resources\app\resources\bin\win32-x64\rtk.exe'
    foreach ($required in @($app, $vibeBridge, $bundledBun, $claudeRuntime, $ripgrep, $rtk)) {
        if (-not (Test-Path $required)) { throw "Installed runtime missing: $required" }
    }

    if ($RequireAuthenticode) {
        $installedSignature = Get-AuthenticodeSignature $app
        if ($installedSignature.Status -ne 'Valid') {
            throw "Installed executable Authenticode verification failed: $($installedSignature.Status) $($installedSignature.StatusMessage)"
        }
        Write-Output 'OK: installed Robb Agents executable has a valid Authenticode signature'
    }

    $packageAudit = Join-Path (Get-Location) 'scripts\robb_package_audit.py'
    if (-not (Test-Path $packageAudit)) { throw "Missing package audit script: $packageAudit" }
    & python $packageAudit --root $InstallDir --max-mib $MaxInstalledMiB
    if ($LASTEXITCODE -ne 0) { throw 'Installed app failed recursive release or unpacked size audit' }
    Write-Output 'OK: installed payload passes package hygiene and size audit'

    $rtkVersion = & $rtk --version
    if ($LASTEXITCODE -ne 0 -or -not ($rtkVersion -match '^rtk ')) { throw "Bundled RTK version check failed: $rtkVersion" }
    $rtkGain = & $rtk gain --format json
    if ($LASTEXITCODE -ne 0) { throw 'Bundled RTK gain command failed' }
    try { $rtkGainJson = $rtkGain | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Bundled RTK gain did not return JSON' }
    if ($null -eq $rtkGainJson.summary) { throw 'Bundled RTK gain JSON has no summary' }
    Write-Output 'OK: installed RTK is executable and returns gain JSON'

    # Exercise the installed app with an isolated Craft profile and prove that
    # its renderer is live, rather than merely checking that files were copied.
    $env:CRAFT_CONFIG_DIR = $SmokeConfig
    $env:CRAFT_INSTANCE_NUMBER = 'windows-installer-e2e'
    # Ask the OS for an ephemeral loopback port instead of colliding with a
    # pre-existing debugger on a fixed port. There is a necessarily tiny race
    # between releasing the probe listener and Chromium binding the port.
    $DebugPort = Get-AvailableLoopbackPort
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
