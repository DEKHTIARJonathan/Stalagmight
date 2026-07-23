// Dev-only "agent bridge" Vite plugin (issue: agent console bridge).
//
// Lets an outside process on the same machine (Claude Code, via curl/tail) read
// the live frontend console of the running `pnpm tauri dev` webview and execute
// JavaScript inside that webview, getting results back. Everything rides on the
// Vite dev server (http://localhost:1420); there are NO Rust changes, so it can
// be wired up without restarting the user's running Tauri app.
//
// Shape:
//   - `.agent-bridge/token`        random per-server-start token (mode 0600)
//   - `.agent-bridge/console.jsonl` one JSON line per mirrored console entry
//   - `.agent-bridge/results.jsonl` one JSON line per eval result
//   - HTTP routes under `/__agent/` (see the middleware below)
//
// The webview client lives in `src/dev/agentBridge.ts`: it fetches the token,
// mirrors console.* into console.jsonl, and polls the eval queue.
//
// Guards (belt-and-suspenders against DNS-rebinding / cross-origin browsers):
//   - Host header must be localhost:1420 or 127.0.0.1:1420.
//   - If an Origin header is present it must be a known dev/tauri origin.
//   - Every route except GET /__agent/token requires the shared token.
//
// `apply: 'serve'` means the plugin is inert in production builds.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Repo root = two levels up from scripts/lib/. Derived from the plugin's own
// location so it does not depend on the process cwd.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_DIR = path.join(REPO_ROOT, '.agent-bridge');
const TOKEN_PATH = path.join(BRIDGE_DIR, 'token');
const CONSOLE_PATH = path.join(BRIDGE_DIR, 'console.jsonl');
const RESULTS_PATH = path.join(BRIDGE_DIR, 'results.jsonl');

const ALLOWED_HOSTS = new Set(['localhost:1420', '127.0.0.1:1420']);
const ALLOWED_ORIGINS = new Set([
  'http://localhost:1420',
  'tauri://localhost',
  'http://tauri.localhost',
]);

const MAX_BODY_BYTES = 5 * 1024 * 1024; // generous cap so a large eval body still lands
const MAX_WAIT_SECONDS = 60;
const DEFAULT_WAIT_SECONDS = 10;

// Read a request body as a string, rejecting once it grows past the cap.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function appendLine(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch {
    // A failed append must never take down the dev server.
  }
}

export function agentBridge() {
  // Per-server-start state. `configureServer` runs again on each in-process
  // restart, so everything below is freshly created then.
  let token = '';
  let nextId = 1;
  let queue = []; // pending { id, code } waiting to be pulled by the webview
  const waiters = new Map(); // id -> { resolve, timer } for /__agent/eval holds

  return {
    name: 'agent-bridge',
    apply: 'serve',
    configureServer(server) {
      // Vitest also loads vite.config.ts and would run this hook in its own
      // throwaway server, clobbering the live dev server's token file. Skip it.
      if (process.env.VITEST) return;
      fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      token = crypto.randomBytes(16).toString('hex');
      try {
        fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
        // writeFileSync only applies mode when creating; force it for reuse too.
        fs.chmodSync(TOKEN_PATH, 0o600);
      } catch {
        // If we cannot persist the token the bridge is unusable, but the dev
        // server must still boot normally.
      }
      appendLine(CONSOLE_PATH, {
        ts: Date.now(),
        level: 'info',
        text: '[bridge] dev server (re)started',
      });

      server.config.logger.info('  agent-bridge: dev console/eval bridge active at /__agent/*');

      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url || '';
        if (!rawUrl.startsWith('/__agent/')) {
          next();
          return;
        }

        // Guard 1: Host header (blocks DNS-rebinding to another hostname).
        // NOTE: the Host header is client-controlled, so this is NOT a
        // network-origin control -- a non-browser client (curl) can spoof it.
        // The real containment is that Vite binds localhost only (no server.host
        // in vite.config.ts), so the bridge is never reachable off-box. Keep that
        // localhost bind; do not add server.host without re-auditing this bridge.
        const host = req.headers.host || '';
        if (!ALLOWED_HOSTS.has(host)) {
          sendText(res, 403, 'forbidden');
          return;
        }
        // Guard 2: Origin, when present, must be a known dev/tauri origin.
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin)) {
          sendText(res, 403, 'forbidden');
          return;
        }

        let url;
        try {
          url = new URL(rawUrl, 'http://localhost:1420');
        } catch {
          sendText(res, 400, 'bad request');
          return;
        }
        const pathname = url.pathname;
        const method = req.method || 'GET';

        // GET /__agent/token: readable without the token (that is how the
        // webview obtains it). No CORS headers are set, so a cross-origin
        // browser fetch cannot read the response body.
        if (pathname === '/__agent/token' && method === 'GET') {
          sendText(res, 200, token);
          return;
        }

        // Token check for everything else.
        const provided = req.headers['x-agent-token'] || url.searchParams.get('token') || '';
        if (provided !== token) {
          sendText(res, 403, 'forbidden');
          return;
        }

        if (pathname === '/__agent/console' && method === 'POST') {
          readBody(req)
            .then((body) => {
              let entries;
              try {
                entries = JSON.parse(body);
              } catch {
                sendText(res, 400, 'bad json');
                return;
              }
              if (Array.isArray(entries)) {
                for (const e of entries) {
                  if (e && typeof e === 'object') {
                    appendLine(CONSOLE_PATH, {
                      ts: typeof e.ts === 'number' ? e.ts : Date.now(),
                      level: typeof e.level === 'string' ? e.level : 'log',
                      text: typeof e.text === 'string' ? e.text : String(e.text),
                    });
                  }
                }
              }
              res.statusCode = 204;
              res.end();
            })
            .catch(() => sendText(res, 400, 'bad request'));
          return;
        }

        if (pathname === '/__agent/eval' && method === 'POST') {
          readBody(req)
            .then((code) => {
              const id = nextId++;
              queue.push({ id, code });

              const waitRaw = Number(url.searchParams.get('wait'));
              const waitSeconds = Number.isFinite(waitRaw)
                ? Math.min(Math.max(waitRaw, 0), MAX_WAIT_SECONDS)
                : DEFAULT_WAIT_SECONDS;

              if (waitSeconds <= 0) {
                sendJson(res, 200, { id, status: 'pending' });
                return;
              }

              const timer = setTimeout(() => {
                waiters.delete(id);
                sendJson(res, 200, { id, status: 'pending' });
              }, waitSeconds * 1000);

              waiters.set(id, {
                resolve: (result) => {
                  clearTimeout(timer);
                  waiters.delete(id);
                  sendJson(res, 200, result);
                },
                timer,
              });
            })
            .catch(() => sendText(res, 400, 'bad request'));
          return;
        }

        if (pathname === '/__agent/pull' && method === 'GET') {
          const batch = queue;
          queue = [];
          sendJson(res, 200, batch);
          return;
        }

        if (pathname === '/__agent/result' && method === 'POST') {
          readBody(req)
            .then((body) => {
              let result;
              try {
                result = JSON.parse(body);
              } catch {
                sendText(res, 400, 'bad json');
                return;
              }
              const id = result && typeof result.id === 'number' ? result.id : null;
              appendLine(RESULTS_PATH, { ts: Date.now(), ...result });
              if (id !== null) {
                const waiter = waiters.get(id);
                if (waiter) waiter.resolve(result);
              }
              res.statusCode = 204;
              res.end();
            })
            .catch(() => sendText(res, 400, 'bad request'));
          return;
        }

        sendText(res, 404, 'not found');
      });
    },
  };
}

export default agentBridge;
