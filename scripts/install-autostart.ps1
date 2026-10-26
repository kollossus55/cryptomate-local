<#
    Install CryptoMate as a Windows scheduled task so it starts at boot.

    Run this ONCE, from an Administrator PowerShell, in the app folder:

        powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

    What it sets up:
      - starts at boot, before anyone logs in
      - runs as SYSTEM, so no password is stored anywhere
      - restarts automatically if it crashes
      - no execution time limit (it is meant to run forever)

    Safe to run more than once: an existing task is replaced, not duplicated.

    Two notes worth knowing:

    1. Output goes to the log files, not a console window. A task running
       before login has no desktop, so watch data\logs\bot-YYYY-MM-DD.log
       instead of expecting a terminal.

    2. This does NOT stop Windows sleeping. A suspended machine is a bot that
       cannot honour its stop-losses, so set power options to never sleep if
       this matters to you.
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'CryptoMate'

# ── Must be elevated ──────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  This needs an Administrator PowerShell.' -ForegroundColor Yellow
    Write-Host '  Right-click Start, choose "Terminal (Admin)" or "PowerShell (Admin)",'
    Write-Host '  then change to this folder and run it again.'
    Write-Host ''
    exit 1
}

# ── Locate the app ────────────────────────────────────────────────────────
# Resolved from this script's own location, so the task does not depend on
# where you happened to be when you ran it.
$AppDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Entry  = Join-Path $AppDir 'server\index.js'

if (-not (Test-Path $Entry)) {
    Write-Host ''
    Write-Host "  Could not find $Entry" -ForegroundColor Red
    Write-Host '  Run this from inside the CryptoMate folder (scripts\install-autostart.ps1).'
    Write-Host ''
    exit 1
}

# ── Locate node.exe ───────────────────────────────────────────────────────
# The full path, not bare "node": SYSTEM's PATH is not your PATH, and a task
# that cannot find node fails silently at boot with nothing in the log.
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodeExe) {
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if (Test-Path $candidate) { $NodeExe = $candidate; break }
    }
}

if (-not $NodeExe) {
    Write-Host ''
    Write-Host '  Could not find node.exe.' -ForegroundColor Red
    Write-Host '  Install Node 20+ from nodejs.org, then run this again.'
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  CryptoMate autostart' -ForegroundColor Cyan
Write-Host "  app:  $AppDir"
Write-Host "  node: $NodeExe"
Write-Host ''

# ── The UI must already be built ──────────────────────────────────────────
# server/index.js does not build it; only `npm start` does. Without dist the
# server runs and trades fine but the web page shows a "not built" message.
if (-not (Test-Path (Join-Path $AppDir 'dist\index.html'))) {
    Write-Host '  The UI is not built yet. Run `npm start` once first,' -ForegroundColor Yellow
    Write-Host '  then install the task. Continuing anyway — trading will work,'
    Write-Host '  but the web page will not load until you build it.'
    Write-Host ''
}

# ── Register ──────────────────────────────────────────────────────────────
$action = New-ScheduledTaskAction `
    -Execute $NodeExe `
    -Argument 'server\index.js' `
    -WorkingDirectory $AppDir

$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM: starts before login and needs no stored password.
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host '  Replacing the existing task...'
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'CryptoMate trading server. Starts at boot and restarts on failure.' | Out-Null

Write-Host '  Task registered.' -ForegroundColor Green
Write-Host ''

# ── Start it now and confirm ──────────────────────────────────────────────
Write-Host '  Starting it now...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8

$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "  State: $state"

# The real proof is the server answering, not the task reporting Running.
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/health' -TimeoutSec 5
    Write-Host "  Responding. Build: $($health.build)" -ForegroundColor Green
    Write-Host "  Functions loaded: $($health.functions)"
} catch {
    Write-Host '  Not responding on port 8788 yet.' -ForegroundColor Yellow
    Write-Host '  If a copy was already running manually, that is why — stop it and'
    Write-Host '  the task will take over on the next restart. Otherwise check'
    Write-Host "  $AppDir\data\logs for today's log."
}

Write-Host ''
Write-Host '  Done. It will now start automatically at boot.'
Write-Host ''
Write-Host '  Useful commands:'
Write-Host '    Get-ScheduledTask CryptoMate              see its state'
Write-Host '    Stop-ScheduledTask CryptoMate             stop it now'
Write-Host '    Start-ScheduledTask CryptoMate            start it now'
Write-Host '    scripts\uninstall-autostart.ps1           remove it'
Write-Host ''
Write-Host '  Logs: ' -NoNewline
Write-Host "$AppDir\data\logs" -ForegroundColor Cyan
Write-Host ''
