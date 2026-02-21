type SqlPrimitive = string | number | boolean | null;
type SqlCapable = {
  sql<T = Record<string, SqlPrimitive>>(
    strings: TemplateStringsArray,
    ...values: SqlPrimitive[]
  ): T[];
};

export function ensureSqlSchema(agent: SqlCapable): void {
  agent.sql`
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  agent.sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
}

export function insertSessionMessage(
  agent: SqlCapable,
  args: { id: string; sessionId: string; role: string; content: string; createdAt: string }
): void {
  agent.sql`
    INSERT INTO session_messages (id, session_id, role, content, created_at)
    VALUES (${args.id}, ${args.sessionId}, ${args.role}, ${args.content}, ${args.createdAt})
  `;
}

export function insertAuditEvent(
  agent: SqlCapable,
  args: {
    id: string;
    sessionId: string;
    kind: string;
    payloadJson: string;
    correlationId: string;
    createdAt: string;
  }
): void {
  agent.sql`
    INSERT INTO audit_events (id, session_id, kind, payload_json, correlation_id, created_at)
    VALUES (${args.id}, ${args.sessionId}, ${args.kind}, ${args.payloadJson}, ${args.correlationId}, ${args.createdAt})
  `;
}
