#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/var/run"

kill_port_listener() {
  local label="$1"
  local port="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  local pid
  for pid in $pids; do
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done
  echo "Stopped $label listener(s) on port $port"
}

stop_service() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "$name is not running"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    local elapsed=0
    while kill -0 "$pid" >/dev/null 2>&1 && (( elapsed < 8 )); do
      sleep 1
      elapsed=$((elapsed + 1))
    done
    pkill -P "$pid" >/dev/null 2>&1 || true
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "Stopped $name (pid $pid)"
  else
    echo "$name pid file was stale"
  fi

  rm -f "$pid_file"
}

main() {
  stop_service "audio-helper" "$RUN_DIR/audio-helper.pid"
  stop_service "web" "$RUN_DIR/web.pid"
  stop_service "worker" "$RUN_DIR/worker.pid"
  stop_service "API" "$RUN_DIR/api.pid"
  kill_port_listener "audio-helper" 8765
  kill_port_listener "web" 3000
  kill_port_listener "API" 8000

  if [[ "${S2G_STOP_DB:-0}" == "1" ]] && command -v docker >/dev/null 2>&1; then
    (cd "$ROOT_DIR" && docker compose -f docker-compose.platform.yml stop postgres)
    echo "Stopped PostgreSQL container"
  fi
}

main "$@"
