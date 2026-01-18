#!/bin/bash
set -euo pipefail

log() {
  echo "[bootstrap-security] $*" >&2
}

find_entrypoint() {
  if [[ -n "${WAZUH_INDEXER_ENTRYPOINT:-}" && -x "$WAZUH_INDEXER_ENTRYPOINT" ]]; then
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
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

dump_logs() {
  local candidates=(
    "/usr/share/wazuh-indexer/logs/opensearch.log"
    "/var/log/wazuh-indexer/wazuh-cluster.log"
  )
  for log_file in "${candidates[@]}"; do
    if [[ -f "$log_file" ]]; then
      log "===== ${log_file} (last 200 lines) ====="
      tail -n 200 "$log_file" || true
      log "===== end ${log_file} ====="
      return
    fi
  done
  log "No known OpenSearch log files found (${candidates[*]})"
}

wait_for_https() {
  local host="$1"
  local path="$2"
  local attempts="$3"
  local delay="$4"
  local cert_dir="$5"
  local username="$6"
  local password="$7"
  local server_pid="$8"
  local url="https://${host}${path}"
  for ((i = 1; i <= attempts; i++)); do
    if curl --silent --show-error --cacert "$cert_dir/root-ca.pem" \
      --cert "$cert_dir/indexer.pem" \
      --key "$cert_dir/indexer-key.pem" \
      --user "${username}:${password}" \
      --resolve "${host}:9200:127.0.0.1" \
      --resolve "10.0.0.3:9200:127.0.0.1" \
      "$url" >/dev/null; then
      log "Endpoint $url is reachable"
      return 0
    fi
    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
      log "OpenSearch process $server_pid exited before readiness; dumping logs"
      dump_logs
      return 1
    fi
    log "Endpoint not ready yet (attempt $i/$attempts), sleeping ${delay}s"
    sleep "$delay"
  done
  log "Failed to reach $url after $attempts attempts"
  dump_logs
  return 1
}

run_security_admin() {
  local cert_dir="$1"
  local host="$2"
  local admin_bin="/usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh"
  local config_dir="/usr/share/wazuh-indexer/plugins/opensearch-security/securityconfig"

  if [[ ! -x "$admin_bin" ]]; then
    log "securityadmin.sh not found; cannot bootstrap security index"
    return 1
  fi

  log "Running securityadmin.sh to seed .opendistro_security index"
  /usr/share/wazuh-indexer/jdk/bin/java \
    -Dorg.apache.logging.log4j.simplelog.StatusLogger.level=OFF \
    -cp "/usr/share/wazuh-indexer/plugins/opensearch-security/tools/../*:/usr/share/wazuh-indexer/plugins/opensearch-security/tools/../../../lib/*:/usr/share/wazuh-indexer/plugins/opensearch-security/tools/../deps/*" \
    org.opensearch.security.tools.SecurityAdmin \
    -cd "$config_dir" \
    -nhnv \
    -icl \
    -h "$host" \
    -p "9200" \
    -cacert "$cert_dir/root-ca.pem" \
    -cert "$cert_dir/indexer.pem" \
    -key "$cert_dir/indexer-key.pem"
}

main() {
  local cert_dir="/usr/share/wazuh-indexer/config/certs"
  local marker="/usr/share/wazuh-indexer/data/.security-initialized"
  local https_host="${BOOTSTRAP_TLS_HOST:-indexer01}"
  local security_admin_host="${BOOTSTRAP_SECURITYADMIN_HOST:-127.0.0.1}"
  local admin_user="${OPENSEARCH_INITIAL_ADMIN_USER:-admin}"
  local admin_pass="${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-admin}"
  local server_pid=""

  if [[ -f "$marker" ]]; then
    log "Marker already present, skipping bootstrap"
    exit 0
  fi

  local entrypoint
  if ! entrypoint="$(find_entrypoint)"; then
    log "Unable to locate entrypoint during bootstrap"
    exit 1
  fi

  export OPENSEARCH_INITIAL_ADMIN_PASSWORD="${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-admin}"
  export OPENSEARCH_SECURITY_SSL_HTTP_ENABLED="true"
  export OPENSEARCH_SECURITY_SSL_HTTP_PEMCERT_FILEPATH="/usr/share/wazuh-indexer/config/certs/indexer.pem"
  export OPENSEARCH_SECURITY_SSL_HTTP_PEMKEY_FILEPATH="/usr/share/wazuh-indexer/config/certs/indexer-key.pem"
  export OPENSEARCH_SECURITY_SSL_HTTP_PEMTRUSTEDCAS_FILEPATH="/usr/share/wazuh-indexer/config/certs/root-ca.pem"
  export OPENSEARCH_SECURITY_SSL_TRANSPORT_ENABLED="true"
  export OPENSEARCH_SECURITY_SSL_TRANSPORT_PEMCERT_FILEPATH="/usr/share/wazuh-indexer/config/certs/indexer.pem"
  export OPENSEARCH_SECURITY_SSL_TRANSPORT_PEMKEY_FILEPATH="/usr/share/wazuh-indexer/config/certs/indexer-key.pem"
  export OPENSEARCH_SECURITY_SSL_TRANSPORT_PEMTRUSTEDCAS_FILEPATH="/usr/share/wazuh-indexer/config/certs/root-ca.pem"
  export OPENSEARCH_SECURITY_SSL_TRANSPORT_ENFORCE_HOSTNAME_VERIFICATION="false"
  export OPENSEARCH_SECURITY_ALLOW_UNSAFE_DEFAULTS="true"
  export OPENSEARCH_SECURITY_ALLOW_DEFAULT_INIT_SECURITYINDEX="true"
  export OPENSEARCH_HEAP_SIZE="${BOOTSTRAP_OPENSEARCH_HEAP_SIZE:-320m}"
  export OPENSEARCH_JAVA_OPTS="${BOOTSTRAP_OPENSEARCH_JAVA_OPTS:--Xms320m -Xmx320m -XX:MaxDirectMemorySize=384m -Dopensearch.performance_analyzer.enabled=false}"
  export discovery__type="${discovery__type:-single-node}"
  export network__host="${network__host:-0.0.0.0}"

  "$entrypoint" &
  server_pid=$!
  log "Started bootstrap OpenSearch via $entrypoint (pid $server_pid)"

  trap 'if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then kill "$server_pid" >/dev/null 2>&1 || true; fi' EXIT

  if ! wait_for_https "$https_host" ":9200/_cluster/health?wait_for_status=yellow&timeout=5s" 60 5 "$cert_dir" "$admin_user" "$admin_pass" "$server_pid"; then
    log "OpenSearch failed to become ready during bootstrap; aborting image build"
    exit 1
  fi

  run_security_admin "$cert_dir" "$security_admin_host"

  touch "$marker"
  log "Bootstrap marker written to $marker"

  kill "$server_pid"
  wait "$server_pid" || true
  trap - EXIT
}

main "$@"
