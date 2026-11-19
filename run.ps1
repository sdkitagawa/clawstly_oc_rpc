# Clawstly - easy RPC control.
# Double-click run.cmd / run.bat, or run: powershell -File run.ps1

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Cli = Join-Path $Root 'bin\clawstly-oc-rpc.js'
$AppName = 'Clawstly'
$DashboardPort = 47474

if (-not (Test-Path -LiteralPath $Cli)) {
  Write-Host "Cannot find CLI at: $Cli" -ForegroundColor Red
  Read-Host 'Press Enter to exit' | Out-Null
  exit 1
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Host 'Node.js was not found on PATH. Install Node 18+ and try again.' -ForegroundColor Red
  Read-Host 'Press Enter to exit' | Out-Null
  exit 1
}
$Node = $nodeCommand.Source

# The source selected in menu option 5 is canonical. Follow whichever install
# OpenCode registers as the plugin source so both launchers read and write the
# same config.json and model history instead of each copy keeping its own stale
# displayModel.
$LocalCli = $Cli
try {
  $registered = (& $Node $LocalCli source status --short 2>$null | Out-String).Trim()
  if ($registered -and (Test-Path -LiteralPath $registered -PathType Container)) {
    $candidateRoot = Split-Path -Parent $registered
    $candidateCli = Join-Path $candidateRoot 'bin\clawstly-oc-rpc.js'
    if (Test-Path -LiteralPath $candidateCli) {
      $Root = $candidateRoot
      $Cli = $candidateCli
    }
  }
} catch { # keep using this copy when the registration cannot be read
}

Set-Location -LiteralPath $Root

function Invoke-Rpc {
  param([string[]]$RpcArgs)
  & $Node $Cli @RpcArgs
  $script:RpcExitCode = $LASTEXITCODE
}

function Get-RpcConfig {
  $cfg = [pscustomobject]@{
    appName = $AppName
    displayModel = 'Claude Opus'
    displayMetric = 'cost'
  }
  $configPath = Join-Path $Root 'config.json'
  if (Test-Path -LiteralPath $configPath) {
    try {
      $raw = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($raw.appName) { $cfg.appName = [string]$raw.appName }
      if ($null -ne $raw.displayModel) { $cfg.displayModel = [string]$raw.displayModel }
      if ($raw.displayMetric) { $cfg.displayMetric = [string]$raw.displayMetric }
    } catch { }
  }
  return $cfg
}

function Get-DaemonPid {
  $stateDir = Join-Path $env:TEMP 'clawstly-oc-rpc'
  $pidPath = Join-Path $stateDir 'daemon.pid'
  $infoPath = Join-Path $stateDir 'daemon.json'
  if (-not (Test-Path -LiteralPath $pidPath)) { return '' }

  $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
  if ($pidText -notmatch '^\d+$') { return '' }
  $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
  if (-not $proc) { return '' }

  if (Test-Path -LiteralPath $infoPath) {
    try {
      $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
      if ([int]$info.pid -eq [int]$pidText -and $info.beatAt) {
        $beat = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$info.beatAt).UtcDateTime
        if (((Get-Date).ToUniversalTime() - $beat).TotalMilliseconds -gt 300000) { return '' }
      }
    } catch { }
  }
  return $pidText
}

function Get-SourceLabel {
  try {
    $value = (& $Node $Cli source status --short 2>$null | Out-String).Trim()
    if ($value) { return $value }
  } catch { }
  return 'none'
}

function Test-Dashboard {
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$DashboardPort/api/settings" -TimeoutSec 2 -ErrorAction Stop
    return $res.StatusCode -eq 200
  } catch { return $false }
}

function Show-Header {
  param([switch]$Clear)
  if ($Clear) { try { Clear-Host } catch { } }
  $cfg = Get-RpcConfig
  $pidText = Get-DaemonPid
  if (-not $pidText) { $pidText = 'stopped' }
  $dash = if (Test-Dashboard) { "listening ($DashboardPort)" } else { 'stopped' }
  $source = Get-SourceLabel
  if ($source.Length -gt 52) { $source = '...' + $source.Substring($source.Length - 49) }
  $model = if ($cfg.displayModel) { $cfg.displayModel } else { 'real model' }
  $app = if ($cfg.appName) { $cfg.appName } else { $AppName }

  $label = "$AppName - RPC control"
  $inner = 60
  $pad = [Math]::Max(0, $inner - $label.Length)
  $left = [int][Math]::Ceiling($pad / 2.0)
  $right = $pad - $left
  Write-Host ('+' + ('-' * $inner) + '+') -ForegroundColor DarkCyan
  Write-Host ('|' + (' ' * $left) + $label + (' ' * $right) + '|') -ForegroundColor Cyan
  Write-Host ('+' + ('-' * $inner) + '+') -ForegroundColor DarkCyan
  Write-Host ''
  Write-Host (" Daemon    : {0}" -f $pidText)
  Write-Host (" Dashboard : {0}" -f $dash)
  Write-Host (" Source    : {0}" -f $source)
  Write-Host (" App       : {0}" -f $app)
  Write-Host (" Model     : {0}" -f $model)
  Write-Host (" Metric    : {0}" -f $cfg.displayMetric)
  Write-Host ''
}

