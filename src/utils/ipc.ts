import { invoke } from '@tauri-apps/api/core';
import { trackCommand } from './telemetry';
import { trackInvoke } from './debugLockup';
import type { IpcCommands } from '../types/ipc/IpcCommands';
import type { CommandResult } from '../types/ipc/CommandResult';

const IPC_TRACE = import.meta.env.VITE_IPC_TRACE === 'true';

/** Commands that should not be tracked (telemetry's own IPC calls). */
const UNTRACKED_COMMANDS: ReadonlySet<string> = new Set([
  'track_events',
  'flush_telemetry',
  'is_telemetry_available',
  'set_telemetry_enabled',
] satisfies IpcCommandName[]);

/** Every command the backend registers (`generate_handler!`), per the generated manifest (#576 C3). */
export type IpcCommandName = keyof IpcCommands;
/** The arguments `command` takes: camelCase keys, `Option` arguments omittable. */
export type IpcArgs<K extends IpcCommandName> = IpcCommands[K]['args'];
/** What `command` resolves with. */
export type IpcResult<K extends IpcCommandName> = IpcCommands[K]['result'];

type OptionalKey<T, P extends keyof T> = Partial<Pick<T, P>> extends Pick<T, P> ? true : false;
/** On the wire an omitted key and an explicit `undefined` are the same (JSON drops it). */
type WireArgs<T> = { [P in keyof T]: OptionalKey<T, P> extends true ? T[P] | undefined : T[P] };

/** `args` may be left out when the command takes none, or only optional ones. */
type IpcRest<K extends IpcCommandName> =
  Record<string, never> extends IpcArgs<K>
    ? [args?: WireArgs<IpcArgs<K>> | undefined, meta?: IpcMeta]
    : [args: WireArgs<IpcArgs<K>>, meta?: IpcMeta];

/** The args object `command` takes, as a caller writes it (an omittable key may be `undefined`). */
export type IpcCallArgs<K extends IpcCommandName> = WireArgs<IpcArgs<K>>;

/**
 * [#576 RV5-PI-6] The args a caller hands a dispatcher that forwards `command` (the
 * mutation queue's `executeCommand` / `executeUndoRedo`): omittable only when the
 * command takes no required argument - the rule {@link IpcRest} gives `invokeIpc`.
 */
export type QueuedCallArgs<K extends IpcCommandName> =
  Record<string, never> extends IpcArgs<K> ? IpcCallArgs<K> | undefined : IpcCallArgs<K>;

/** The commands that answer with a `CommandResult` - the ones projectStore's mutation queue runs. */
export type CommandResultCommand = {
  [K in IpcCommandName]: IpcResult<K> extends CommandResult ? K : never;
}[IpcCommandName];

/** Tauri plugin commands (`plugin:<name>|<command>`) are not in the manifest: untyped. */
type PluginCommand = `plugin:${string}|${string}`;

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

/**
 * Typed by the generated command manifest (#576 C3): the command name must be one
 * the backend registers, `args` must match its `#[tauri::command]` parameters,
 * and the promise resolves with the type the command returns - no caller-asserted
 * result type.
 */
export type InvokeIpc = {
  (command: PluginCommand, args?: Record<string, unknown>, meta?: IpcMeta): Promise<unknown>;
  <K extends IpcCommandName>(command: K, ...rest: IpcRest<K>): Promise<IpcResult<K>>;
};

/** The untyped transport both implementations share. */
type RawInvoke = (command: string, args?: Record<string, unknown>, meta?: IpcMeta) => Promise<unknown>;

const invokeWithTrace: RawInvoke = async (command, args, meta) => {
  if (!UNTRACKED_COMMANDS.has(command)) trackCommand(command);
  const start = nowMs();
  const purpose = meta?.purpose ?? 'unspecified purpose';
  const fields = meta?.fields ?? {};
  const logStart = meta?.level === 'info' ? console.info : console.debug;

  logStart(`[IPC] invoking ${command} for ${purpose}`, { command, purpose, ...fields });

  try {
    const result = await trackInvoke(command, invoke<unknown>(command, args));
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

const invokeNoTrace: RawInvoke = (command, args, _meta) => {
  if (!UNTRACKED_COMMANDS.has(command)) trackCommand(command);
  return trackInvoke(command, invoke<unknown>(command, args));
};

/**
 * Invoke a Tauri IPC command with optional trace logging.
 * Logs are compiled out in production unless VITE_IPC_TRACE is enabled.
 */
export const invokeIpc = (IPC_TRACE ? invokeWithTrace : invokeNoTrace) as InvokeIpc;

/**
 * How a dispatcher that forwards a command name it was handed (the mutation
 * queue) calls `invokeIpc`: `(invokeIpc as ForwardedInvoke)(command, args, meta)`.
 * The name is still checked and the result is still the one the command
 * declares; the arguments were checked where the dispatcher itself was called,
 * against `QueuedCallArgs<K>`. A type, not a second export, so a test that mocks
 * this module with `{ invokeIpc }` alone still mocks every call.
 */
export type ForwardedInvoke = <K extends IpcCommandName>(
  command: K,
  args: Record<string, unknown> | undefined,
  meta?: IpcMeta
) => Promise<IpcResult<K>>;

/** Extract error message from unknown catch value */
export function getErrorMessage(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  // [Track A] #186/D-B2: structured IPC errors (e.g. SpeleoErrorDto) reject with
  // an object carrying a `message` string - surface it instead of "[object
  // Object]". The typed `action` field is branched on separately (#204).
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return fallback ?? String(e);
}
