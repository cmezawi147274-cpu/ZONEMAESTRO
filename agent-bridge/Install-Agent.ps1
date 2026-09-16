<#
===========================================================================
 CMMP / ZoneMaestro — venue agent installer, updater and health check.

 Run this ON THE VENUE PC, in an ELEVATED PowerShell ("Run as administrator"),
 from the folder this file was extracted into:

     Set-ExecutionPolicy -Scope Process Bypass -Force; .\Install-Agent.ps1

 It is safe to run repeatedly. Re-running it is how you update an agent.

 WHAT THIS FIXES THAT THE CLOUD CANNOT
 -------------------------------------
 There is no inbound path to a venue — the PCs sit behind NAT/CGNAT and only
 ever dial out. So nothing in the cloud can reach in to update an agent,
 restart it, resync a clock, or enable Equalizer APO on a device. Those are
 the jobs this script exists to do, on site:

   1. UPDATE the agent. The cloud can only *show* that a venue runs an old
      build (Servers -> the "Outdated" badge); this is what changes it.
   2. KEEP IT RUNNING. Connect-To-Cloud.cmd runs the agent in a console
      window, and closing that window — or a reboot, or an operator tidying
      up — silently disconnects the venue. This registers it as a scheduled
      task that runs at boot, without a logged-in user, and restarts itself
      if it ever stops.
   3. CLOCK. Venue PCs keep bad time (dead CMOS batteries, NTP jumps). The
      cloud now hands the agent a trusted `serverTime` on every heartbeat so
      it can *detect* skew, but only the machine itself can correct it.
   4. EQUALIZER APO. A zone's EQ cannot be applied unless APO is installed
      and ticked for that zone's output device, which needs a local reboot.
      This reports exactly which devices are covered.

 WHAT IT DELIBERATELY DOES NOT DO
 --------------------------------
   * It never touches pairing. An existing agent-state.json (this venue's
     cloud token) and .env are preserved across an update — updating must
     never strand a venue into needing a fresh pairing code.
   * It installs no cloud credentials. This package contains the agent only.
===========================================================================
#>

[CmdletBinding()]
param(
  # Where the agent lives on this PC. Kept out of "Program Files" so the
  # service account can write agent-state.json and the log beside it.
  [string]$InstallDir = "C:\CMMP\agent-bridge",

  # Skip the Windows time resync (step 6).
  [switch]$SkipClockSync,

  # Check and report only — change nothing on this machine.
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$TaskName  = "CMMP Agent Bridge"
$PanelUrl  = "http://127.0.0.1:8899"
$Problems  = New-Object System.Collections.Generic.List[string]
$Warnings  = New-Object System.Collections.Generic.List[string]

function Write-Step($n, $text) { Write-Host ""; Write-Host "  [$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "      OK    $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "      WARN  $text" -ForegroundColor Yellow; $Warnings.Add($text) }
function Write-Bad($text)      { Write-Host "      FAIL  $text" -ForegroundColor Red;    $Problems.Add($text) }

Write-Host ""
Write-Host "  ==========================================================" -ForegroundColor White
Write-Host "    CMMP venue agent  -  install / update / health check"    -ForegroundColor White
Write-Host "  ==========================================================" -ForegroundColor White

# --------------------------------------------------------------------------
# 1. Elevation. Registering a boot task and resyncing the clock both need it,
#    and failing here with a clear message beats failing halfway through.
# --------------------------------------------------------------------------
Write-Step 1 "Checking permissions"
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host ""
  Write-Host "  This must run as administrator." -ForegroundColor Red
  Write-Host "  Close this window, right-click PowerShell, choose" -ForegroundColor Red
  Write-Host "  'Run as administrator', and run it again." -ForegroundColor Red
  Write-Host ""
  exit 1
}
Write-Ok "Running elevated."

