. "$PSScriptRoot/dev-common.ps1"

Ensure-S2GDirectories
Write-ServiceStatus -Name "api" -PidFile (Join-Path $script:RunDir "api.pid") -ExtraStatus (Get-HttpStatusText -Url "http://127.0.0.1:8000/api/health")
Write-ServiceStatus -Name "worker" -PidFile (Join-Path $script:RunDir "worker.pid")
Write-ServiceStatus -Name "web" -PidFile (Join-Path $script:RunDir "web.pid") -ExtraStatus (Get-HttpStatusText -Url "http://127.0.0.1:3000")
Write-ServiceStatus -Name "audio-helper" -PidFile (Join-Path $script:RunDir "audio-helper.pid") -ExtraStatus (Get-HttpStatusText -Url "http://127.0.0.1:8765/health")

if (Test-TcpPort -Host "127.0.0.1" -Port 5432) {
  "{0,-12} {1}" -f "postgres", "listening on 5432" | Write-Host
} else {
  "{0,-12} {1}" -f "postgres", "not listening on 5432" | Write-Host
}
