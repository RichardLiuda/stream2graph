. "$PSScriptRoot/dev-common.ps1"

Ensure-S2GDirectories
Stop-ManagedService -Name "audio-helper" -PidFile (Join-Path $script:RunDir "audio-helper.pid")
Stop-ManagedService -Name "web" -PidFile (Join-Path $script:RunDir "web.pid")
Stop-ManagedService -Name "worker" -PidFile (Join-Path $script:RunDir "worker.pid")
Stop-ManagedService -Name "API" -PidFile (Join-Path $script:RunDir "api.pid")

Stop-PortListeners -Label "audio-helper" -Port 8765
Stop-PortListeners -Label "web" -Port 3000
Stop-PortListeners -Label "API" -Port 8000

$shouldStopDb = Get-S2GFlag -Name "S2G_STOP_DB" -Default "0"
if ($shouldStopDb -and (Get-Command docker -ErrorAction SilentlyContinue)) {
  Push-Location $script:RootDir
  try {
    docker compose -f docker-compose.platform.yml stop postgres | Out-Null
    Write-Host "Stopped PostgreSQL container"
  } finally {
    Pop-Location
  }
}
