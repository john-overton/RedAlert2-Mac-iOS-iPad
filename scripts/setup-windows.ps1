#Requires -Version 5.1
<#
.SYNOPSIS
Import assets from your own retail Red Alert 2 installation for a Windows build.
.EXAMPLE
.\scripts\setup-windows.ps1 -RetailDir 'C:\Games\Red Alert 2' -IncludeCampaign
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$RetailDir = $env:RA2_RETAIL_DIR,
    [switch]$IncludeCampaign
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-NativeSuccess([string]$Action) {
    if ($LASTEXITCODE -ne 0) { throw "$Action failed (exit code $LASTEXITCODE)." }
}

Write-Host 'Checking prerequisites...'
$bun = (Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $bun) { throw 'Bun is required. Install it from https://bun.sh, then reopen PowerShell.' }
$ffmpeg = (Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $ffmpeg) { throw 'FFmpeg is required on PATH, including libvpx and libx264 encoders. See docs/WINDOWS.md.' }
& $bun.Source --version
Assert-NativeSuccess 'Bun prerequisite check'
& $ffmpeg.Source -version | Select-Object -First 1
Assert-NativeSuccess 'FFmpeg prerequisite check'

if (-not $RetailDir) {
    Write-Host 'Searching common Steam installation locations...'
    $steamRoots = @()
    if (Test-Path 'HKCU:\Software\Valve\Steam') {
        $steamPath = Get-ItemPropertyValue 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue
        if ($steamPath) { $steamRoots += $steamPath }
    }
    foreach ($programs in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ($programs) { $steamRoots += Join-Path $programs 'Steam' }
    }
    foreach ($steamRoot in ($steamRoots | Select-Object -Unique)) {
        foreach ($gameName in @('Command & Conquer Red Alert 2', 'Command and Conquer Red Alert 2')) {
            $candidate = Join-Path $steamRoot "steamapps\common\$gameName"
            if (Test-Path -LiteralPath (Join-Path $candidate 'ra2.mix') -PathType Leaf) {
                $RetailDir = $candidate
                break
            }
        }
        if ($RetailDir) { break }
    }
    if (-not $RetailDir) { throw "Could not find the retail installation. Pass -RetailDir 'D:\SteamLibrary\steamapps\common\Command & Conquer Red Alert 2'." }
}

if (-not (Test-Path -LiteralPath $RetailDir -PathType Container)) { throw "Not a directory: $RetailDir" }
$RetailDir = (Resolve-Path -LiteralPath $RetailDir).Path
Write-Host "Verifying retail files in: $RetailDir"
$required = @('ra2.mix', 'language.mix', 'multi.mix', 'theme.mix')
if ($IncludeCampaign) { $required += 'maps01.mix' }
foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $RetailDir $name) -PathType Leaf)) {
        throw "Missing $name in $RetailDir. Supply the directory containing your retail MIX archives."
    }
    Write-Host "  $name OK"
}
$yrAvailable = (Test-Path -LiteralPath (Join-Path $RetailDir 'ra2md.mix') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $RetailDir 'langmd.mix') -PathType Leaf)
if ($yrAvailable) { Write-Host "  Yuri's Revenge content available" }
else { Write-Host "  Yuri's Revenge archives not found; use -RA2 when building." }

Push-Location (Join-Path $repoRoot 'redalert2')
try {
    Write-Host 'Installing web dependencies...'
    & $bun.Source install --frozen-lockfile
    Assert-NativeSuccess 'Dependency installation'
}
finally { Pop-Location }

$previousRetailDir = $env:RA2_RETAIL_DIR
Push-Location $repoRoot
try {
    $env:RA2_RETAIL_DIR = $RetailDir
    Write-Host 'Importing game assets (this can take a few minutes)...'
    & $bun.Source (Join-Path $PSScriptRoot 'prepare-gameres.ts')
    Assert-NativeSuccess 'Game asset import'
    if ($IncludeCampaign) {
        Write-Host 'Importing experimental Allied campaign content...'
        & $bun.Source (Join-Path $PSScriptRoot 'prepare-campaign.ts') $RetailDir
        Assert-NativeSuccess 'Campaign import'
    }
}
finally {
    $env:RA2_RETAIL_DIR = $previousRetailDir
    Pop-Location
}

Write-Host ''
Write-Host 'Setup complete. Build the Windows app with:'
if ($yrAvailable) { Write-Host '  .\scripts\build-windows.ps1' }
else { Write-Host '  .\scripts\build-windows.ps1 -RA2' }
Write-Host 'Imported retail content remains local in gameres-export/ and campaign-export/ (gitignored).'
Write-Host 'See docs/WINDOWS.md for build and launch instructions.'
