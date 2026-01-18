# Wazuh on Cloudflare Workers – Multi-node Architecture

This repository describes how to deploy the Wazuh central components on Cloudflare Workers by composing Workers, Durable Objects, Containers, D1, R1 and KV services. The goal is to run a production-style multi-node stack aligned with the [official Wazuh Docker reference architecture](https://documentation.wazuh.com/current/deployment-options/docker/wazuh-container.html).

## Reference topology – single Worker, multi-container (Jan 2026)

```
                       (Admin / Dashboard users)
        +-----------------------------------------------+
        |  Browser / tenant portal / operator           |
        +-----------------------------------------------+
                               |
                               v   (black path: dashboard/API flow)
                 +-------------------------------+
                 | Cloudflare Worker (Hono API)  |
                 | - CF Access / JWT / SAML auth |
                 | - Maps orgId -> Tenant DO     |
                 +-------------------------------+
                               |
                               v
                 +-------------------------------+
                 | Durable Object per tenant     |
                 | - Starts container set        |
                 | - Routes private traffic      |
                 +-------------------------------+
                   |            |             |
                   v            v             v
            +-------------+ +-------------+ +----------------+
            |wazuh-manager| |wazuh-indexer| |wazuh-dashboard |
            |(Cloudflare  | |(Cloudflare  | |(Cloudflare     |
            | container)  | | container)  | | container)     |
            |ports 1514/5 | |port 9200    | |port 5601       |
            +-------------+ +-------------+ +----------------+
                   ^            ^             ^
                   |            |             |
             (blue path)        |             |
        Agent traffic (mTLS)    |             |
        from laptops/servers    |             |
                                +-------------+
                                   Dashboard queries OpenSearch
```

- **Single entrypoint Worker:** All external clients—agents, administrators, dashboards—hit the same Cloudflare Worker hostname. The Worker authenticates requests (CF Access, JWT, SAML), maps each org/tenant ID to a Durable Object instance, and never talks to containers directly without going through that DO.
- **Durable Object orchestration:** Each tenant gets one Durable Object derived from `BaseWazuhContainer`. The DO starts/stops the required Cloudflare Containers (Manager, Indexer, Dashboard, Certs) and exposes private `TcpPortHandle`s for the Worker to proxy traffic.
- **Container roles:** Manager listens for agents (1514/1515) and publishes events; Indexer provides OpenSearch APIs (9200); Dashboard exposes Kibana/WS (5601). All three sit behind the Worker/DO combo, mirroring the reference diagram shared in the design deck (agent flow in blue, dashboard flow in black).

## Component responsibilities

### Cloudflare Worker (entrypoint)
- Exposes the external API Gateway using Hono (REST + WebSocket streaming endpoints).
- Loads cluster plans from KV (`WAZUH_CLUSTER_CONFIG`) and validates them with Zod.
- Stores enrollment events, node assignments and credential bundles inside D1 (`WAZUH_META`).
- Streams alert digests and hot event buffers into R1 (`WAZUH_EVENTS`) for fan-out to additional consumers.
- Brokering layer between clients and the per-role container Durable Objects via the `@cloudflare/containers` helpers.

### Durable Object Containers
Each Wazuh role is implemented as a subclass of `Container`. **Important 2026 limitation:** Cloudflare’s Containers SDK (wrangler 4.59.2 / workerd 2026‑01) does **not** yet expose arbitrary container TCP ports to the Durable Object runtime. Manager/Dashboard traffic works because their default ports are internally proxied, but Indexer traffic (OpenSearch 9200) is currently inaccessible to the Worker despite the image exposing that port. This prevents health checks from ever returning 200 and is the primary blocker for full production rollout.

| DO Class            | Docker image                        | Purpose |
|--------------------|-------------------------------------|---------|
| `ManagerContainer`  | `wazuh/wazuh-manager`               | API, cluster coordination, agent enrollment |
| `IndexerContainer`  | `wazuh/wazuh-indexer`               | OpenSearch/Elasticsearch-compatible index nodes |
| `DashboardContainer`| `wazuh/wazuh-dashboard`             | UI layer exposed as HTTP/WS |
| `CertsContainer`    | `wazuh/wazuh-certs-generator`       | Issues TLS bundles shared across nodes |

Key configuration:
- **Multi-node topology**: The Worker keeps per-role desired counts in KV. Routes call `getRandom(binding, count)` to balance across the running Durable Object instances.
- **Networking**: Each container declares `defaultPort` and `requiredPorts` to ensure readiness before routing traffic.
- **Shared secrets**: The Worker injects cluster secrets (JWT, admin user, CA) through `envVars`. These secrets are fetched from KV on cold start and cached inside the Worker.
- **Lifecycle hooks**: Containers override `onStart`, `onStop`, and `onError` to publish heartbeats into R1 and update D1 metadata.

### Data services
- **D1 (SQLite-compatible)** – authoritative metadata store for cluster membership, agent enrollment tokens, API credentials, and node health snapshots.
- **R1 (real-time object store)** – append-only channel for high-volume logs from Indexer containers and health events from Durable Objects. Downstream analytics consumers subscribe from R1.
- **KV** – configuration registry describing each deployment (desired node counts, Docker tags, secret material, tuning thresholds). KV lookups are cached with `cfCacheTtl` to reduce egress.

## Request flows
1. **Agent enrollment**
   1. Client posts to `/api/agents/enroll`.
   2. Worker validates payload, persists intent in D1, retrieves manager topology from KV.
   3. Worker fetches a Manager container stub via `getRandom(MANAGER_CONTAINERS, desiredManagers)` and forwards the HTTP request (`containerFetch`).
   4. On success, Worker writes enrollment certificates to KV (encrypted) and pushes an audit event to R1.

2. **Log ingestion**
   1. Agents send logs to `wazuh-manager` port (routed through Worker → Manager container).
   2. Manager forwards to Indexer containers over the internal container network.
   3. Indexer writes searchable data to its own storage volume; summaries are streamed to R1 for cross-region consumers.

3. **Dashboard access**
   1. Browser hits `/dashboard/*` path on Worker.
   2. Worker proxies to Dashboard container default port, ensuring sticky sessions by hashing `cf-ray` into a Durable Object ID.

4. **Certificate rotation**
   1. SRE triggers `/api/certs/rotate`.
   2. Worker uses the Certs container to mint bundles, persists metadata in D1, and atomically updates KV secrets consumed by other containers during their next restart.

## Cloudflare bindings summary
| Binding name             | Type                   | Usage |
|--------------------------|------------------------|-------|
| `WAZUH_MANAGER`          | Durable Object namespace | Containers for manager nodes |
| `WAZUH_INDEXER`          | Durable Object namespace | Containers for indexer nodes |
| `WAZUH_DASHBOARD`        | Durable Object namespace | Containers for dashboard nodes |
| `WAZUH_CERTS`            | Durable Object namespace | TLS certificate helper |
| `WAZUH_CLUSTER_CONFIG`   | KV Namespace           | Deployment manifests & secrets |
| `WAZUH_META`             | D1 Database            | Metadata persistence |
| `WAZUH_EVENTS`           | R1 Database            | Log/event streaming |

## Deployment workflow
> **Local dev warning (Jan 2026):** Because wrangler cannot forward container port 9200 yet, indexer readiness checks always time out with `container port not found`. End-to-end tests that require a healthy OpenSearch node must run outside Cloudflare (e.g., Docker Compose) until the SDK supports port mapping.
1. Define KV entry `clusters/<name>.json` describing node counts, Docker tags, elasticsearch settings, and Durable Object IDs.
2. Run `npm run deploy` which uses `wrangler deploy`.
3. Wrangler provisions Containers + Durable Objects + data services and uploads the Worker bundle.
4. Post-deploy automation script (to be added) seeds D1 schema and initial cluster metadata.

## Next steps
- Implement Worker + container classes aligning with this document.
- Provide IaC snippets (Terraform or Wrangler TOML) to provision the bindings.
- Build automated health checks writing node states into D1 and R1.
