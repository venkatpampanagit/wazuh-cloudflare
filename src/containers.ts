import { Container } from '@cloudflare/containers';
import { getClusterConfig, type ConfigBindings } from './config';
import type { ClusterConfig } from './types';
import type { R1Database } from './storage';

export interface ContainerEnv extends ConfigBindings {
  WAZUH_META: D1Database;
  WAZUH_EVENTS?: R1Database;
  CONTAINER_SLEEP_AFTER: string;
  CONTAINER_PORT_READY_TIMEOUT_MS?: string;
}

type ContainerContext = ConstructorParameters<typeof Container<ContainerEnv>>[0];

type ContainerStateSnapshot = {
  status: string;
  lastChange: number;
  exitCode?: number;
};

type ContainerStateAccessor = {
  getState(): Promise<ContainerStateSnapshot>;
  setHealthy(): Promise<void>;
};

type TcpPortHandle = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

type ContainerHandle = {
  running: boolean;
  getTcpPort(port: number): TcpPortHandle;
};

abstract class BaseWazuhContainer extends Container<ContainerEnv> {
  protected role: string;
  protected readonly durableState: ContainerContext;
  protected currentCluster?: ClusterConfig;

  constructor(
    ctx: ContainerContext,
    env: ContainerEnv,
    role: string,
    defaultPort: number,
    requiredPorts?: number[],
  ) {
    super(ctx, env, { sleepAfter: env.CONTAINER_SLEEP_AFTER, enableInternet: true });
    this.durableState = ctx;
    this.role = role;
    this.defaultPort = defaultPort;
    this.requiredPorts = requiredPorts ?? [defaultPort];
  }

  private stateAccessor(): ContainerStateAccessor {
    return (this as unknown as { state: ContainerStateAccessor }).state;
  }

  protected containerHandle(): ContainerHandle {
    return (this as unknown as { container: ContainerHandle }).container;
  }

  protected abstract roleEnv(config: ClusterConfig): Record<string, string>;

  protected baseEnv(config: ClusterConfig): Record<string, string> {
    return {
      WAZUH_CLUSTER_NAME: config.name,
      WAZUH_STACK_VERSION: config.version,
      WAZUH_ROLE: this.role,
    };
  }

  protected async configureForCluster(clusterName?: string): Promise<ClusterConfig> {
    const config = await getClusterConfig(this.env, clusterName);
    this.envVars = {
      ...this.envVars,
      ...this.baseEnv(config),
      ...this.roleEnv(config),
    };
    this.currentCluster = config;
    return config;
  }

