# Wazuh on Cloudflare Workers

Deploy the full Wazuh control plane (Manager, Indexer, Dashboard, Certs) on Cloudflare Workers by combining Durable Objects, Cloudflare Containers, KV, D1, and R1. This repository contains the Worker code, container customizations, and documentation created while evaluating the platform in January 2026.

> **Current status (Jan 2026):** Manager/Dashboard containers run end-to-end inside Cloudflare. The Indexer container boots cleanly, but Cloudflare’s Containers SDK (wrangler 4.59.2 / workerd 2026‑01) cannot proxy arbitrary TCP ports, so the Worker cannot reach OpenSearch on port 9200. See [Evaluation Report](docs/evaluation-of-wazuh-on-cloudflare-report.md) for the full analysis and workaround.

---

## Contents

| Path | Description |
|------|-------------|
| `src/` | Worker + Durable Object orchestration (`BaseWazuhContainer`, request routing, readiness logic). |
| `containers/` | Dockerfiles and scripts for hardened Wazuh images, including the Indexer bootstrap (`bootstrap-security.sh`, `init-security.sh`). |
| `Infra/` | Cluster configs, cert generation inputs, and KV seed files used by Wrangler. |
| `docs/ARCHITECTURE.md` | Current topology, component responsibilities, request flows, and Cloudflare bindings. |
| `docs/DEPLOYMENT.md` | Step-by-step deployment guide (bindings, KV seeding, D1 schema, verification). |
| `docs/evaluation-of-wazuh-on-cloudflare-report.md` | Detailed experiment log and platform evaluation (local vs production findings). |

---

## Architecture Overview

A single Cloudflare Worker (Hono router) fronts every external request—agent telemetry, dashboard sessions, and administrative APIs. The Worker authenticates each call (CF Access, JWT, SAML), maps the tenant/org to a dedicated Durable Object, and proxies traffic through that DO. Each Durable Object spins up the required Cloudflare Containers (Manager, Indexer, Dashboard, Certs) and keeps their `TcpPortHandle`s private.

- **Agent flow (blue)**: Agents talk MTLS directly to the Worker hostname; requests are routed to the Manager container (ports 1514/1515) via the tenant Durable Object.
- **Dashboard/Admin flow (black)**: Browsers hit `/dashboard/*`; the Worker forwards through the same DO to the Dashboard container (port 5601), which issues queries to the Indexer container (port 9200).

The updated multi-node diagram and narrative live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quick Start (Local Evaluation)

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Seed config** – update `Infra/cluster-local.json`, then push it into KV if you plan to run `wrangler dev`.
3. **Run supporting services**
   - **Indexer:** Until Cloudflare exposes port 9200, run the hardened Indexer image locally:
     ```bash
     docker build -t wazuh-indexer-local ./containers/indexer
     docker run -it --rm -p 9200:9200 wazuh-indexer-local
     ```
   - **Other roles:** Let Wrangler manage Manager/Dashboard/Certs inside the Worker environment.
4. **Start Wrangler**
   ```bash
   npx wrangler dev
   ```
   The Worker will proxy Manager/Dashboard traffic internally. Indexer API calls should be routed to your local Docker instance (see `IndexerContainer` logic in `src/containers.ts` for the current hybrid configuration).

5. **Validate**
   ```bash
   curl http://127.0.0.1:9200/_cluster/health        # local OpenSearch
   curl http://127.0.0.1:8787/health                 # wrangler dev worker
   ```

For full Cloudflare deployment steps (including R1/D1/KV provisioning), follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Evaluation Highlights

1. **Cloudflare-first attempts** – Stock Wazuh images were deployed directly to Durable Objects. Manager/Dashboard succeeded, but Indexer/Certs never finished readiness because wrangler could not connect to port 9200 (`connect(): container port not found`).  
2. **Local parity runs** – Same images were run via Docker/WSL to separate platform vs image issues. This surfaced stale `node.lock` files, TLS SAN gaps, and insufficient JVM/WSL memory.  
3. **Security bootstrap improvements** – Added deterministic scripts to pre-seed `.opendistro_security`, regenerate certs with IP/DNS SANs, and cache-bust images so Wrangler always includes the latest assets.  
4. **Durable Object readiness** – Implemented `pendingReadyPromise`, raised `CONTAINER_PORT_READY_TIMEOUT_MS`, and layered a custom HTTP poll after `startAndWaitForPorts` to respect DO lifecycle limits.  
5. **Hybrid workflow** – Until Cloudflare ships arbitrary port mapping, the project runs Indexer via Docker/WSL while keeping Manager/Dashboard/Certs inside Cloudflare. Documentation has been updated to reflect this temporary split.

All experiments, issues, and fixes are captured in [docs/evaluation-of-wazuh-on-cloudflare-report.md](docs/evaluation-of-wazuh-on-cloudflare-report.md).

---

## Key Cloudflare Bindings

Configured in `wrangler.toml` (see file for IDs):

| Binding | Type | Purpose |
|---------|------|---------|
| `WAZUH_MANAGER`, `WAZUH_INDEXER`, `WAZUH_DASHBOARD`, `WAZUH_CERTS` | Durable Object namespaces | Host containerized Wazuh roles via `@cloudflare/containers`. |
| `WAZUH_CLUSTER_CONFIG` | KV | Stores per-cluster plans (node counts, secrets, image tags). |
| `WAZUH_META` | D1 | Records enrollment events, node metadata, credential bundles. |
| `WAZUH_EVENTS` | R1 | Streams alert digests and log buffers for downstream consumers. |

---

## Limitations & Next Steps

- **Port proxying** – Cloudflare Containers currently proxy only a fixed set of ports. Indexer (OpenSearch 9200) cannot be reached from the Worker, so health checks and API calls fail inside Cloudflare despite the container being healthy.  
- **TLS trade-off** – HTTP TLS is disabled at runtime to allow the Worker’s readiness probe; once port mapping exists, re-enable HTTPS (already supported by the bootstrap scripts).  
- **Work in progress** – Monitor Wrangler/workerd releases for container port mapping support. Once available, remove the hybrid workaround and run the Indexer fully inside Cloudflare.

---

## Contributing / Next Tasks

- Track Cloudflare platform updates and rerun the readiness probes as soon as arbitrary port forwarding is supported.
- Extend the Worker to stream health metrics into D1/R1 for observability.
- Automate certificate rotation via the `CertsContainer`.
- Consider an interim production architecture where OpenSearch runs on VM/Kubernetes with the Worker acting as a proxy until Cloudflare removes the port limitation.

For detailed troubleshooting guidance, consult [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and the evaluation report.
