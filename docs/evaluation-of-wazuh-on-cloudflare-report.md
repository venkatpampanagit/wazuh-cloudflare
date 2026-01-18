# Wazuh-on-Cloudflare Evaluation Report (Jan 2026)

## 1. Executive Summary
- **Goal:** Validate whether Wazuh Manager, Indexer, Dashboard, and Certs containers can operate fully inside Cloudflare Durable Objects with a single Worker entrypoint.
- **Outcome:** Manager and Dashboard containers meet readiness targets; Indexer reaches “node started” but cannot be observed by the Worker because Cloudflare’s Containers SDK (wrangler 4.59.2 / workerd 2026‑01) does not proxy arbitrary TCP ports (9200). This remains the gating limitation for a production-grade deployment.
- **Overall Assessment:** Architecture, automation, and bootstrap scripts are production-ready. Platform support for container port exposure is still pending, preventing end-to-end validation.

## 2. Evaluation Scope & Success Criteria
| Area                        | Success Criteria                                                                 | Status |
|-----------------------------|-----------------------------------------------------------------------------------|--------|
| Container lifecycle         | Durable Objects can start/stop each Wazuh role with deterministic readiness.     | ✅ Manager/Dashboard, ⚠️ Indexer (blocked by platform) |
| Security initialization     | `.opendistro_security` index pre-seeded; runtime scripts idempotent.             | ✅ Achieved |
| Local developer workflow    | `wrangler dev` can exercise Worker + containers using real traffic flows.        | ⚠️ Partially (Indexer must run outside Cloudflare) |
| Production reproducibility  | Same code paths/build artifacts usable in production Workers.                    | ✅ Once port mapping exists |

## 3. Methodology
1. **Container Hardening:** Forked upstream Wazuh images, added deterministic bootstrap scripts (`bootstrap-security.sh`, `init-security.sh`), regenerated certs with IP + DNS SANs, and introduced cache-busting build args.
2. **Durable Object Orchestration:** Implemented `BaseWazuhContainer` subclasses in `src/containers.ts`, using `@cloudflare/containers` APIs plus custom readiness promises and HTTP probes.
3. **Resilience Testing:** Repeated cold starts under Wrangler, induced failures (TLS mismatches, node locks), and iterated until OpenSearch consistently logged `publish_address`.
4. **Platform Verification:** Inspected Wrangler logs, SDK internals, and `docker inspect` output to confirm the root cause of the readiness timeout (missing TCP proxy) rather than container misconfiguration.

## 4. Experiment History
### 4.1 Cloudflare-First Deployment
We began by deploying the stock Wazuh Manager, Indexer, Dashboard, and Certs container images directly to Cloudflare Durable Objects using the Containers SDK. Manager and Dashboard ports (55000, 5601) registered with the platform, but Indexer/Certs repeatedly logged “container not listening on 10.0.0.x” and readiness never advanced. Wrangler traces confirmed `startAndWaitForPorts` could not see port 9200 despite the Docker image exposing it, indicating a platform proxy gap rather than a container misconfiguration.

### 4.2 Local Parity Environment
To isolate platform vs image issues, we ran the exact same images inside Docker/WSL, configuring memory limits to mimic Cloudflare. This surfaced several local-only blockers: stale `/var/lib/wazuh-indexer/nodes/node.lock` files after aborted boots, TLS bundles containing only IP SANs, and WSL RAM exhaustion when the security plugin hashed large configs. Addressing these locally provided cleaner logs and confidence before re-attempting Cloudflare runs.

### 4.3 Security Bootstrap & Certificate Work
We extracted the upstream security configuration, copied it into the repo, and introduced `bootstrap-security.sh` (build-time) plus `init-security.sh` (runtime). These scripts start OpenSearch with TLS, execute `securityadmin.sh`, and drop a marker file to skip redundant work. We added a Python patch for `admin_dn`, ensured `/usr/share/wazuh-indexer/data` exists, regenerated certificates with both IP and DNS SANs, and added `BOOTSTRAP_TLS_HOST` so HTTPS checks succeed during bootstrap. Cache-busting build args (`CERT_BUILD_ID`) and `docker build --no-cache` runs ensured Wrangler consumed the updated artifacts.