  protected portReadyTimeout(): number {
    const raw = this.env.CONTAINER_PORT_READY_TIMEOUT_MS;
    if (!raw) {
      return 120_000;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
  }

  protected async waitFor(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
      return;
    }
    if (signal?.aborted) {
      throw new Error('Aborted');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('Aborted'));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  protected async isContainerHealthy(): Promise<boolean> {
    const state = await this.stateAccessor().getState();
    return state.status === 'healthy' && this.containerHandle()?.running;
  }

  protected async markContainerHealthy(): Promise<void> {
    const accessor = this.stateAccessor();
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await accessor.getState();
      if (current.status === 'healthy') {
        return;
      }
      await this.onStart();
      await accessor.setHealthy();
    });
  }

  protected async ensureReady(signal?: AbortSignal): Promise<void> {
    if (await this.isContainerHealthy()) {
      return;
    }
    const timeout = this.portReadyTimeout();
    console.log('waiting for ports', { role: this.role, ports: this.requiredPorts, timeout });
    try {
      await this.startAndWaitForPorts(this.requiredPorts, {
        portReadyTimeoutMS: timeout,
        waitInterval: 1000,
        abort: signal,
      });
    } catch (err) {
      console.error('port wait failed', {
        role: this.role,
        ports: this.requiredPorts,
        timeout,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  protected async publishLifecycle(event: string, payload?: Record<string, unknown>): Promise<void> {
    if (!this.env.WAZUH_EVENTS) {
      return;
    }
    try {
      await this.env.WAZUH_EVENTS.put(
        `containers:${this.role}:${this.durableState.id.toString()}:${Date.now()}`,
        JSON.stringify({
          event,
          payload,
          role: this.role,
          containerId: this.durableState.id.toString(),
          timestamp: Date.now(),
        }),
      );
    } catch (error) {
      console.error('Failed to write lifecycle event', error);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const clusterName = request.headers.get('x-wazuh-cluster') ?? undefined;
    await this.configureForCluster(clusterName);
    console.log('manager env', this.envVars);
    await this.ensureReady(request.signal ?? undefined);
    return this.containerFetch(request, this.defaultPort);
  }

  override async onStart(): Promise<void> {
    await this.publishLifecycle('started');
  }

  override async onStop(params: { exitCode: number; reason: 'exit' | 'runtime_signal' }): Promise<void> {
    await this.publishLifecycle('stopped', params);
  }

  override async onError(error: unknown): Promise<void> {
    await this.publishLifecycle('error', { message: (error as Error)?.message ?? String(error) });
  }
}

export class ManagerContainer extends BaseWazuhContainer {
  constructor(ctx: ContainerContext, env: ContainerEnv) {
    super(ctx, env, 'manager', 55000, [55000]);
    this.defaultPort = 55000;
  }

  protected roleEnv(config: ClusterConfig): Record<string, string> {
    const node = config.nodes.managers;
    const image = node.image || 'wazuh/wazuh-manager';
    const tag = node.tag || config.version;
    return {
      WAZUH_IMAGE: `${image}:${tag}`,
      WAZUH_API_USERNAME: config.secrets.adminUser,
      WAZUH_API_PASSWORD: config.secrets.adminPassword,
      WAZUH_ENROLLMENT_KEY: config.secrets.enrollmentKey,
      WAZUH_API_JWT_SECRET: config.secrets.apiJwtSecret,
      WAZUH_CA_PEM: config.secrets.caPem,
      ...node.env,
    };
  }
}

export class CertsContainer extends BaseWazuhContainer {
  constructor(ctx: ContainerContext, env: ContainerEnv) {
    super(ctx, env, 'certs', 1515);
  }

  protected roleEnv(config: ClusterConfig): Record<string, string> {
    const node = config.nodes.certs;
    const image = node.image || 'wazuh/wazuh-certs-generator';
    const tag = node.tag || config.version;
    return {
      WAZUH_IMAGE: `${image}:${tag}`,
      WAZUH_CERTS_CLUSTER: config.name,
      WAZUH_CA_PEM: config.secrets.caPem,
      ...node.env,
    };
  }
}

export class IndexerContainer extends BaseWazuhContainer {
  private pendingReadyPromise?: Promise<void>;

  constructor(ctx: ContainerContext, env: ContainerEnv) {
    super(ctx, env, 'indexer', 9200, [9200]);
  }

  protected roleEnv(config: ClusterConfig): Record<string, string> {
    const node = config.nodes.indexers;
    const image = node.image || 'wazuh/wazuh-indexer';
    const tag = node.tag || config.version;
    return {
      WAZUH_IMAGE: `${image}:${tag}`,
      WAZUH_INDEXER_CLUSTER: config.name,
      ...node.env,
    };
  }

  protected override async ensureReady(signal?: AbortSignal): Promise<void> {
    if (await this.isContainerHealthy()) {
      return;
    }
    if (!this.pendingReadyPromise) {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (!this.pendingReadyPromise) {
          this.pendingReadyPromise = this.waitForIndexerReady(signal).finally(() => {
            this.pendingReadyPromise = undefined;
          });
        }
      });
    }
    await this.pendingReadyPromise;
  }

  private async waitForIndexerReady(signal?: AbortSignal): Promise<void> {
    const timeout = this.portReadyTimeout();
    const waitInterval = 1_000;
    console.log('indexer custom readiness loop', { timeout });
    await this.startAndWaitForPorts(this.requiredPorts, {
      portReadyTimeoutMS: timeout,
      waitInterval,
      abort: signal,
    });
    const container = this.containerHandle();
    if (!container?.running) {
      throw new Error('Indexer container failed to start');
    }
    const targetPort = this.defaultPort ?? 9200;
    const tcpPort = container.getTcpPort(targetPort);
    const adminUser = this.envVars?.OPENSEARCH_INITIAL_ADMIN_USER ?? 'admin';
    const adminPassword = this.envVars?.OPENSEARCH_INITIAL_ADMIN_PASSWORD ?? '';
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (adminPassword) {
      headers.authorization = `Basic ${btoa(`${adminUser}:${adminPassword}`)}`;
    }
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const res = await tcpPort.fetch('http://localhost/_cluster/health?wait_for_status=yellow&timeout=5s', {
          method: 'GET',
          headers,
          signal,
        });
        if (res.ok || res.status === 401 || res.status === 403) {
          console.log('indexer readiness confirmed', { status: res.status });
          await this.markContainerHealthy();
          return;
        }
        const body = await res.text();
        console.warn('indexer readiness pending', {
          status: res.status,
          body: body.slice(0, 200),
        });
      } catch (error) {
        if (signal?.aborted) {
          throw (error instanceof Error ? error : new Error(String(error)));
        }
        console.warn('indexer readiness check failed', error instanceof Error ? error.message : String(error));
      }
      try {
        await this.waitFor(waitInterval, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw (error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    throw new Error(`Indexer readiness timed out after ${timeout}ms`);
  }
}

export class DashboardContainer extends BaseWazuhContainer {
  constructor(ctx: ContainerContext, env: ContainerEnv) {
    super(ctx, env, 'dashboard', 5601);
  }

  protected roleEnv(config: ClusterConfig): Record<string, string> {
    const node = config.nodes.dashboards;
    const image = node.image || 'wazuh/wazuh-dashboard';
    const tag = node.tag || config.version;
    return {
      WAZUH_IMAGE: `${image}:${tag}`,
      WAZUH_DASHBOARD_USER: config.secrets.adminUser,
      WAZUH_DASHBOARD_PASSWORD: config.secrets.adminPassword,
      ...node.env,
    };
  }
}
