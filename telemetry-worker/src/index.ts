/**
 * Stalagmight Telemetry Worker
 *
 * Receives anonymous usage event batches from the desktop app and stores
 * them in a D1 database. IP addresses are SHA-256 hashed for abuse
 * detection only — no raw IPs or other PII are stored.
 *
 * Wire format: packed msgpack (`application/msgpack`) only.
 */

import { decode } from '@msgpack/msgpack';
import { EVENT_NAMES, SOURCE_NAMES } from './registry';

const MAX_BODY_BYTES = 65_536; // 64 KB
const RATE_LIMIT_MAX_FLUSHES_PER_MIN = 10;

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

interface PackedPayload {
  v: number;
  a: string;
  o: string;
  s: Uint8Array;
  d: number;
  p: number;
  e: number[];
  ds?: Record<string, number>;
}

function isValidPackedPayload(body: unknown): body is PackedPayload {
  if (typeof body !== 'object' || body === null) return false;
  const p = body as Record<string, unknown>;
  return (
    typeof p.v === 'number' &&
    typeof p.a === 'string' &&
    typeof p.o === 'string' &&
    p.s instanceof Uint8Array &&
    typeof p.d === 'number' &&
    typeof p.p === 'number' &&
    Array.isArray(p.e)
  );
}

/** Convert 16 raw bytes to UUID string format. */
function sessionIdFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Unpack flat event array + display-state into string event map. */
function unpackEvents(packed: PackedPayload): Record<string, number> {
  const events: Record<string, number> = {};

  for (let i = 0; i + 2 < packed.e.length; i += 3) {
    const eventId = packed.e[i];
    const sourceId = packed.e[i + 1];
    const count = packed.e[i + 2];

    const eventName = EVENT_NAMES[eventId];
    if (!eventName) continue;

    const sourceName = SOURCE_NAMES[sourceId] ?? '';
    const key = sourceName ? `${eventName}:${sourceName}` : eventName;
    events[key] = (events[key] ?? 0) + count;
  }

  // Display-state overrides (e.g. "showGrid:true") → "display-state.showGrid:true"
  if (packed.ds) {
    for (const [key, count] of Object.entries(packed.ds)) {
      events[`display-state.${key}`] = (events[`display-state.${key}`] ?? 0) + count;
    }
  }

  return events;
}

/** Convert packed payload to normalized TelemetryPayload. */
function unpackPayload(packed: PackedPayload): TelemetryPayload {
  return {
    v: packed.v,
    app_version: packed.a,
    os: packed.o,
    session_id: sessionIdFromBytes(packed.s),
    duration_secs: packed.d,
    project_seq: packed.p,
    events: unpackEvents(packed),
  };
}

async function parseRequest(request: Request): Promise<TelemetryPayload | null> {
  const buffer = await request.arrayBuffer();
  const raw = decode(new Uint8Array(buffer));

  if (!isValidPackedPayload(raw)) return null;

  // Flat event array must be divisible by 3
  if (raw.e.length % 3 !== 0) return null;

  return unpackPayload(raw);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST to /v1/events
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/events') {
      return new Response('Not Found', { status: 404 });
    }

    // Require Stalagmight user agent — blocks scanners and bots
    const ua = request.headers.get('User-Agent') ?? '';
    if (!ua.startsWith('Stalagmight/')) {
      return new Response('Not Found', { status: 404 });
    }

    // Reject oversized bodies before reading
    const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }

    const payload = await parseRequest(request);
    if (!payload) {
      return new Response('Invalid payload', { status: 400 });
    }

    // Basic sanity limits
    if (payload.session_id.length > 64 || payload.app_version.length > 32 || payload.os.length > 32) {
      return new Response('Field too long', { status: 400 });
    }

    const eventEntries = Object.entries(payload.events);
    if (eventEntries.length > 500) {
      return new Response('Too many events', { status: 400 });
    }

    // Hash the client IP for abuse detection (no raw IPs stored)
    const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const ipBytes = new TextEncoder().encode(clientIp);
    const hashBuffer = await crypto.subtle.digest('SHA-256', ipBytes);
    const ipHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Rate limit: count flushes from this IP in the last minute (read-only).
    // ip_hash is on event rows directly — no JOIN, no IP-flip exploit.
    const { results: rateRows } = await env.DB.prepare(
      `SELECT COUNT(DISTINCT received_at) as cnt FROM events
       WHERE ip_hash = ?1 AND received_at > datetime('now', '-1 minute')`
    ).bind(ipHash).all();
    if (rateRows.length > 0 && (rateRows[0].cnt as number) >= RATE_LIMIT_MAX_FLUSHES_PER_MIN) {
      return new Response('Too many requests', { status: 429 });
    }

    // Upsert session (update duration + ip_hash on repeated flushes from same session)
    const sessionStmt = env.DB.prepare(
      `INSERT INTO sessions (session_id, app_version, os, duration_secs, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(session_id) DO UPDATE SET duration_secs = ?4, ip_hash = ?5, received_at = datetime('now')`
    ).bind(payload.session_id, payload.app_version, payload.os, payload.duration_secs, ipHash);

    // Insert events (project_seq defaults to 0 for backward compat)
    const projectSeq = payload.project_seq ?? 0;
    const eventStmts = eventEntries.map(([name, count]) =>
      env.DB.prepare(
        'INSERT INTO events (session_id, event_name, count, project_seq, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5)'
      ).bind(payload.session_id, name.slice(0, 128), Math.min(count, 1_000_000), projectSeq, ipHash)
    );

    try {
      await env.DB.batch([sessionStmt, ...eventStmts]);
    } catch {
      return new Response('Database error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },
};