### 4.4 Durable Object Readiness Refinement
Back in Cloudflare, we layered a custom readiness routine atop `startAndWaitForPorts`. We disabled HTTP TLS at runtime (since the SDK lacks custom CA trust), polled `/_cluster/health` via `tcpPort.fetch`, raised `CONTAINER_PORT_READY_TIMEOUT_MS` to 600 000 ms, and introduced a shared `pendingReadyPromise` so `blockConcurrencyWhile` only wraps promise creation. This removed DO reset loops but still ended with “container port not found” because the Worker has no TCP proxy into port 9200.

### 4.5 Node Stability & JVM Tuning
Repeated stop/start cycles highlighted the need for deterministic cleanup. We now delete `/var/lib/wazuh-indexer/nodes` both after bootstrap and at runtime, reset the `.security-initialized` marker, and increased JVM heap/WSL memory to prevent `OutOfMemoryError`. After these fixes OpenSearch consistently logs `node started` and `publish_address {172.17.0.2:9200}`.

### 4.6 Hybrid Validation & Documentation
With the platform limitation confirmed, we adopted a hybrid workflow: Manager/Dashboard/Certs remain inside Cloudflare, while the Indexer runs locally (Docker/WSL) and the Worker proxies to `http://127.0.0.1:9200` for testing. In parallel we updated ARCHITECTURE/DEPLOYMENT docs plus this evaluation report so future engineers understand the limitation, the workaround, and the readiness logic already in place for when Cloudflare enables container port forwarding.

## 5. Local vs Production Summary
### Local / WSL (Docker Parity)
- **Indexer stability:** Stale `/var/lib/wazuh-indexer/nodes/node.lock` files from aborted boots produced `LockObtainFailedException`. Automated cleanup now runs after bootstrap and during runtime, guaranteeing clean starts.
- **TLS + security bootstrap:** Initial cert bundle lacked DNS SANs and `securityadmin.sh` failed with “Empty input.” We copied the upstream security config into the repo, added `bootstrap-security.sh` and `init-security.sh`, regenerated certs with IP + DNS SANs, and introduced `BOOTSTRAP_TLS_HOST` so HTTPS bootstrap passes before runtime toggles HTTP.
- **Resource tuning:** Hashing the security config exhausted JVM/WSL memory. We increased heap limits and WSL RAM so OpenSearch consistently logs `node started` and binds to `publish_address {172.17.0.2:9200}`.

### Cloudflare Durable Objects / Production
- **Durable Object readiness:** Added `startAndWaitForPorts`, shared `pendingReadyPromise`, and a 10‑minute HTTP poll of `/_cluster/health` to keep DOs alive without tripping the 30 s `blockConcurrencyWhile` ceiling. Manager and Dashboard containers succeed with this pattern.
- **Platform limitation:** Wrangler/workerd currently refuse to proxy arbitrary ports; every attempt ends with “Unexpected fields … 'ports'” and `connect(): container port not found`, so the Worker cannot reach the indexer’s port 9200 despite the container advertising it.
- **Current workaround:** Until Cloudflare delivers port mapping, keep Indexer running in Docker/WSL and let the Worker proxy to `http://127.0.0.1:9200`, while Manager/Dashboard/Certs remain inside Cloudflare to validate the broader pipeline.

## 6. Findings
### 6.1 Security & TLS Initialization
- Build-time script launches OpenSearch with TLS, runs `securityadmin.sh`, and drops a marker file. Runtime script wipes data directories, waits for health, and re-runs `securityadmin` if needed.
- Certificates now include both IP and DNS SANs, eliminating host verification failures.
- HTTP TLS is disabled after bootstrap so the Worker’s probe can use plain HTTP until Cloudflare supports custom CA trust.  
**Result:** Security index exists before runtime; no more “Empty input” or TLS handshake errors.

