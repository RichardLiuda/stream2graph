#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/var/log"
RUN_DIR="$ROOT_DIR/var/run"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
# Detect virtualenv path based on platform
if [[ -d "$ROOT_DIR/.venv-platform/Scripts" ]]; then
  VENV_BIN="$ROOT_DIR/.venv-platform/Scripts"
else
  VENV_BIN="$ROOT_DIR/.venv-platform/bin"
fi
VENV_PYTHON="$VENV_BIN/python"
VENV_ALEMBIC="$VENV_BIN/alembic"
VENV_UVICORN="$VENV_BIN/uvicorn"
START_WORKER="${S2G_START_WORKER:-1}"
START_AUDIO_HELPER="${S2G_START_AUDIO_HELPER:-1}"
START_DB="${S2G_START_DB:-1}"

mkdir -p "$LOG_DIR" "$RUN_DIR"

copy_env_if_needed() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "Created .env from .env.example"
  fi
}

load_env() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi

    if [[ "$line" != *=* ]]; then
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"

    if [[ "$value" =~ ^\".*\"$ ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done <"$ENV_FILE"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1" >&2
    exit 1
  fi
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local label="$3"
  local wait_seconds="${4:-30}"
  local elapsed=0

  while (( elapsed < wait_seconds )); do
    if python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect((host, port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
    then
      echo "$label is ready on $host:$port"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "$label did not become ready on $host:$port within ${wait_seconds}s." >&2
  return 1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local wait_seconds="${3:-40}"
  local elapsed=0

  while (( elapsed < wait_seconds )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$label is ready at $url"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "$label did not become ready at $url within ${wait_seconds}s." >&2
  return 1
}

docker_ready() {
  docker info >/dev/null 2>&1
}

start_docker_desktop() {
  if docker_ready; then
    return 0
  fi

  if [[ -d /Applications/Docker.app ]]; then
    echo "Starting Docker Desktop..."
    open -a /Applications/Docker.app
  elif [[ -d "$HOME/Applications/Docker.app" ]]; then
    echo "Starting Docker Desktop..."
    open -a "$HOME/Applications/Docker.app"
  else
    echo "Docker CLI exists, but Docker Desktop.app was not found." >&2
    return 1
  fi

  local wait_seconds=90
  local elapsed=0
  while (( elapsed < wait_seconds )); do
    if docker_ready; then
      echo "Docker Desktop is ready"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo "Docker Desktop did not become ready within ${wait_seconds}s." >&2
  return 1
}

is_running_from_pid() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    rm -f "$pid_file"
  fi
  return 1
}

start_service() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  local readiness_kind="$4"
  local readiness_target="$5"
  shift 5

  if is_running_from_pid "$pid_file"; then
    echo "$name already running (pid $(cat "$pid_file"))"
    return 0
  fi

  : >"$log_file"
  local pid
  pid="$(
    python3 - "$log_file" "$ROOT_DIR" "$@" <<'PY'
import subprocess
import sys

log_path = sys.argv[1]
cwd = sys.argv[2]
cmd = sys.argv[3:]

with open(log_path, "ab", buffering=0) as handle:
    process = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    print(process.pid)
PY
  )"
  echo "$pid" >"$pid_file"
  echo "Starting $name (pid $pid)"

  if [[ "$readiness_kind" == "http" ]]; then
    if ! wait_for_http "$readiness_target" "$name"; then
      echo "$name failed to start. Recent log output:" >&2
      tail -n 40 "$log_file" >&2 || true
      return 1
    fi
  elif [[ "$readiness_kind" == "port" ]]; then
    local host="${readiness_target%:*}"
    local port="${readiness_target##*:}"
    if ! wait_for_port "$host" "$port" "$name"; then
      echo "$name failed to start. Recent log output:" >&2
      tail -n 40 "$log_file" >&2 || true
      return 1
    fi
  else
    sleep 2
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "$name exited early. Recent log output:" >&2
      tail -n 40 "$log_file" >&2 || true
      return 1
    fi
    echo "$name is running (pid $pid)"
  fi
}

ensure_postgres() {
  if [[ "$START_DB" == "0" ]]; then
    echo "Skipping PostgreSQL startup because S2G_START_DB=0"
    return 0
  fi

  if lsof -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "PostgreSQL already listening on 5432"
    return 0
  fi

  if command -v docker >/dev/null 2>&1; then
    start_docker_desktop || {
      echo "Please start Docker Desktop (or your local PostgreSQL) first, then rerun ./scripts/dev-up.sh." >&2
      exit 1
    }
    echo "Starting PostgreSQL with docker compose..."
    if (cd "$ROOT_DIR" && docker compose -f docker-compose.platform.yml up -d); then
      return 0
    fi

    echo >&2
    echo "Docker is installed, but PostgreSQL did not start." >&2
    echo "If you plan to use Docker, please start Docker Desktop (or the Docker daemon) first." >&2
    echo "If you already have a local PostgreSQL on port 5432, start it and rerun ./scripts/dev-up.sh." >&2
    exit 1
  fi

  echo "PostgreSQL is not listening on 5432, and Docker is not available." >&2
  echo "Please start your local PostgreSQL first, then rerun ./scripts/dev-up.sh" >&2
  exit 1
}

run_migrations() {
  echo "Running database migrations..."
  (cd "$ROOT_DIR" && PYTHONPATH=apps/api "$VENV_ALEMBIC" -c apps/api/alembic.ini upgrade head)
}

print_summary() {
  echo
  echo "Development platform is up (listening on 0.0.0.0 — reachable from LAN):"
  echo "  Web:    http://127.0.0.1:3000  (same host: use your LAN IP for phones/tablets)"
  echo "  API:    http://127.0.0.1:8000"
  echo "  Health: http://127.0.0.1:8000/api/health"
  if [[ "$START_AUDIO_HELPER" != "0" ]]; then
    echo "  Audio:  http://127.0.0.1:8765/health"
  fi
  echo
  echo "Logs:"
  echo "  $LOG_DIR/api.log"
  echo "  $LOG_DIR/web.log"
  if [[ "$START_WORKER" != "0" ]]; then
    echo "  $LOG_DIR/worker.log"
  fi
  if [[ "$START_AUDIO_HELPER" != "0" ]]; then
    echo "  $LOG_DIR/audio-helper.log"
  fi
  echo
  echo "Manage processes:"
  echo "  pnpm dev:status"
  echo "  pnpm dev:restart"
  echo "  pnpm dev:down"
}

main() {
  require_file "$ENV_EXAMPLE"
  copy_env_if_needed
  load_env
  cd "$ROOT_DIR"

  require_command pnpm
  require_command python3
  require_command curl
  require_file "$VENV_PYTHON"
  require_file "$VENV_ALEMBIC"
  require_file "$VENV_UVICORN"
  require_file "$ROOT_DIR/package.json"

  ensure_postgres
  if [[ "$START_DB" != "0" ]] || lsof -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1; then
    run_migrations
  fi

  start_service \
    "API" \
    "$RUN_DIR/api.pid" \
    "$LOG_DIR/api.log" \
    "http" \
    "http://127.0.0.1:8000/api/health" \
    env PYTHONPATH=apps/api "$VENV_PYTHON" -m uvicorn app.main:app --app-dir apps/api --host 0.0.0.0 --port 8000

  if [[ "$START_WORKER" != "0" ]]; then
    start_service \
      "worker" \
      "$RUN_DIR/worker.pid" \
      "$LOG_DIR/worker.log" \
      "process" \
      "" \
      env PYTHONPATH=apps/api "$VENV_PYTHON" -m app.worker
  else
    echo "Skipping worker because S2G_START_WORKER=0"
  fi

  start_service \
    "web" \
    "$RUN_DIR/web.pid" \
    "$LOG_DIR/web.log" \
    "http" \
    "http://127.0.0.1:3000" \
    pnpm --dir apps/web exec next dev --hostname 0.0.0.0 --port 3000

  if [[ "$START_AUDIO_HELPER" != "0" ]]; then
    start_service \
      "audio-helper" \
      "$RUN_DIR/audio-helper.pid" \
      "$LOG_DIR/audio-helper.log" \
      "http" \
      "http://127.0.0.1:8765/health" \
      env PYTHONPATH=apps/audio-helper "$VENV_PYTHON" -m uvicorn audio_helper.main:app --app-dir apps/audio-helper --host 0.0.0.0 --port 8765
  else
    echo "Skipping audio-helper because S2G_START_AUDIO_HELPER=0"
  fi

  print_summary
}

main "$@"
