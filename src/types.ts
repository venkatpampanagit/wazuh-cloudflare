import { z } from 'zod';

const nodeGroupSchema = z.object({
  count: z.number().int().min(1),
  max_instances: z.number().int().min(1).optional(),
  image: z.string().default(''),
  tag: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  resources: z
    .object({
      cpu: z.number().optional(),
      memory: z.string().optional(),
    })
    .default({})
    .optional(),
});

export const clusterConfigSchema = z.object({
  name: z.string(),
  version: z.string().default('4.9.0'),
  nodes: z.object({
    managers: nodeGroupSchema,
    indexers: nodeGroupSchema,
    dashboards: nodeGroupSchema,
    certs: nodeGroupSchema,
  }),
  secrets: z.object({
    adminUser: z.string(),
    adminPassword: z.string(),
    enrollmentKey: z.string(),
    apiJwtSecret: z.string(),
    caPem: z.string(),
  }),
  features: z
    .object({
      r1Streaming: z.boolean().default(true),
      logReplication: z.boolean().default(true),
    })
    .default({}),
});

export type ClusterConfig = z.infer<typeof clusterConfigSchema>;

export const enrollmentRequestSchema = z.object({
  agentId: z.string().min(1),
  hostname: z.string().min(1),
  version: z.string().min(1),
  tags: z.array(z.string()).default([]),
  cluster: z.string().optional(),
  metadata: z.record(z.any()).default({}),
});

export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;
