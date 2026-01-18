import type { ClusterConfig } from '../types';

export const defaultClusters: Record<string, ClusterConfig> = {
  primary: {
    name: 'primary',
    version: '4.9.0',
    nodes: {
      managers: {
        count: 1,
        image: 'wazuh/wazuh-manager',
        tag: '4.9.0',
        env: {},
      },
      indexers: {
        count: 1,
        image: 'wazuh/wazuh-indexer',
        tag: '4.9.0',
        env: {},
      },
      dashboards: {
        count: 1,
        image: 'wazuh/wazuh-dashboard',
        tag: '4.9.0',
        env: {},
      },
      certs: {
        count: 1,
        image: 'wazuh/wazuh-certs-generator',
        tag: '0.0.1',
        env: {},
      },
    },
    secrets: {
      adminUser: 'admin',
      adminPassword: 'admin',
      enrollmentKey: 'sample-enrollment-key',
      apiJwtSecret: 'sample-jwt-secret',
      caPem: '-----BEGIN CERTIFICATE-----\nMIIF...sample...IDAQAB\n-----END CERTIFICATE-----',
    },
    features: {
      r1Streaming: true,
      logReplication: true,
    },
  },
};
