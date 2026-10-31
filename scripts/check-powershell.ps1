param([Parameter(Mandatory = $true)][ValidateSet('syntax', 'lint')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Files = @($env:ROBB_POWERSHELL_CHECK_FILES | ConvertFrom-Json)
if ($Files.Count -eq 0) { throw 'No maintained PowerShell scripts found' }
if ($Mode -eq 'lint') {
    Import-Module PSScriptAnalyzer -RequiredVersion 1.25.0
}
$Failures = 0
foreach ($File in $Files) {
    [System.Management.Automation.Language.Token[]]$Tokens = $null
    [System.Management.Automation.Language.ParseError[]]$ParseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$Tokens, [ref]$ParseErrors)
    foreach ($Problem in $ParseErrors) {
        Write-Output ("{0}:{1}: {2}" -f $File, $Problem.Extent.StartLineNumber, $Problem.Message)
        $Failures++
    }
    if ($Mode -eq 'lint') {
        $Diagnostics = @(Invoke-ScriptAnalyzer -Path $File)
        foreach ($Problem in $Diagnostics) {
            Write-Output ("{0}:{1}: {2} {3}: {4}" -f $File, $Problem.Line, $Problem.Severity, $Problem.RuleName, $Problem.Message)
            $Failures++
        }
    }
}
Write-Output ("PowerShell {0}: {1} maintained scripts; {2} diagnostics" -f $Mode, $Files.Count, $Failures)
if ($Failures -gt 0) { exit 1 }
exit 0
