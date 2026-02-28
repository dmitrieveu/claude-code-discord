#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.bot-data"
PID_FILE="$DATA_DIR/bot.pid"
LOG_FILE="$DATA_DIR/bot.log"

mkdir -p "$DATA_DIR"

# Detect if we're running in orchestrator mode (WORK_DIRS is set)
is_orchestrator_mode() {
  [[ -n "${WORK_DIRS:-}" ]] || grep -q "WORK_DIRS=" "$SCRIPT_DIR/.env" 2>/dev/null
}

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

  # Fall back to pgrep
  local pid=""
  if is_orchestrator_mode; then
    # In orchestrator mode, look for the main orchestrator process
    # It's the deno process that has other deno processes as children
    local all_pids=$(pgrep -f "deno.+index\\.ts" 2>/dev/null || true)
    
    if [[ -n "$all_pids" ]]; then
      # If we have multiple processes, find the parent (orchestrator)
      # by checking which one has the others as children
      local pid_count=$(echo "$all_pids" | wc -l | tr -d ' ')
      
      if [[ "$pid_count" -gt 1 ]]; then
        # Multiple processes - find the parent
        for p in $all_pids; do
          # Check if this process has any of the other pids as children
          local has_children=false
          for other_p in $all_pids; do
            if [[ "$p" != "$other_p" ]]; then
              local ppid=$(ps -o ppid= -p "$other_p" 2>/dev/null | tr -d ' ')
              if [[ "$ppid" == "$p" ]]; then
                has_children=true
                break
              fi
            fi
          done
          
          if [[ "$has_children" == true ]]; then
            pid="$p"
            break
          fi
        done
      else
        # Only one process - that's our bot
        pid="$all_pids"
      fi
    fi
  else
    # Single bot mode - find any deno process running index.ts
    pid=$(pgrep -f "deno.+index\\.ts" 2>/dev/null | head -1) || true
  fi
  
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

  # Check if we should detach (not already detached)
  if [[ -z "${BOT_DETACHED:-}" ]]; then
    echo "Starting bot (detached)..."
    # Fork ourselves with the detached flag set
    # Use setsid if available (Linux), otherwise just nohup (macOS)
    if command -v setsid >/dev/null 2>&1; then
      BOT_DETACHED=1 setsid nohup "$0" start "$@" >> "$LOG_FILE" 2>&1 &
    else
      BOT_DETACHED=1 nohup "$0" start "$@" >> "$LOG_FILE" 2>&1 &
    fi
    echo "Bot starting in background, logging to $LOG_FILE"
    exit 0
  fi

  # We're now running detached - actually start the bot
  echo "[$(date)] Starting bot process..." >> "$LOG_FILE"
  exec deno run --allow-all "$SCRIPT_DIR/index.ts" "$@"
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
  # Check if we should detach (not already detached)
  if [[ -z "${BOT_DETACHED:-}" ]]; then
    echo "Restarting bot (detached)..."
    # Fork ourselves with the detached flag set
    # Use setsid if available (Linux), otherwise just nohup (macOS)
    if command -v setsid >/dev/null 2>&1; then
      BOT_DETACHED=1 setsid nohup "$0" restart "$@" >> "$LOG_FILE" 2>&1 &
    else
      BOT_DETACHED=1 nohup "$0" restart "$@" >> "$LOG_FILE" 2>&1 &
    fi
    echo "Bot restart initiated, check $LOG_FILE for details"
    exit 0
  fi

  # We're now running detached - perform the actual restart
  echo "[$(date)] Restart initiated..." >> "$LOG_FILE"
  
  # Stop the existing bot if running
  if is_running; then
    local pid="$FOUND_PID"
    echo "[$(date)] Stopping bot (PID $pid)..." >> "$LOG_FILE"
    kill "$pid" 2>/dev/null || true
    
    # Wait for it to stop
    local waited=0
    while kill -0 "$pid" 2>/dev/null && (( waited < 10 )); do
      sleep 1
      (( waited++ ))
    done
    
    if kill -0 "$pid" 2>/dev/null; then
      echo "[$(date)] Bot did not exit gracefully, sending SIGKILL..." >> "$LOG_FILE"
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
    
    rm -f "$PID_FILE"
    echo "[$(date)] Bot stopped" >> "$LOG_FILE"
  fi
  
  # Small delay to ensure clean shutdown
  sleep 1
  
  # Start the new instance
  echo "[$(date)] Starting new bot instance..." >> "$LOG_FILE"
  exec deno run --allow-all "$SCRIPT_DIR/index.ts" "$@"
}

do_status() {
  if is_running; then
    if is_orchestrator_mode; then
      echo "Multi-repo orchestrator is running (PID $FOUND_PID)"
      
      # Show all child bot processes
      local child_pids=$(pgrep -P "$FOUND_PID" -f "deno" 2>/dev/null || true)
      if [[ -n "$child_pids" ]]; then
        echo "Child bot processes:"
        for cpid in $child_pids; do
          # Try to extract WORK_DIR from process command line
          local cmd=$(ps -o args= -p "$cpid" 2>/dev/null | head -1)
          echo "  - PID $cpid: $cmd" | head -c 120
          echo
        done
      fi
    else
      echo "Bot is running (PID $FOUND_PID)"
    fi
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
