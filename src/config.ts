import { clusterConfigSchema, type ClusterConfig } from './types';
import { defaultClusters } from './config/defaults';

const KV_KEY_PREFIX = 'clusters:';
const CACHE_TTL_MS = 60_000;

const inMemoryCache = new Map<string, { expires: number; config: ClusterConfig }>();

export interface ConfigBindings {
  WAZUH_CLUSTER_CONFIG: KVNamespace;
  DEFAULT_CLUSTER: string;
}

function sanitizeClusterName(value: string | undefined, fallback: string): string {
  return (value ?? fallback ?? 'primary').toLowerCase();
}

export async function getClusterConfig(env: ConfigBindings, clusterName?: string): Promise<ClusterConfig> {
  const key = sanitizeClusterName(clusterName, env.DEFAULT_CLUSTER);
  const cached = inMemoryCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.config;
  }

  const raw = await env.WAZUH_CLUSTER_CONFIG.get(`${KV_KEY_PREFIX}${key}`, {
    type: 'json',
    cacheTtl: 30,
  });

  const sourceConfig = raw ?? defaultClusters[key];
  if (!sourceConfig) {
    throw new Error(`Cluster configuration '${key}' was not found in KV`);
  }

  const config = clusterConfigSchema.parse(sourceConfig);
  inMemoryCache.set(key, { config, expires: Date.now() + CACHE_TTL_MS });
  return config;
}

export function invalidateClusterConfig(clusterName: string): void {
  inMemoryCache.delete(clusterName.toLowerCase());
}
