#!/bin/bash
set -uo pipefail

log() {
  echo "[init-security] $*" >&2
}

find_entrypoint() {
  if [[ -n "${WAZUH_INDEXER_ENTRYPOINT:-}" && -x "$WAZUH_INDEXER_ENTRYPOINT" ]]; then
    log "Using entrypoint from WAZUH_INDEXER_ENTRYPOINT=$WAZUH_INDEXER_ENTRYPOINT"
    echo "$WAZUH_INDEXER_ENTRYPOINT"
    return 0
  fi
  local candidates=(
    "/entrypoint.sh"
    "/docker-entrypoint.sh"
    "/usr/local/bin/docker-entrypoint.sh"
    "/usr/local/bin/opensearch-docker-entrypoint.sh"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      log "Detected entrypoint at $candidate"
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

exec_as_wazuh() {
  local uid gid
  if id -u wazuh-indexer >/dev/null 2>&1; then
    uid="$(id -u wazuh-indexer)"
    gid="$(id -g wazuh-indexer)"
  else
    uid=1000
    gid=0
  fi

  if command -v gosu >/dev/null 2>&1; then
    gosu "$uid:$gid" "$@"
    return $?
  fi

  if command -v runuser >/dev/null 2>&1; then
    runuser -u "#$uid" -- "$@"
    return $?
  fi

  if command -v chroot >/dev/null 2>&1; then
    chroot --userspec="${uid}:${gid}" / "$@"
    return $?
  fi

  local current_uid current_gid
  current_uid="$(id -u)"
  current_gid="$(id -g)"
  if [[ "$current_uid" -eq "$uid" && "$current_gid" -eq "$gid" ]]; then
    "$@"
    return $?
  fi

  log "Privilege helpers unavailable; running command as current UID ${current_uid} (wanted ${uid})"
  "$@"
}

http_ping() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --max-time 2 -s -o /dev/null "$url"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O - "$url" >/dev/null
    return $?
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 9200
    return $?
  fi
  return 1
}

wait_for_http() {
  local url="$1"
  local attempts="$2"
  local delay="$3"
  local count=0
  log "Waiting for $url (up to $attempts attempts, ${delay}s interval)"
  until http_ping "$url"; do
    count=$((count + 1))
    if [[ $count -ge $attempts ]]; then
      log "Timed out waiting for $url after $attempts attempts"
      return 1
    fi
    log "Endpoint not ready yet (attempt $count/$attempts), sleeping ${delay}s"
    sleep "$delay"
  done
  log "Endpoint $url is reachable"
  return 0
}

run_security_admin_once() {
  local admin_bin="/usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh"
  local config_dir="/usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig"
  local cert_dir="/usr/share/wazuh-indexer/config/certs"
  local marker="/usr/share/wazuh-indexer/data/.security-initialized"

  if [[ -f "$marker" ]]; then
    log "Security configuration already initialized"
    return 0
  fi

  if [[ ! -x "$admin_bin" ]]; then
    log "Security admin tool not found, skipping initialization"
    return 0
  fi

  mkdir -p "$(dirname "$marker")"

  local admin_cmd=(
    "$admin_bin"
    -cd "$config_dir"
    -nhnv
    -icl
    -h "127.0.0.1"
    -p "9200"
  )

  local http_tls_enabled="${OPENSEARCH_SECURITY_SSL_HTTP_ENABLED:-false}"
  if [[ "$http_tls_enabled" == "true" ]]; then
    admin_cmd+=(
      -cacert "$cert_dir/root-ca.pem"
      -cert "$cert_dir/indexer.pem"
      -key "$cert_dir/indexer-key.pem"
    )
  fi

  log "Running securityadmin.sh to initialize OpenSearch security index"
  log "Command: ${admin_cmd[*]}"

  local admin_output exit_code
  if ! admin_output="$(exec_as_wazuh "${admin_cmd[@]}" 2>&1)"; then
    exit_code=$?
    log "securityadmin.sh exited with code $exit_code"
    log "securityadmin.sh output:"
    log "$admin_output"
    return $exit_code
  fi

  log "securityadmin.sh completed successfully"

  touch "$marker"
  log "Security initialization complete; marker written to $marker"
  return 0
}

run_security_admin_with_retry() {
  local attempts="${SECURITYADMIN_MAX_ATTEMPTS:-20}"
  local delay="${SECURITYADMIN_RETRY_DELAY:-5}"
  local count=0
  while true; do
    if run_security_admin_once; then
      return 0
    fi
    count=$((count + 1))
    if [[ $count -ge $attempts ]]; then
      log "securityadmin.sh failed after ${attempts} attempts"
      return 1
    fi
    log "securityadmin.sh failed (attempt $count/$attempts); retrying in ${delay}s"
    sleep "$delay"
  done
}

main() {
  log "Clearing any stale OpenSearch node data"
  rm -rf /var/lib/wazuh-indexer/nodes || true

  local entrypoint
  if ! entrypoint="$(find_entrypoint)"; then
    log "Unable to locate the original entrypoint; exiting"
    exit 1
  fi

  log "Starting original entrypoint: $entrypoint $*"
  "$entrypoint" "$@" &
  SERVER_PID=$!
  log "Original entrypoint running as PID $SERVER_PID"

  terminate() {
    log "Shutdown signal received, forwarding to PID $SERVER_PID"
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      kill -TERM "$SERVER_PID"
      wait "$SERVER_PID"
    fi
    exit 0
  }
  trap terminate SIGTERM SIGINT

  if ! wait_for_http "http://127.0.0.1:9200" 60 5; then
    log "OpenSearch HTTP endpoint did not become reachable in time; continuing with security initialization retries"
  fi

  run_security_admin_with_retry

  log "Proxy entrypoint waiting for PID $SERVER_PID"
  wait "$SERVER_PID"
}

main "$@"
