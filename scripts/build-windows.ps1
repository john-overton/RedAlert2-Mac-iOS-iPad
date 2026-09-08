# Native Windows wrapper; the Bun builder also supports cross-packaging on Mac/Linux.
[CmdletBinding()]
param(
    [switch]$RA2,
    [switch]$NoWeb,
    [switch]$NoCampaign,
    [ValidateSet('x64', 'arm64')][string]$Arch = 'x64'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Install Bun and reopen PowerShell before building. See docs/WINDOWS.md.' }
$buildArgs = @((Join-Path $PSScriptRoot 'build-windows.ts'), '--arch', $Arch)
if ($RA2) { $buildArgs += '--ra2' }
if ($NoWeb) { $buildArgs += '--no-web' }
if ($NoCampaign) { $buildArgs += '--no-campaign' }
Push-Location $repoRoot
try {
    & bun @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "Windows build failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