# --------------------------------------------------------------------------
# 2. Node. The agent is plain Node with no dependencies to install.
# --------------------------------------------------------------------------
Write-Step 2 "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Bad "Node.js is not installed (or not on PATH)."
  Write-Host ""
  Write-Host "      Install the LTS build from https://nodejs.org and re-run." -ForegroundColor Yellow
  Write-Host ""
  exit 1
}
$nodeVersion = (& node --version).Trim()          # e.g. v20.11.1
$nodeMajor   = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($nodeMajor -lt 18) {
  Write-Bad "Node $nodeVersion is too old; the agent needs 18 or newer."
  exit 1
}
Write-Ok "Node $nodeVersion at $($node.Source)"

# --------------------------------------------------------------------------
# 3. Deploy. The source is the folder this script sits in.
#    .env and agent-state.json are this venue's identity — they are carried
#    across an update untouched. Losing agent-state.json would unpair the
#    venue and require a human to issue a new pairing code.
# --------------------------------------------------------------------------
Write-Step 3 "Installing agent files"
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $SourceDir "bridge.js"))) {
  Write-Bad "bridge.js is not next to this script — run it from the extracted package folder."
  exit 1
}

$newVersion = "unknown"
try {
  $newVersion = (Get-Content (Join-Path $SourceDir "package.json") -Raw | ConvertFrom-Json).version
} catch { }

$isUpdate = Test-Path (Join-Path $InstallDir "bridge.js")
$oldVersion = "none"
if ($isUpdate) {
  try {
    $oldVersion = (Get-Content (Join-Path $InstallDir "package.json") -Raw | ConvertFrom-Json).version
  } catch { }
}

if ($CheckOnly) {
  Write-Ok "Check-only: installed=$oldVersion, package=$newVersion (nothing written)."
} else {
  # Stop the running agent first: Windows will not overwrite a .js file that
  # a running node process has mapped, and a half-updated agent is worse
  # than a stopped one.
  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
  }
  Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -eq $node.Source } |
    ForEach-Object {
      try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
        if ($cmd -and $cmd -match 'bridge\.js') { Stop-Process -Id $_.Id -Force }
      } catch { }
    }
  Start-Sleep -Milliseconds 500

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  # Preserve venue identity across the copy.
  $preserve = @{}
  foreach ($keep in @(".env", "agent-state.json")) {
    $p = Join-Path $InstallDir $keep
    if (Test-Path $p) { $preserve[$keep] = Get-Content $p -Raw }
  }

  foreach ($item in @("bridge.js", "package.json", "lib", "ui", "Connect-To-Cloud.cmd", "Start-Agent.cmd", "README.md", "Install-Agent.ps1")) {
    $src = Join-Path $SourceDir $item
    if (Test-Path $src) {
      Copy-Item $src -Destination $InstallDir -Recurse -Force
    }
  }

  foreach ($keep in $preserve.Keys) {
    Set-Content -Path (Join-Path $InstallDir $keep) -Value $preserve[$keep] -NoNewline -Encoding UTF8
  }

  # A first install needs a .env; an update already has one and must not be
  # overwritten. CMMP_API_URL is the only value that matters before pairing.
  $envPath = Join-Path $InstallDir ".env"
  if (-not (Test-Path $envPath)) {
    @(
      "# Created by Install-Agent.ps1. Pair this PC from the control panel at $PanelUrl.",
      "CMMP_API_URL=https://cloud.zonemaestro.com/api",
      "LOCAL_API_URL=http://127.0.0.1:8765/api",
      "PAIRING_CODE="
    ) -join "`r`n" | Set-Content -Path $envPath -Encoding UTF8
    Write-Ok "Created .env pointing at https://cloud.zonemaestro.com/api"
  } else {
    Write-Ok "Kept the existing .env and pairing state."
  }

  if ($isUpdate) { Write-Ok "Updated $oldVersion -> $newVersion in $InstallDir" }
  else           { Write-Ok "Installed $newVersion into $InstallDir" }
}

# --------------------------------------------------------------------------
# 4. Autostart. This is the availability fix: the agent stops being a console
#    window somebody has to remember to keep open.
# --------------------------------------------------------------------------
Write-Step 4 "Registering the agent to start at boot"
if ($CheckOnly) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) { Write-Ok "Scheduled task '$TaskName' exists (state: $($t.State))." }
  else    { Write-Warn2 "No '$TaskName' task — the agent only runs while someone keeps a window open." }
} else {
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument "bridge.js" -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # SYSTEM so it runs with no one logged in. The agent serves only loopback
  # and needs local admin rights anyway to write Equalizer APO's config.
  $sysPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $sysPrincipal -Settings $settings -Force | Out-Null
  Write-Ok "Scheduled task '$TaskName' registered (boot, SYSTEM, auto-restart)."

  Start-ScheduledTask -TaskName $TaskName
  Write-Ok "Agent started."
}

