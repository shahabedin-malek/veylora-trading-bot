#!/usr/bin/env bash
# Private AI - Ollama backend selector with Linux failover.
#
# Picks which Ollama endpoint the Linux client should use:
#   1. Windows worker (192.168.15.92:11434) while it answers health checks.
#   2. Local Linux Ollama (127.0.0.1:11434) otherwise - including when the
#      Windows guard has force-stopped the worker because a non-privateai user
#      logged in. The worker then fails the probe, so this fails closed to Linux.
#
# Modes:
#   (no args) / --print   print the active backend, reading cached state
#   --apply               probe now, update cached state + log (timer uses this)
#   --status              print cached state only
#
# Read-only against Windows (one HTTP health probe). Never handles credentials.

set -uo pipefail

WINDOWS_HOST="${WINDOWS_HOST:-192.168.15.92}"
WINDOWS_PORT="${WINDOWS_PORT:-11434}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-11434}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-4}"
STATE_DIR="${STATE_DIR:-$HOME/.cache/private-ai}"
STATE_FILE="$STATE_DIR/ollama_backend"
LOG_FILE="$STATE_DIR/ollama_failover.log"

mkdir -p "$STATE_DIR"

probe() {
  curl -fsS --max-time "$PROBE_TIMEOUT" "http://$1:$2/api/version" >/dev/null 2>&1
}

ensure_local() {
  probe "$LOCAL_HOST" "$LOCAL_PORT" && return 0
  if command -v ollama >/dev/null 2>&1; then
    OLLAMA_HOST="${LOCAL_HOST}:${LOCAL_PORT}" nohup ollama serve >/dev/null 2>&1 &
    for _ in $(seq 1 10); do
      sleep 1
      probe "$LOCAL_HOST" "$LOCAL_PORT" && return 0
    done
  fi
  return 1
}

apply() {
  local chosen note
  if probe "$WINDOWS_HOST" "$WINDOWS_PORT"; then
    chosen="${WINDOWS_HOST}:${WINDOWS_PORT}"
    note="windows healthy"
  else
    ensure_local || true
    chosen="${LOCAL_HOST}:${LOCAL_PORT}"
    note="windows unavailable -> linux fallback"
  fi
  printf '%s\n' "$chosen" >"$STATE_FILE"
  printf '%s %s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$chosen" "$note" >>"$LOG_FILE"
  printf '%s\n' "$chosen"
}

case "${1:-print}" in
  --apply | apply) apply ;;
  --status) cat "$STATE_FILE" 2>/dev/null || echo unknown ;;
  --print | print | "")
    if [ -s "$STATE_FILE" ]; then
      cat "$STATE_FILE"
    else
      apply
    fi
    ;;
  *)
    echo "usage: $0 [--print|--apply|--status]" >&2
    exit 2
    ;;
esac
