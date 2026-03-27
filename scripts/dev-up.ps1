. "$PSScriptRoot/dev-common.ps1"

Ensure-S2GDirectories
Require-File $script:EnvExample
Copy-EnvIfNeeded
Import-S2GEnvFile

Require-Command "pnpm"
Require-Command "cmd.exe"
Require-File $script:VenvPython
Require-File $script:VenvAlembic
Require-File $script:VenvUvicorn
Require-File (Join-Path $script:RootDir "package.json")

Ensure-Postgres
if ((Get-S2GFlag -Name "S2G_START_DB" -Default "1") -or (Test-TcpPort -Host "127.0.0.1" -Port 5432)) {
  Invoke-S2GMigrations
}

Start-ManagedService `
  -Name "API" `
  -PidFile (Join-Path $script:RunDir "api.pid") `
  -LogFile (Join-Path $script:LogDir "api.log") `
  -ReadinessKind "http" `
  -ReadinessTarget "http://127.0.0.1:8000/api/health" `
  -CommandLine "set PYTHONPATH=apps/api&& `"$($script:VenvUvicorn)`" app.main:app --app-dir apps/api --host 127.0.0.1 --port 8000"

if (Get-S2GFlag -Name "S2G_START_WORKER" -Default "1") {
  Start-ManagedService `
    -Name "worker" `
    -PidFile (Join-Path $script:RunDir "worker.pid") `
    -LogFile (Join-Path $script:LogDir "worker.log") `
    -ReadinessKind "process" `
    -ReadinessTarget "" `
    -CommandLine "set PYTHONPATH=apps/api&& `"$($script:VenvPython)`" -m app.worker"
} else {
  Write-Host "Skipping worker because S2G_START_WORKER=0"
}

Start-ManagedService `
  -Name "web" `
  -PidFile (Join-Path $script:RunDir "web.pid") `
  -LogFile (Join-Path $script:LogDir "web.log") `
  -ReadinessKind "http" `
  -ReadinessTarget "http://127.0.0.1:3000" `
  -CommandLine "pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port 3000"

if (Get-S2GFlag -Name "S2G_START_AUDIO_HELPER" -Default "1") {
  Start-ManagedService `
    -Name "audio-helper" `
    -PidFile (Join-Path $script:RunDir "audio-helper.pid") `
    -LogFile (Join-Path $script:LogDir "audio-helper.log") `
    -ReadinessKind "http" `
    -ReadinessTarget "http://127.0.0.1:8765/health" `
    -CommandLine "set PYTHONPATH=apps/audio-helper&& `"$($script:VenvUvicorn)`" audio_helper.main:app --app-dir apps/audio-helper --host 127.0.0.1 --port 8765"
} else {
  Write-Host "Skipping audio-helper because S2G_START_AUDIO_HELPER=0"
}

Write-Host ""
Write-Host "Development platform is up:"
Write-Host "  Web:    http://127.0.0.1:3000"
Write-Host "  API:    http://127.0.0.1:8000"
Write-Host "  Health: http://127.0.0.1:8000/api/health"
if (Get-S2GFlag -Name "S2G_START_AUDIO_HELPER" -Default "1") {
  Write-Host "  Audio:  http://127.0.0.1:8765/health"
}
Write-Host ""
Write-Host "Logs:"
Write-Host "  $($script:LogDir)\api.log"
Write-Host "  $($script:LogDir)\web.log"
if (Get-S2GFlag -Name "S2G_START_WORKER" -Default "1") {
  Write-Host "  $($script:LogDir)\worker.log"
}
if (Get-S2GFlag -Name "S2G_START_AUDIO_HELPER" -Default "1") {
  Write-Host "  $($script:LogDir)\audio-helper.log"
}
Write-Host ""
Write-Host "Manage processes:"
Write-Host "  pnpm dev:status:win"
Write-Host "  pnpm dev:restart:win"
Write-Host "  pnpm dev:down:win"
