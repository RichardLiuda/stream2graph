Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:LogDir = Join-Path $script:RootDir "var/log"
$script:RunDir = Join-Path $script:RootDir "var/run"
$script:EnvFile = Join-Path $script:RootDir ".env"
$script:EnvExample = Join-Path $script:RootDir ".env.example"
$script:VenvPython = Join-Path $script:RootDir ".venv-platform/Scripts/python.exe"
$script:VenvAlembic = Join-Path $script:RootDir ".venv-platform/Scripts/alembic.exe"
$script:VenvUvicorn = Join-Path $script:RootDir ".venv-platform/Scripts/uvicorn.exe"
$script:PowerShellExe = (Get-Process -Id $PID).Path

function Ensure-S2GDirectories {
  New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
  New-Item -ItemType Directory -Force -Path $script:RunDir | Out-Null
}

function Copy-EnvIfNeeded {
  if (-not (Test-Path $script:EnvFile)) {
    Copy-Item $script:EnvExample $script:EnvFile
    Write-Host "Created .env from .env.example"
  }
}

function Import-S2GEnvFile {
  Get-Content $script:EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $parts = $line -split "=", 2
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

function Get-S2GFlag([string] $Name, [string] $Default = "1") {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = $Default
  }
  return -not ($value -in @("0", "false", "False", "FALSE"))
}

