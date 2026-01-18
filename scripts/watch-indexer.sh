#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-/tmp}"
LOG_FILE="${LOG_DIR%/}/indexer.log"
LAST_ID=""

mkdir -p "$LOG_DIR"

echo "Writing combined indexer logs to $LOG_FILE"

use_ts=false
if command -v ts >/dev/null 2>&1; then
  use_ts=true
fi

prefix_with_timestamp() {
  if $use_ts; then
    ts '[%H:%M:%S]'
  else
    # shellcheck disable=SC2016
    awk '{ cmd="date +%H:%M:%S"; cmd | getline d; close(cmd); printf("[%s] %s\n", d, $0); fflush(); }'
  fi
}

tail_container() {
  local container_id="$1"
  echo "[watch-indexer] Tailing container $container_id"
  docker logs -f "$container_id" 2>&1 | prefix_with_timestamp | tee -a "$LOG_FILE"
}

while true; do
  CURRENT_ID=$(docker ps --format '{{.ID}}\t{{.Names}}' | \
    awk '/IndexerContainer/ {print $1; exit}')

  if [[ -z "$CURRENT_ID" ]]; then
    if [[ "$LAST_ID" != "" ]]; then
      echo "[watch-indexer] Container exited, waiting for next instance..." | tee -a "$LOG_FILE"
      LAST_ID=""
    fi
    sleep 1
    continue
  fi

  if [[ "$CURRENT_ID" == "$LAST_ID" ]]; then
    sleep 1
    continue
  fi

  LAST_ID="$CURRENT_ID"
  tail_container "$CURRENT_ID"
  echo "[watch-indexer] Tail for $CURRENT_ID ended" | tee -a "$LOG_FILE"
  sleep 1

done
