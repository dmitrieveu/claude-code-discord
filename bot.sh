#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.bot-data"
PID_FILE="$DATA_DIR/bot.pid"
LOG_FILE="$DATA_DIR/bot.log"

mkdir -p "$DATA_DIR"

# Find a running bot process — checks PID file first, then falls back to pgrep
# Sets FOUND_PID as a side effect
find_bot_pid() {
  FOUND_PID=""

  # Check PID file first
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(<"$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      FOUND_PID="$pid"
      return 0
    fi
    # Stale PID file
    rm -f "$PID_FILE"
  fi

  # Fall back to pgrep — catches bots started via `deno task start` or other means
  local pid
  pid=$(pgrep -f "deno.+index\\.ts" 2>/dev/null | head -1) || true
  if [[ -n "$pid" ]]; then
    FOUND_PID="$pid"
    return 0
  fi

  return 1
}

is_running() {
  find_bot_pid
}

do_start() {
  if is_running; then
    echo "Bot is already running (PID $FOUND_PID)"
    exit 1
  fi

  echo "Starting bot..."
  nohup deno run --allow-all "$SCRIPT_DIR/index.ts" "$@" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "Bot started (PID $pid), logging to $LOG_FILE"
}

do_stop() {
  if ! is_running; then
    echo "Bot is not running"
    return 0
  fi

  local pid="$FOUND_PID"
  echo "Stopping bot (PID $pid)..."
  kill "$pid"

  # Wait up to 10 seconds for graceful shutdown
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < 10 )); do
    sleep 1
    (( waited++ ))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "Bot did not exit gracefully, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi

  rm -f "$PID_FILE"
  echo "Bot stopped"
}

do_restart() {
  do_stop
  do_start "$@"
}

do_status() {
  if is_running; then
    echo "Bot is running (PID $FOUND_PID)"
  else
    echo "Bot is not running"
  fi
}

case "${1:-}" in
  start)
    shift
    do_start "$@"
    ;;
  stop)
    do_stop
    ;;
  restart)
    shift
    do_restart "$@"
    ;;
  status)
    do_status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status} [-- extra args]"
    exit 1
    ;;
esac