# --------------------------------------------------------------------------
# 5. Equalizer APO. eq-apo.js refuses to claim success it did not achieve, so
#    a zone whose device is not covered here will report a real SET_EQ
#    failure in the portal. Fixing it needs DeviceSelector.exe and a reboot —
#    both local-only.
# --------------------------------------------------------------------------
Write-Step 5 "Checking Equalizer APO"
$apoDir = @("C:\Program Files\EqualizerAPO", "C:\Program Files (x86)\EqualizerAPO") |
  Where-Object { Test-Path (Join-Path $_ "EqualizerAPO.dll") } | Select-Object -First 1

if (-not $apoDir) {
  Write-Warn2 "Equalizer APO is not installed — zone EQ cannot be applied on this PC."
  Write-Host "      This is why the portal shows 'Equalizer APO is not installed on this PC'." -ForegroundColor Yellow
  Write-Host "      The agent is reporting honestly: without APO in the Windows audio" -ForegroundColor Yellow
  Write-Host "      stack there is nothing that can apply an EQ curve here." -ForegroundColor Yellow
  Write-Host ""

  # Deliberately not silent-installed unattended. Equalizer APO inserts
  # itself into the audio stack, its installer requires picking the output
  # device(s) to hook, and it only takes effect after a reboot. Doing that
  # invisibly on a machine that is currently playing music to a room is how
  # you take a venue's audio down with no one watching. So: fetch it, then
  # hand the operator the two choices that actually matter.
  if ($CheckOnly) {
    Write-Host "      Check-only: skipping the Equalizer APO download." -ForegroundColor Yellow
  } else {
    $answer = Read-Host "      Download and launch the Equalizer APO installer now? (y/N)"
    if ($answer -match '^(y|yes)$') {
      $apoUrl = "https://sourceforge.net/projects/equalizerapo/files/latest/download"
      $apoExe = Join-Path $env:TEMP "EqualizerAPO-Setup.exe"
      try {
        Write-Host "      Downloading Equalizer APO..." -ForegroundColor Cyan
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $apoUrl -OutFile $apoExe -UseBasicParsing -MaximumRedirection 10 -TimeoutSec 180
        Write-Ok "Downloaded to $apoExe"
        Write-Host ""
        Write-Host "      The installer will now open. Two things matter:" -ForegroundColor Yellow
        Write-Host "        1. When it asks which devices to use, TICK the speaker/output" -ForegroundColor Yellow
        Write-Host "           this venue's zones actually play through." -ForegroundColor Yellow
        Write-Host "        2. REBOOT when it asks. APO does not take effect until you do." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "      After the reboot, run this script again to confirm." -ForegroundColor Yellow
        Start-Process -FilePath $apoExe -Wait
        Write-Ok "Installer finished. Reboot, then re-run this script."
      } catch {
        Write-Warn2 "Could not download Equalizer APO automatically: $($_.Exception.Message)"
        Write-Host "      Install it by hand from https://sourceforge.net/projects/equalizerapo/" -ForegroundColor Yellow
      }
    } else {
      Write-Host "      Skipped. Zone EQ stays unavailable on this PC until APO is installed." -ForegroundColor Yellow
    }
  }
} else {
  Write-Ok "Equalizer APO at $apoDir"
  $renderRoot = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
  $covered = @()
  $uncovered = @()
  foreach ($dev in (Get-ChildItem $renderRoot -ErrorAction SilentlyContinue)) {
    $name = $null
    try {
      $props = Get-ItemProperty "$($dev.PSPath)\Properties" -ErrorAction Stop
      $name = $props."{a45c254e-df1c-4efd-8020-67d146a850e0},2"
    } catch { }
    if (-not $name) { continue }
    # Only devices that are actually present/active are worth reporting.
    try {
      $stateVal = (Get-ItemProperty $dev.PSPath -ErrorAction Stop).DeviceState
      if ($null -ne $stateVal -and $stateVal -ne 1) { continue }
    } catch { }
    $hooked = $false
    try {
      $fx = Get-ItemProperty "$($dev.PSPath)\FxProperties" -ErrorAction Stop | Out-String
      if ($fx -match 'EC1CC9CE|B48F9B61|EqualizerAPO') { $hooked = $true }
    } catch { }
    if ($hooked) { $covered += $name } else { $uncovered += $name }
  }
  if ($covered.Count -gt 0) { Write-Ok "APO enabled on: $($covered -join ', ')" }
  if ($uncovered.Count -gt 0) {
    Write-Warn2 "APO NOT enabled on: $($uncovered -join ', ')"
    Write-Host "      Any zone pointed at those will fail SET_EQ in the portal." -ForegroundColor Yellow
    Write-Host "      Fix: run '$apoDir\DeviceSelector.exe', tick them, then REBOOT." -ForegroundColor Yellow
  }
  if ($covered.Count -eq 0 -and $uncovered.Count -eq 0) {
    Write-Warn2 "No active render devices found to check."
  }
}