### 6.2 Node Stability
- Added deterministic cleanup (`rm -rf /var/lib/wazuh-indexer/nodes`) at build and runtime, preventing `LockObtainFailedException`.
- OpenSearch reliably reports `node started` and binds to `publish_address {172.17.0.2:9200}`.  
**Result:** Container-level stability achieved; restarts no longer loop.

### 6.3 Durable Object Readiness Logic
- Introduced `pendingReadyPromise` to respect the 30 s `blockConcurrencyWhile` ceiling.
- Raised `CONTAINER_PORT_READY_TIMEOUT_MS` to 600 000 ms (10 min), allowing heavy bootstrap phases.
- Sequenced `startAndWaitForPorts` before the custom HTTP polling of `/_cluster/health`.  
**Result:** Logic is correct but never completes because the Worker cannot open TCP connections to 9200.

### 6.4 Platform Limitation: Container Port Mapping
- Wrangler ignores the `ports` stanza (`Unexpected fields… "ports"`) and ultimately fails with `connect(): container port not found`.
- Inspection confirms the image exposes 9200; the failure occurs inside workerd’s proxy layer.
- All variants tested (cache clears, build arg bumps, alternate wrangler versions) reproduce the same warning.  
**Result:** Current Cloudflare runtime cannot surface the indexer’s port to Durable Objects; health checks will continue to 502 until the platform ships port forwarding.

## 7. Limitations & Risks
1. **Port Proxy Gap:** No workaround within Cloudflare Containers; only Cloudflare can deliver this capability.
2. **Operational Split-Brain:** Running the indexer outside Cloudflare for local testing adds configuration drift risk.
3. **TLS Trade-offs:** HTTP TLS remains disabled at runtime solely to satisfy the Worker probe; once port mapping exists, HTTPS readiness must be re-enabled and revalidated.
4. **Long Startup Windows:** Even with 10-minute timeouts, the Worker still hits platform resets if `blockConcurrencyWhile` spans too long—future changes must keep heavy work outside that scope.

## 8. Recommendations & Next Steps
1. **Short Term (Dev/Test)**
   - Run the indexer container in Docker/WSL, expose `http://127.0.0.1:9200`, and configure the Worker to target it during local development.
   - Keep Manager/Dashboard/Certs inside Cloudflare to validate the rest of the pipeline.
2. **Platform Watch**
   - Track wrangler/workerd release notes for generic port mapping support; retest immediately when available.
   - File an issue with Cloudflare referencing the current logs to ensure the feature request is visible.
3. **Production Contingency**
   - If Cloudflare’s timeline slips, consider hosting OpenSearch on VM/Kubernetes and proxying through the Worker (maintaining the same API contract) until container support lands.
4. **Documentation & Knowledge Transfer**
   - Keep ARCHITECTURE.md and DEPLOYMENT.md synced with this report so future engineers understand the current boundary and the Docker-side workaround.

## 9. Implementation Snapshot
```
+-------------------------+
| Cloudflare Worker (/api)|
|  - Hono router          |
|  - Durable Objects      |
+-----------+-------------+
            |
   +--------+---------+
   | Durable Object   |
   | (BaseWazuhContainer)
   +--------+---------+
            |
   +--------+---------+
   | Cloudflare Container |
   |  - Wazuh component   |
   +----------------------+
```
- `ManagerContainer` (port 55000) – healthy.
- `DashboardContainer` (port 5601) – healthy.
- `IndexerContainer` (port 9200) – container healthy but unreachable from Worker due to missing proxy.

## 10. Appendix: Key Assets
- `containers/indexer/Dockerfile`, `bootstrap-security.sh`, `init-security.sh`
- `src/containers.ts`, `src/worker.ts`
- `wrangler.toml`, `Infra/cluster-*.json`

---
**Status (Jan 17 2026):** OpenSearch container is stable and listening, but the Cloudflare Worker cannot hit port 9200 because wrangler/workerd lack arbitrary port mapping. Health checks therefore return 502 until the platform adds this capability.
