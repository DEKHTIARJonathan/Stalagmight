import { invoke } from '@tauri-apps/api/core';

const IPC_TRACE = import.meta.env.VITE_IPC_TRACE === 'true';

export type IpcMeta = {
  purpose?: string;
  fields?: Record<string, unknown>;
  level?: 'debug' | 'info';
};

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export type InvokeIpc = <T>(
  command: string,
  args?: Record<string, unknown>,
  meta?: IpcMeta
) => Promise<T>;

const invokeWithTrace: InvokeIpc = async <T>(command: string, args?: Record<string, unknown>, meta?: IpcMeta) => {
  const start = nowMs();
  const purpose = meta?.purpose ?? 'unspecified purpose';
  const fields = meta?.fields ?? {};
  const logStart = meta?.level === 'info' ? console.info : console.debug;

  logStart(`[IPC] invoking ${command} for ${purpose}`, { command, purpose, ...fields });

  try {
    const result = await invoke<T>(command, args);
    const durationMs = Math.round(nowMs() - start);
    console.debug(`[IPC] success ${command}`, { command, purpose, duration_ms: durationMs, ...fields });
    return result;
  } catch (err) {
    const durationMs = Math.round(nowMs() - start);
    console.error(`[IPC] failed ${command} for ${purpose}`, {
      command,
      purpose,
      duration_ms: durationMs,
      reason: errorToString(err),
      ...fields,
    });
    throw err;
  }
};

const invokeNoTrace: InvokeIpc = <T>(command: string, args?: Record<string, unknown>, _meta?: IpcMeta) =>
  invoke<T>(command, args);

/**
 * Invoke a Tauri IPC command with optional trace logging.
 * Logs are compiled out in production unless VITE_IPC_TRACE is enabled.
 */
export const invokeIpc: InvokeIpc = IPC_TRACE ? invokeWithTrace : invokeNoTrace;
