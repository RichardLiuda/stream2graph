#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/var/run"

print_service_status() {
  local name="$1"
  local pid_file="$2"
  local extra_status="${3:-}"
  local http_ok="false"
  if [[ "$extra_status" == "http ok" ]]; then
    http_ok="true"
  fi

  if [[ ! -f "$pid_file" ]]; then
    if [[ "$http_ok" == "true" ]]; then
      printf "%-12s %s (%s)\n" "$name" "running (external)" "$extra_status"
    elif [[ -n "$extra_status" ]]; then
      printf "%-12s %s (%s)\n" "$name" "stopped" "$extra_status"
    else
      printf "%-12s %s\n" "$name" "stopped"
    fi
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    if [[ -n "$extra_status" ]]; then
      printf "%-12s %s (%s)\n" "$name" "running (pid $pid)" "$extra_status"
    else
      printf "%-12s %s\n" "$name" "running (pid $pid)"
    fi
  else
    if [[ "$http_ok" == "true" ]]; then
      printf "%-12s %s (%s)\n" "$name" "running (pid file stale)" "$extra_status"
    elif [[ -n "$extra_status" ]]; then
      printf "%-12s %s (%s)\n" "$name" "stale pid file" "$extra_status"
    else
      printf "%-12s %s\n" "$name" "stale pid file"
    fi
  fi
}

port_status() {
  local port="$1"
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port open"
  else
    echo "port $port closed"
  fi
}

http_status() {
  local url="$1"
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "http ok"
  else
    echo "http down"
  fi
}

main() {
  print_service_status "api" "$RUN_DIR/api.pid" "$(http_status "http://127.0.0.1:8000/api/health")"
  print_service_status "worker" "$RUN_DIR/worker.pid"
  print_service_status "web" "$RUN_DIR/web.pid" "$(http_status "http://127.0.0.1:3000")"
  print_service_status "audio-helper" "$RUN_DIR/audio-helper.pid" "$(http_status "http://127.0.0.1:8765/health")"

  if lsof -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1; then
    printf "%-12s %s\n" "postgres" "listening on 5432"
  else
    printf "%-12s %s\n" "postgres" "not listening on 5432"
  fi
}

main "$@"
