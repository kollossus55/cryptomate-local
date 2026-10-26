<#
    Remove the CryptoMate scheduled task.

    Run from an Administrator PowerShell:

        powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1

    This stops it starting at boot. It does not touch your data, settings,
    password or trade history — only the Windows task.
#>

$ErrorActionPreference = 'Stop'
$TaskName = 'CryptoMate'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  This needs an Administrator PowerShell.' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host '  No CryptoMate task found — nothing to remove.'
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Host '  Stopping and removing the task...'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host '  Removed. Your data and settings are untouched.' -ForegroundColor Green
Write-Host '  Start it manually again with: npm start'
Write-Host ''
