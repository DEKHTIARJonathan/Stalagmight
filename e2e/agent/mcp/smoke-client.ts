/**
 * MCP-layer smoke test: spawns e2e/agent/mcp/server.ts as a real MCP stdio
 * server, lists its tools, and (unless AGENT_MCP_SMOKE_LIFECYCLE=0) drives a
 * full app lifecycle through the protocol: app_start -> screenshot -> store_state
 * -> ipc -> logs -> eval -> app_stop. This proves the transport framing is clean
 * (any stray stdout from the server would break JSON-RPC and fail here) and that
 * every tool round-trips. Run under the repo-pinned Node 22 (see .nvmrc):
 *
 *   pnpm agent:mcp:smoke
 *
 * It spawns the server with the SAME node that runs this client (process.execPath)
 * plus tsx, so a Node-22 client yields a Node-22 server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';

const serverPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'server.ts');
const withLifecycle = process.env.AGENT_MCP_SMOKE_LIFECYCLE !== '0';

interface ToolText {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}

function parseText(res: ToolText): unknown {
  const textPart = res.content.find((c) => c.type === 'text');
  if (!textPart?.text) return null;
  try {
    return JSON.parse(textPart.text);
  } catch {
    return textPart.text;
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'stalagmight-mcp-smoke', version: '0.1.0' });
  await client.connect(transport);

  let failed = false;
  const check = (label: string, ok: boolean, detail?: unknown) => {
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}\n`);
    if (!ok) failed = true;
  };

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = [
      'app_start', 'app_stop', 'app_restart', 'app_status',
      'screenshot', 'store_state', 'logs', 'wait_for',
      'click', 'type_text', 'press_keys', 'eval', 'ipc',
      'store_action', 'map_view', 'map_click',
    ];
    const missing = expected.filter((n) => !names.includes(n));
    check(`tools/list has all ${expected.length} core tools`, missing.length === 0, missing.length ? { missing } : names.length);

    if (!withLifecycle) {
      check('lifecycle skipped (AGENT_MCP_SMOKE_LIFECYCLE=0)', true);
      await client.close();
      process.exit(failed ? 1 : 0);
    }

    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<ToolText>;

    const started = (await call('app_start', { build: 'auto' })) as ToolText;
    const startVal = parseText(started) as { state?: string; error?: string; sessionDir?: string };
    check('app_start -> ready', startVal?.state === 'ready', startVal?.error ?? startVal?.state);
    if (startVal?.state !== 'ready') throw new Error(`app_start failed: ${JSON.stringify(startVal)}`);

    const status = parseText(await call('app_status')) as { driverAlive?: boolean };
    check('app_status driverAlive', status?.driverAlive === true);

    const shot = (await call('screenshot', { name: 'smoke' })) as ToolText;
    const hasImage = shot.content.some((c) => c.type === 'image' && typeof c.data === 'string' && c.data.length > 100);
    check('screenshot returns image content', hasImage);

    const ui = parseText(await call('store_state', { store: 'ui' })) as { keys?: unknown[] };
    check('store_state ui has keys', Array.isArray(ui?.keys) && ui.keys.length > 0, ui?.keys?.length);

    const view = parseText(await call('store_state', { store: 'ui', path: 'view' })) as { value?: unknown };
    check('store_state ui.view reads a value', view !== null && 'value' in (view as object), view);

    const ipcRes = parseText(await call('ipc', { command: 'get_recent_logs_since', args: { afterSeq: 0 } })) as {
      value?: { latest_seq?: number };
    };
    check('ipc get_recent_logs_since', ipcRes?.value?.latest_seq !== undefined, ipcRes?.value?.latest_seq);

    const evalRes = parseText(await call('eval', { script: 'return 6 * 7;' })) as { value?: unknown };
    check('eval returns computed value', evalRes?.value === 42, evalRes?.value);

    const logs = parseText(await call('logs', { level: 'all' })) as { latestSeq?: number };
    check('logs read', typeof logs?.latestSeq === 'number');

    const wait = parseText(await call('wait_for', { condition: 'app-ready', timeoutMs: 5000 })) as { met?: boolean };
    check('wait_for app-ready', wait?.met === true);

    const stopped = parseText(await call('app_stop')) as { stopped?: boolean };
    check('app_stop', stopped?.stopped === true);
  } catch (err) {
    check('unexpected exception', false, err instanceof Error ? err.message : String(err));
  } finally {
    await client.close().catch(() => undefined);
  }

  process.stdout.write(failed ? '\nMCP SMOKE FAILED\n' : '\nMCP SMOKE PASSED\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