# --------------------------------------------------------------------------
# 6. Clock. The cloud can detect skew from the heartbeat's serverTime, but
#    only this machine can fix it.
# --------------------------------------------------------------------------
Write-Step 6 "Checking the system clock"
if ($SkipClockSync -or $CheckOnly) {
  Write-Ok "Skipped (local time: $(Get-Date -Format o))"
} else {
  try {
    Set-Service -Name w32time -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service w32time -ErrorAction SilentlyContinue
    & w32tm /resync /force 2>&1 | Out-Null
    Write-Ok "Time resynced. Local time now: $(Get-Date -Format o)"
  } catch {
    Write-Warn2 "Could not resync the clock automatically: $($_.Exception.Message)"
  }
}

# --------------------------------------------------------------------------
# 7. Verify the agent actually came up and says so itself.
# --------------------------------------------------------------------------
Write-Step 7 "Verifying the agent"
if ($CheckOnly -and -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Write-Warn2 "Nothing to verify — the agent is not installed as a task."
} else {
  $status = $null
  foreach ($attempt in 1..15) {
    try {
      $status = Invoke-RestMethod "$PanelUrl/api/status" -TimeoutSec 3
      break
    } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $status) {
    Write-Bad "The agent did not answer on $PanelUrl within 15s."
    Write-Host "      Look at: Task Scheduler -> '$TaskName' -> Last Run Result." -ForegroundColor Yellow
  } else {
    Write-Ok "Agent responding. Reported version: $($status.agentVersion)"
    if ($status.paired) {
      Write-Ok "Paired with the cloud — this venue is connected."
    } else {
      Write-Warn2 "Not paired yet."
      Write-Host "      Open $PanelUrl and paste the pairing code from" -ForegroundColor Yellow
      Write-Host "      CMMP -> Servers -> (this venue) -> pairing code." -ForegroundColor Yellow
    }
  }
}

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "  ----------------------------------------------------------" -ForegroundColor White
if ($Problems.Count -eq 0 -and $Warnings.Count -eq 0) {
  Write-Host "   Done. Nothing needs attention on this PC." -ForegroundColor Green
} else {
  if ($Problems.Count -gt 0) {
    Write-Host "   Problems:" -ForegroundColor Red
    $Problems | ForEach-Object { Write-Host "     - $_" -ForegroundColor Red }
  }
  if ($Warnings.Count -gt 0) {
    Write-Host "   Needs attention:" -ForegroundColor Yellow
    $Warnings | ForEach-Object { Write-Host "     - $_" -ForegroundColor Yellow }
  }
}
Write-Host ""
Write-Host "   Control panel: $PanelUrl" -ForegroundColor White
Write-Host "   Re-run this script any time to update or re-check." -ForegroundColor White
Write-Host "  ----------------------------------------------------------" -ForegroundColor White
Write-Host ""

if ($Problems.Count -gt 0) { exit 1 }
exit 0
