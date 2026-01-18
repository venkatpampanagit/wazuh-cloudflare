export interface AgentRecord {
  id: string;
  hostname: string;
  cluster: string;
  status: string;
  version: string;
  tags: string[];
  metadata: Record<string, unknown>;
  enrolledAt: number;
  lastCheckIn?: number;
}

export interface NodeRecord {
  id: string;
  role: string;
  cluster: string;
  status: string;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  cluster: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export async function upsertAgent(db: D1Database, agent: AgentRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (id, hostname, cluster, status, version, tags, metadata, enrolled_at, last_check_in)
       VALUES (?1, ?2, ?3, ?4, ?5, json(?6), json(?7), ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         hostname=excluded.hostname,
         cluster=excluded.cluster,
         status=excluded.status,
         version=excluded.version,
         tags=excluded.tags,
         metadata=excluded.metadata,
         last_check_in=excluded.last_check_in
      `,
    )
    .bind(
      agent.id,
      agent.hostname,
      agent.cluster,
      agent.status,
      agent.version,
      JSON.stringify(agent.tags ?? []),
      JSON.stringify(agent.metadata ?? {}),
      agent.enrolledAt,
      agent.lastCheckIn ?? agent.enrolledAt,
    )
    .run();
}

export async function recordAuditEvent(db: D1Database, event: AuditEventRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (id, cluster, event_type, payload, created_at)
       VALUES (?1, ?2, ?3, json(?4), ?5)`,
    )
    .bind(event.id, event.cluster, event.type, JSON.stringify(event.payload ?? {}), event.createdAt)
    .run();
}

export async function listNodes(db: D1Database, cluster?: string): Promise<NodeRecord[]> {
  const statement = cluster
    ? db.prepare(
        `SELECT id, role, cluster, status, updated_at as updatedAt, COALESCE(metadata, '{}') as metadata FROM nodes WHERE cluster = ?1 ORDER BY updated_at DESC`,
      ).bind(cluster)
    : db.prepare(
        `SELECT id, role, cluster, status, updated_at as updatedAt, COALESCE(metadata, '{}') as metadata FROM nodes ORDER BY updated_at DESC`,
      );

  const { results } = await statement.all<Record<string, unknown>>();
  return (results ?? []).map((row) => ({
    id: String(row.id),
    role: String(row.role),
    cluster: String(row.cluster),
    status: String(row.status),
    updatedAt: Number(row.updatedAt ?? Date.now()),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>),
  }));
}
