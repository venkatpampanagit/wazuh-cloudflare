# Deployment Guide: Wazuh Central Components on Cloudflare Workers

This guide explains how to provision and deploy the multi-node Wazuh stack using Cloudflare Workers with Containers, Durable Objects, KV, D1, and R1 bindings.

## 1. Prerequisites
1. **Cloudflare account** with Workers Paid plan (needed for Containers/R1/D1).
2. **Wrangler** CLI installed (`npm install -g wrangler` or local dev dependency).
3. **Docker** locally if you intend to customize container images before uploading.
4. **Cloudflare resources** already created:
   - R1 database for streaming events (e.g., `wazuh-events`).
   - D1 database for cluster metadata (e.g., `wazuh-meta`).
   - Workers KV namespace for cluster configuration (e.g., `wazuh-cluster-config`).
   - Durable Object namespaces for each container role (Wrangler handles this during deploy via migrations).

## 2. Configure Wrangler bindings
Edit `wrangler.toml` to include your resource IDs:

```toml
name = "wazuh-cloudflare"
main = "src/worker.ts"
compatibility_date = "2024-12-18"
workers_dev = true

[[r1_databases]]
binding = "WAZUH_EVENTS"
database_name = "wazuh-events"
id = "<r1-database-id>"

[[d1_databases]]
binding = "WAZUH_META"
database_name = "wazuh-meta"
id = "<d1-database-id>"

[[kv_namespaces]]
binding = "WAZUH_CLUSTER_CONFIG"
id = "<kv-id>"

[[durable_objects]]
binding = "WAZUH_MANAGER"
class_name = "ManagerContainer"

[[durable_objects]]
binding = "WAZUH_INDEXER"
class_name = "IndexerContainer"

[[durable_objects]]
binding = "WAZUH_DASHBOARD"
class_name = "DashboardContainer"

[[durable_objects]]
binding = "WAZUH_CERTS"
class_name = "CertsContainer"

[vars]
DEFAULT_CLUSTER = "primary"
CONTAINER_SLEEP_AFTER = "10m"
```

> **Note**: When you run `wrangler deploy`, Durable Object migrations are auto-generated. To pin to specific versions, add `[migrations]` sections.

## 3. Seed KV with cluster configuration
Populate the KV namespace with one JSON entry per cluster. Example key: `clusters/primary.json`:

```json
{
  "name": "primary",
  "version": "4.9.0",
  "nodes": {
    "managers": { "count": 2, "image": "wazuh/wazuh-manager", "tag": "4.9.0" },
    "indexers": { "count": 3, "image": "wazuh/wazuh-indexer", "tag": "4.9.0" },
    "dashboards": { "count": 2, "image": "wazuh/wazuh-dashboard", "tag": "4.9.0" },
    "certs": { "count": 1, "image": "wazuh/wazuh-certs-generator", "tag": "4.9.0" }
  },
  "secrets": {
    "adminUser": "wazuh-admin",
    "adminPassword": "<strong-password>",
    "enrollmentKey": "<agent-key>",
    "apiJwtSecret": "<jwt-secret>",
    "caPem": "<pem-string>"
  },
  "features": {
    "r1Streaming": true,
    "logReplication": true
  }
}
```

Upload with Wrangler:
```bash
wrangler kv:key put WAZUH_CLUSTER_CONFIG clusters:primary --path ./config/primary.json
```

## 4. Initialize D1 schema
Use the following SQL to create tables (simplified example):

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  cluster TEXT NOT NULL,
  status TEXT NOT NULL,
  enrolled_at INTEGER NOT NULL,
  last_check_in INTEGER
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  cluster TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  cluster TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);
```

Apply migrations:
```bash
wrangler d1 execute WAZUH_META --file ./schema.sql
```

## 5. Deploy containers & worker
1. Install dependencies: `npm install`
2. (Optional) Update container images or env vars in `src/containers.ts`.
3. Deploy: `npm run deploy`
4. Follow Wrangler prompts to confirm resource creation.

Wrangler outputs the Worker URL (e.g., `https://wazuh-cloudflare.workers.dev`).

## 6. Verify deployment
- **Health**: `curl https://wazuh-cloudflare.workers.dev/health`
- **Enrollment flow**: `curl -X POST https://.../api/agents/enroll -d '{"agentId":"agent-001","hostname":"edge-1"}'`
- **Container state**: Use `wrangler tail` to observe container lifecycle logs.
- **R1 stream**: Inspect via Cloudflare dashboard (Data -> R1) or CLI once available.

## 7. Multi-node scaling tips
- Adjust `count` and `max_instances` in KV to scale each role.
- Use Durable Object IDs (hashing agent ID) to ensure sticky routing.
- Schedule periodic health checks (Worker CRON triggers) to recycle unhealthy containers.
- For disaster recovery, replicate KV + D1 exports and R1 shards across accounts/regions.

## 8. Troubleshooting
| Symptom | Likely Cause | Resolution |
|---------|--------------|------------|
| Worker returns 500 when calling containers | Containers not started or image misconfigured | Verify `wrangler.toml` container entries, ensure port readiness, inspect logs |
| Enrollment API returns 404 | KV config missing cluster key | Confirm `clusters:<name>` entry exists |
| Long start latency | Containers cold, high image size | Pre-warm via scheduled fetch, slim Docker image |
| Missing alerts in downstream pipeline | R1 binding not configured | Check `[ [r1_databases] ]` binding and Worker logs |

## 9. Next steps
- Add IaC automation (Terraform) to create R1/D1/KV resources.
- Layer authentication/authorization on Worker endpoints.
- Implement automated certificate rotation via the Certs container.
