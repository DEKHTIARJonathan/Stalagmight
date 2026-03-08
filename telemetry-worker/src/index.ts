/**
 * Stalagmight Telemetry Worker
 *
 * Receives anonymous usage event batches from the desktop app and stores
 * them in a D1 database. No PII is collected or stored.
 */

interface Env {
  DB: D1Database;
}

interface TelemetryPayload {
  v: number;
  app_version: string;
  os: string;
  session_id: string;
  duration_secs: number;
  project_seq?: number;
  events: Record<string, number>;
}

function isValidPayload(body: unknown): body is TelemetryPayload {
  if (typeof body !== 'object' || body === null) return false;
  const p = body as Record<string, unknown>;
  return (
    typeof p.v === 'number' &&
    typeof p.app_version === 'string' &&
    typeof p.os === 'string' &&
    typeof p.session_id === 'string' &&
    typeof p.duration_secs === 'number' &&
    typeof p.events === 'object' &&
    p.events !== null
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST to /v1/events
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/events') {
      return new Response('Not Found', { status: 404 });
    }

    // Parse and validate
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (!isValidPayload(body)) {
      return new Response('Invalid payload shape', { status: 400 });
    }

    // Basic sanity limits
    if (body.session_id.length > 64 || body.app_version.length > 32 || body.os.length > 32) {
      return new Response('Field too long', { status: 400 });
    }

    const eventEntries = Object.entries(body.events);
    if (eventEntries.length > 500) {
      return new Response('Too many events', { status: 400 });
    }

    // Upsert session (update duration on repeated flushes from same session)
    const sessionStmt = env.DB.prepare(
      `INSERT INTO sessions (session_id, app_version, os, duration_secs)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(session_id) DO UPDATE SET duration_secs = ?4, received_at = datetime('now')`
    ).bind(body.session_id, body.app_version, body.os, body.duration_secs);

    // Insert events (project_seq defaults to 0 for backward compat)
    const projectSeq = body.project_seq ?? 0;
    const eventStmts = eventEntries.map(([name, count]) =>
      env.DB.prepare(
        'INSERT INTO events (session_id, event_name, count, project_seq) VALUES (?1, ?2, ?3, ?4)'
      ).bind(body.session_id, name.slice(0, 128), Math.min(count, 1_000_000), projectSeq)
    );

    try {
      await env.DB.batch([sessionStmt, ...eventStmts]);
    } catch {
      return new Response('Database error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },
};