function Wait-ForUser {
  Write-Host ''
  # Read-Host appends ": " to its prompt, so print the exact text ourselves
  # and use a promptless read to wait for Enter.
  Write-Host 'Press ENTER to continue.'
  Read-Host | Out-Null
}

function Show-MainMenu {
  Show-Header -Clear
  Write-Host ' 1 -  Start all - Daemon / Dashboard Server.'
  Write-Host ' 2 -  Stop all - Clean-stop Daemon, Force-stop leftover Daemon/Server Node processes.'
  Write-Host ' 3 -  Restart all.'
  Write-Host ' 4 -  Restart RPC only.'
  Write-Host ' 5 -  Plugin source.'
  Write-Host ' 6 -  Open dashboard.'
  Write-Host ' 7 -  Status.'
  Write-Host ' 8 -  Health check.'
  Write-Host ' 9 -  Change displayed model.'
  Write-Host '10 -  Token / Cost display.'
  Write-Host '11 -  Start RPC only (Daemon).'
  Write-Host '12 -  Stop RPC only (Daemon).'
  Write-Host '13 -  Start Dashboard -> Browser.'
  Write-Host '14 -  Exit.'
  Write-Host ''
}

function Show-SourceMenu {
  Show-Header -Clear
  Write-Host 'Which OpenCode plugin copy should be loaded?'
  Write-Host ''
  Write-Host ' C -  Local source (C: working copy)'
  Write-Host ' D -  Mirror (D: git copy)'
  Write-Host ' P -  Custom absolute path...'
  Write-Host ' S -  Show current registration'
  Write-Host ' 0 -  Back'
  Write-Host ''
}

function Show-ModelMenu {
  Show-Header -Clear
  Write-Host 'Displayed model on Discord'
  Write-Host ''
  Write-Host ' 1 -  GPT Sol'
  Write-Host ' 2 -  GPT Luna'
  Write-Host ' 3 -  GPT Astra'
  Write-Host ' 4 -  Claude Opus'
  Write-Host ' 5 -  Claude Sonnet'
  Write-Host ' 6 -  Claude Haiku'
  Write-Host ' 7 -  Claude Fable'
  Write-Host ' 8 -  Real model (privacy off)'
  Write-Host ' 9 -  Custom label...'
  Write-Host ' 0 -  Back'
  Write-Host ''
}

function Show-MetricMenu {
  Show-Header -Clear
  Write-Host 'What should Discord show?'
  Write-Host ''
  Write-Host ' 1 -  Tokens           -> 46.63M tokens'
  Write-Host ' 2 -  Estimated cost   -> ~$0.42'
  Write-Host ' 3 -  Both             -> 46.63M tokens, ~$0.42'
  Write-Host ' 0 -  Back'
  Write-Host ''
}

function Open-Dashboard {
  Invoke-Rpc @('dashboard-start')
  $url = "http://127.0.0.1:$DashboardPort"
  if (Test-Dashboard) {
    Start-Process $url | Out-Null
    Write-Host "Dashboard: $url" -ForegroundColor Green
  } else {
    Write-Host "Dashboard did not start on $url" -ForegroundColor Red
    Write-Host "Start it manually with: node bin\clawstly-oc-rpc.js serve" -ForegroundColor Yellow
  }
}

function Invoke-SourceChoice {
  Show-SourceMenu
  $choice = (Read-Host 'Choice').Trim().ToUpperInvariant()
  switch ($choice) {
    'C' { Invoke-Rpc @('source', 'C'); Wait-ForUser }
    'D' { Invoke-Rpc @('source', 'D'); Wait-ForUser }
    'S' { Invoke-Rpc @('source', 'status'); Wait-ForUser }
    'P' {
      $path = Read-Host 'Absolute plugin directory'
      if ($path.Trim()) { Invoke-Rpc @('source', $path.Trim()) }
      Wait-ForUser
    }
    '0' { }
    default { Write-Host 'Unknown choice.' -ForegroundColor Yellow; Wait-ForUser }
  }
}