function Require-Command([string] $Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Require-File([string] $Path) {
  if (-not (Test-Path $Path)) {
    throw "Missing required file: $Path"
  }
}

function Test-TcpPort([string] $Host, [int] $Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Host, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-ForPort([string] $Host, [int] $Port, [string] $Label, [int] $WaitSeconds = 30) {
  for ($i = 0; $i -lt $WaitSeconds; $i += 1) {
    if (Test-TcpPort -Host $Host -Port $Port) {
      Write-Host "$Label is ready on ${Host}:$Port"
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "$Label did not become ready on ${Host}:$Port within ${WaitSeconds}s."
}

function Test-HttpUrl([string] $Url) {
  try {
    Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-ForHttp([string] $Url, [string] $Label, [int] $WaitSeconds = 40) {
  for ($i = 0; $i -lt $WaitSeconds; $i += 1) {
    if (Test-HttpUrl -Url $Url) {
      Write-Host "$Label is ready at $Url"
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "$Label did not become ready at $Url within ${WaitSeconds}s."
}

function Test-ProcessAlive([int] $Pid) {
  try {
    Get-Process -Id $Pid -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-RunningFromPidFile([string] $PidFile) {
  if (-not (Test-Path $PidFile)) {
    return $false
  }

  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if (-not $raw) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $false
  }

  $pidValue = 0
  if (-not [int]::TryParse($raw, [ref] $pidValue)) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $false
  }

  if (Test-ProcessAlive -Pid $pidValue) {
    return $true
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  return $false
}

function Quote-CmdArgument([string] $Value) {
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Start-ManagedService(
  [string] $Name,
  [string] $PidFile,
  [string] $LogFile,
  [ValidateSet("http", "port", "process")] [string] $ReadinessKind,
  [string] $ReadinessTarget,
  [string] $CommandLine
) {
  if (Test-RunningFromPidFile -PidFile $PidFile) {
    $existingPid = (Get-Content $PidFile | Select-Object -First 1).Trim()
    Write-Host "$Name already running (pid $existingPid)"
    return
  }

  New-Item -ItemType File -Force -Path $LogFile | Out-Null
  $fullCommand = "$CommandLine >> $(Quote-CmdArgument $LogFile) 2>&1"
  $process = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/d", "/c", $fullCommand) `
    -WorkingDirectory $script:RootDir `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path $PidFile -Value $process.Id
  Write-Host "Starting $Name (pid $($process.Id))"

  try {
    switch ($ReadinessKind) {
      "http" {
        Wait-ForHttp -Url $ReadinessTarget -Label $Name
      }
      "port" {
        $parts = $ReadinessTarget -split ":", 2
        Wait-ForPort -Host $parts[0] -Port ([int] $parts[1]) -Label $Name
      }
      default {
        Start-Sleep -Seconds 2
        if (-not (Test-ProcessAlive -Pid $process.Id)) {
          throw "$Name exited early."
        }
        Write-Host "$Name is running (pid $($process.Id))"
      }
    }
  } catch {
    $tail = ""
    if (Test-Path $LogFile) {
      $tail = (Get-Content $LogFile -Tail 40 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    }
    throw "$($_.Exception.Message)`nRecent log output:`n$tail"
  }
}

function Stop-ManagedService([string] $Name, [string] $PidFile) {
  if (-not (Test-Path $PidFile)) {
    Write-Host "$Name is not running"
    return
  }

  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  $pidValue = 0
  if ($raw -and [int]::TryParse($raw, [ref] $pidValue) -and (Test-ProcessAlive -Pid $pidValue)) {
    cmd.exe /d /c "taskkill /PID $pidValue /T /F" | Out-Null
    Write-Host "Stopped $Name (pid $pidValue)"
  } else {
    Write-Host "$Name pid file was stale"
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-PortListenerPids([int] $Port) {
  $pids = @()
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  }

  if (-not $pids -or $pids.Count -eq 0) {
    $pids = netstat -ano |
      Select-String "LISTENING" |
      Select-String ":$Port\s" |
      ForEach-Object {
        $parts = ($_ -replace "\s+", " ").Trim().Split(" ")
        $parts[-1]
      } |
      Select-Object -Unique
  }

  return @($pids | Where-Object { $_ -match '^\d+$' })
}

function Stop-PortListeners([string] $Label, [int] $Port) {
  $pids = Get-PortListenerPids -Port $Port
  if (-not $pids -or $pids.Count -eq 0) {
    return
  }

  foreach ($pidValue in $pids) {
    cmd.exe /d /c "taskkill /PID $pidValue /T /F" | Out-Null
  }
  Write-Host "Stopped $Label listener(s) on port $Port"
}

function Ensure-Postgres {
  if (-not (Get-S2GFlag -Name "S2G_START_DB" -Default "1")) {
    Write-Host "Skipping PostgreSQL startup because S2G_START_DB=0"
    return
  }

  if (Test-TcpPort -Host "127.0.0.1" -Port 5432) {
    Write-Host "PostgreSQL already listening on 5432"
    return
  }

  if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "Starting PostgreSQL with docker compose..."
    Push-Location $script:RootDir
    try {
      docker compose -f docker-compose.platform.yml up -d
    } finally {
      Pop-Location
    }
    return
  }

  throw "PostgreSQL is not listening on 5432, and Docker is not available. Please start your local PostgreSQL first."
}

function Invoke-S2GMigrations {
  Write-Host "Running database migrations..."
  $previous = [Environment]::GetEnvironmentVariable("PYTHONPATH", "Process")
  [Environment]::SetEnvironmentVariable("PYTHONPATH", "apps/api", "Process")
  Push-Location $script:RootDir
  try {
    & $script:VenvAlembic -c "apps/api/alembic.ini" upgrade head
  } finally {
    [Environment]::SetEnvironmentVariable("PYTHONPATH", $previous, "Process")
    Pop-Location
  }
}

function Get-HttpStatusText([string] $Url) {
  if (Test-HttpUrl -Url $Url) {
    return "http ok"
  }
  return "http down"
}

function Write-ServiceStatus([string] $Name, [string] $PidFile, [string] $ExtraStatus = "") {
  $httpOk = $ExtraStatus -eq "http ok"
  if (-not (Test-Path $PidFile)) {
    if ($httpOk) {
      "{0,-12} {1}" -f $Name, "running (external, $ExtraStatus)" | Write-Host
    } elseif ($ExtraStatus) {
      "{0,-12} {1}" -f $Name, "stopped ($ExtraStatus)" | Write-Host
    } else {
      "{0,-12} {1}" -f $Name, "stopped" | Write-Host
    }
    return
  }

  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  $pidValue = 0
  if ($raw -and [int]::TryParse($raw, [ref] $pidValue) -and (Test-ProcessAlive -Pid $pidValue)) {
    if ($ExtraStatus) {
      "{0,-12} {1}" -f $Name, "running (pid $pidValue, $ExtraStatus)" | Write-Host
    } else {
      "{0,-12} {1}" -f $Name, "running (pid $pidValue)" | Write-Host
    }
    return
  }

  if ($httpOk) {
    "{0,-12} {1}" -f $Name, "running (pid file stale, $ExtraStatus)" | Write-Host
  } elseif ($ExtraStatus) {
    "{0,-12} {1}" -f $Name, "stale pid file ($ExtraStatus)" | Write-Host
  } else {
    "{0,-12} {1}" -f $Name, "stale pid file" | Write-Host
  }
}
