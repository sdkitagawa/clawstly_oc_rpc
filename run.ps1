# Clawstly — easy RPC control.
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

function Show-Header {
  param([switch]$Clear)
  if ($Clear) { try { Clear-Host } catch { } }
  $cfg = Get-RpcConfig
  $pidText = Get-DaemonPid
  if (-not $pidText) { $pidText = 'stopped' }
  $model = if ($cfg.displayModel) { $cfg.displayModel } else { 'real model' }
  $app = if ($cfg.appName) { $cfg.appName } else { $AppName }

  $label = "$AppName - RPC control"
  $inner = 48
  $pad = [Math]::Max(0, $inner - $label.Length)
  $left = [int][Math]::Ceiling($pad / 2.0)
  $right = $pad - $left
  Write-Host ('+' + ('-' * $inner) + '+') -ForegroundColor DarkCyan
  Write-Host ('|' + (' ' * $left) + $label + (' ' * $right) + '|') -ForegroundColor Cyan
  Write-Host ('+' + ('-' * $inner) + '+') -ForegroundColor DarkCyan
  Write-Host ''
  Write-Host (" Daemon : {0}" -f $pidText)
  Write-Host (" App    : {0}" -f $app)
  Write-Host (" Model  : {0}" -f $model)
  Write-Host (" Metric : {0}" -f $cfg.displayMetric)
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
  Write-Host ' 1  Start RPC'
  Write-Host ' 2  Stop RPC'
  Write-Host ' 3  Restart RPC'
  Write-Host ' 4  Status'
  Write-Host ' 5  Health check'
  Write-Host ' 6  Open dashboard'
  Write-Host ' 7  Change displayed model'
  Write-Host ' 8  Token / cost display'
  Write-Host ' 9  Exit'
  Write-Host ''
}

function Show-ModelMenu {
  Show-Header -Clear
  Write-Host 'Displayed model on Discord'
  Write-Host ''
  Write-Host ' 1  GPT Sol'
  Write-Host ' 2  GPT Luna'
  Write-Host ' 3  GPT Astra'
  Write-Host ' 4  Claude Opus'
  Write-Host ' 5  Claude Sonnet'
  Write-Host ' 6  Claude Haiku'
  Write-Host ' 7  Claude Fable'
  Write-Host ' 8  Real model (privacy off)'
  Write-Host ' 9  Custom label...'
  Write-Host ' 0  Back'
  Write-Host ''
}

function Show-MetricMenu {
  Show-Header -Clear
  Write-Host 'What should Discord show?'
  Write-Host ''
  Write-Host ' 1  Tokens           -> 46.63M tokens'
  Write-Host ' 2  Estimated cost   -> ~$0.42'
  Write-Host ' 3  Both             -> 46.63M tokens, ~$0.42'
  Write-Host ' 0  Back'
  Write-Host ''
}

function Test-Dashboard {
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$DashboardPort/api/settings" -TimeoutSec 2 -ErrorAction Stop
    return $res.StatusCode -eq 200
  } catch { return $false }
}

function Start-Dashboard {
  $url = "http://127.0.0.1:$DashboardPort"
  if (-not (Test-Dashboard)) {
    $old = $env:CLAWSTLY_RPC_NO_OPEN
    $env:CLAWSTLY_RPC_NO_OPEN = '1'
    try {
      # Start-Process joins ArgumentList with spaces. The CLI path has spaces
      # (C:\Users\Douglas Kitagawa\...), so it must be quoted or Node exits.
      $quotedCli = '"' + $Cli + '"'
      Start-Process -FilePath $Node -ArgumentList @($quotedCli, 'serve') -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
    } finally {
      if ($null -eq $old) { Remove-Item Env:CLAWSTLY_RPC_NO_OPEN -ErrorAction SilentlyContinue }
      else { $env:CLAWSTLY_RPC_NO_OPEN = $old }
    }
    for ($i = 0; $i -lt 20; $i++) {
      if (Test-Dashboard) { break }
      Start-Sleep -Milliseconds 250
    }
  }

  if (Test-Dashboard) {
    Start-Process $url | Out-Null
    Write-Host "Dashboard: $url" -ForegroundColor Green
  } else {
    Write-Host "Dashboard did not start on $url" -ForegroundColor Red
    Write-Host "Start it manually with: node bin\clawstly-oc-rpc.js serve" -ForegroundColor Yellow
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
    'start'   { Invoke-Rpc @('start'); exit $RpcExitCode }
    'stop'    { Invoke-Rpc @('stop'); exit $RpcExitCode }
    'restart' { Invoke-Rpc @('restart'); exit $RpcExitCode }
    'status'  { Invoke-Rpc @('status'); exit $RpcExitCode }
    'doctor'  { Invoke-Rpc @('doctor'); exit $RpcExitCode }
    'dashboard' { Start-Dashboard; exit 0 }
    'model'   { Invoke-Rpc (@('model') + $rest); exit $RpcExitCode }
    'metric'  { Invoke-Rpc (@('metric') + $rest); exit $RpcExitCode }
    default {
      Write-Host "Unknown action: $action" -ForegroundColor Red
      Write-Host 'start | stop | restart | status | doctor | dashboard | model | metric'
      exit 1
    }
  }
}

while ($true) {
  Show-MainMenu
  $choice = Read-Host 'Choice'
  switch ($choice) {
    '1' { Invoke-Rpc @('start'); Wait-ForUser }
    '2' { Invoke-Rpc @('stop'); Wait-ForUser }
    '3' { Invoke-Rpc @('restart'); Wait-ForUser }
    '4' { Invoke-Rpc @('status'); Wait-ForUser }
    '5' { Invoke-Rpc @('doctor'); Wait-ForUser }
    '6' { Start-Dashboard; Wait-ForUser }
    '7' { Invoke-ModelChoice }
    '8' { Invoke-MetricChoice }
    '9' { exit 0 }
    default { Write-Host 'Unknown choice.' -ForegroundColor Yellow; Wait-ForUser }
  }
}