function Invoke-ModelChoice {
  Show-ModelMenu
  $choice = Read-Host 'Choice'
  $map = @{
    '1' = 'sol'; '2' = 'luna'; '3' = 'astra'; '4' = 'opus';
    '5' = 'sonnet'; '6' = 'haiku'; '7' = 'fable'; '8' = 'real'
  }
  if ($map.ContainsKey($choice)) {
    Invoke-Rpc @('model', $map[$choice])
    Wait-ForUser
    return
  }
  if ($choice -eq '9') {
    $label = Read-Host 'Model label'
    if ($label.Trim()) {
      Invoke-Rpc @('model', $label)
      Wait-ForUser
    }
    return
  }
  if ($choice -ne '0') {
    Write-Host 'Unknown choice.' -ForegroundColor Yellow
    Wait-ForUser
  }
}

function Invoke-MetricChoice {
  Show-MetricMenu
  $choice = Read-Host 'Choice'
  $map = @{ '1' = 'tokens'; '2' = 'cost'; '3' = 'both' }
  if ($map.ContainsKey($choice)) {
    Invoke-Rpc @('metric', $map[$choice])
    Wait-ForUser
    return
  }
  if ($choice -ne '0' -and $choice -ne '') {
    Write-Host 'Unknown choice.' -ForegroundColor Yellow
    Wait-ForUser
  }
}

# Direct arguments (run.cmd model sol) skip the interactive menu.
if ($args.Count -gt 0) {
  $action = $args[0].ToLowerInvariant()
  $rest = @($args | Select-Object -Skip 1)
  switch ($action) {
    'start-all'     { Invoke-Rpc @('start-all'); exit $RpcExitCode }
    'stop-all'      { Invoke-Rpc @('stop-all'); exit $RpcExitCode }
    'restart-all'   { Invoke-Rpc @('restart-all'); exit $RpcExitCode }
    'restart-rpc'   { Invoke-Rpc @('restart'); exit $RpcExitCode }
    'start'         { Invoke-Rpc @('start'); exit $RpcExitCode }
    'stop'          { Invoke-Rpc @('stop'); exit $RpcExitCode }
    'restart'       { Invoke-Rpc @('restart'); exit $RpcExitCode }
    'source'        { Invoke-Rpc (@('source') + $rest); exit $RpcExitCode }
    'status'        { Invoke-Rpc @('status'); exit $RpcExitCode }
    'doctor'        { Invoke-Rpc @('doctor'); exit $RpcExitCode }
    'dashboard'     { Open-Dashboard; exit 0 }
    'dashboard-start' { Invoke-Rpc @('dashboard-start'); exit $RpcExitCode }
    'dashboard-stop'  { Invoke-Rpc @('dashboard-stop'); exit $RpcExitCode }
    'dashboard-status' { Invoke-Rpc @('dashboard-status'); exit $RpcExitCode }
    'model'         { Invoke-Rpc (@('model') + $rest); exit $RpcExitCode }
    'metric'        { Invoke-Rpc (@('metric') + $rest); exit $RpcExitCode }
    default {
      Write-Host "Unknown action: $action" -ForegroundColor Red
      Write-Host 'start-all | stop-all | restart-all | restart-rpc | start | stop | source | dashboard | dashboard-start | dashboard-stop | dashboard-status | status | doctor | model | metric'
      exit 1
    }
  }
}

while ($true) {
  Show-MainMenu
  $choice = (Read-Host 'Choice').Trim()
  switch ($choice) {
    '1'  { Invoke-Rpc @('start-all'); Wait-ForUser }
    '2'  { Invoke-Rpc @('stop-all'); Wait-ForUser }
    '3'  { Invoke-Rpc @('restart-all'); Wait-ForUser }
    '4'  { Invoke-Rpc @('restart'); Wait-ForUser }
    '5'  { Invoke-SourceChoice }
    '6'  { Open-Dashboard; Wait-ForUser }
    '7'  { Invoke-Rpc @('status'); Wait-ForUser }
    '8'  { Invoke-Rpc @('doctor'); Wait-ForUser }
    '9'  { Invoke-ModelChoice }
    '10' { Invoke-MetricChoice }
    '11' { Invoke-Rpc @('start'); Wait-ForUser }
    '12' { Invoke-Rpc @('stop'); Wait-ForUser }
    '13' { Open-Dashboard; Wait-ForUser }
    '14' { exit 0 }
    default { Write-Host 'Unknown choice.' -ForegroundColor Yellow; Wait-ForUser }
  }
}
