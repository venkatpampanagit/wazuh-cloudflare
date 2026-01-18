import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getRandom } from '@cloudflare/containers';
import type { Container as CfContainer } from '@cloudflare/containers';
import { ManagerContainer, IndexerContainer, DashboardContainer, CertsContainer } from './containers';

interface Env {
  WAZUH_MANAGER: DurableObjectNamespace<ManagerContainer>;
  WAZUH_INDEXER: DurableObjectNamespace<IndexerContainer>;
  WAZUH_DASHBOARD: DurableObjectNamespace<DashboardContainer>;
  WAZUH_CERTS: DurableObjectNamespace<CertsContainer>;
  WAZUH_CLUSTER_CONFIG: KVNamespace;
  WAZUH_META: D1Database;
  WAZUH_EVENTS: R2Bucket;
  DEFAULT_CLUSTER: string;
  CONTAINER_SLEEP_AFTER: string;
}

const app = new Hono<{ Bindings: Env; Variables: { env: Env } }>();
type AppContext = Context<{ Bindings: Env; Variables: { env: Env } }>;

const clusterParam = z.object({
  cluster: z.string().min(1).default('primary'),
});

app.use('*', async (c, next) => {
  c.set('env', c.env);
  await next();
});

app.get('/', (c) => proxyDashboard(c));
app.all('/dashboard/*', (c) => proxyDashboard(c));
app.all('/api/dashboard/*', (c) => proxyDashboard(c));

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/api/agents/enroll', async (c) => proxyManager(c, { parseBodyCluster: true }));
app.all('/api/agents/*', (c) => proxyManager(c));
app.all('/api/indexer/*', (c) => proxyIndexer(c));
app.all('/api/certs/*', (c) => proxyCerts(c));

export default app;
export { ManagerContainer, IndexerContainer, DashboardContainer, CertsContainer };

type ProxyOptions = {
  instances?: number;
  rawBody?: string;
  clusterOverride?: string | null;
  parseBodyCluster?: boolean;
};

function resolveCluster(c: AppContext, override?: string | null): string {
  return clusterParam.parse({ cluster: override ?? c.req.query('cluster') ?? c.env.DEFAULT_CLUSTER }).cluster;
}

async function proxyContainerRequest<T extends CfContainer>(
  c: AppContext,
  binding: DurableObjectNamespace<T>,
  opts: ProxyOptions & { cluster?: string } = {},
): Promise<Response> {
  const stub = await getRandom(binding, opts.instances ?? 2);
  const headers = new Headers(c.req.raw.headers);
  if (opts.cluster) {
    headers.set('x-wazuh-cluster', opts.cluster);
  }

  const proxiedRequest =
    opts.rawBody !== undefined
      ? new Request(c.req.url, {
          method: c.req.method,
          headers,
          body: opts.rawBody,
        })
      : new Request(c.req.raw, { headers });

  return stub.fetch(proxiedRequest);
}

function proxyError(c: AppContext, code: string, error: unknown): Response {
  return c.json(
    {
      error: code,
      message: (error as Error)?.message ?? String(error),
    },
    502,
  );
}

async function proxyDashboard(c: AppContext): Promise<Response> {
  try {
    const cluster = resolveCluster(c);
    return await proxyContainerRequest(c, c.env.WAZUH_DASHBOARD, { cluster });
  } catch (error) {
    return proxyError(c, 'dashboard_unavailable', error);
  }
}

async function proxyManager(c: AppContext, options: ProxyOptions = {}): Promise<Response> {
  try {
    let rawBody: string | undefined;
    let clusterOverride = options.clusterOverride ?? null;
    if (options.parseBodyCluster && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      rawBody = await c.req.text();
      try {
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        clusterOverride = parsed?.cluster ?? clusterOverride ?? null;
      } catch {
        // Ignore malformed JSON; fallback to query/default
      }
      options.rawBody = rawBody;
    }
    const cluster = resolveCluster(c, clusterOverride);
    return await proxyContainerRequest(c, c.env.WAZUH_MANAGER, {
      cluster,
      rawBody: options.rawBody,
      instances: 3,
    });
  } catch (error) {
    return proxyError(c, 'manager_unavailable', error);
  }
}

async function proxyIndexer(c: AppContext): Promise<Response> {
  try {
    const cluster = resolveCluster(c);
    return await proxyContainerRequest(c, c.env.WAZUH_INDEXER, { cluster, instances: 2 });
  } catch (error) {
    return proxyError(c, 'indexer_unavailable', error);
  }
}

async function proxyCerts(c: AppContext): Promise<Response> {
  try {
    const cluster = resolveCluster(c);
    return await proxyContainerRequest(c, c.env.WAZUH_CERTS, { cluster, instances: 1 });
  } catch (error) {
    return proxyError(c, 'certs_unavailable', error);
  }
}
