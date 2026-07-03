/**
 * Zustand store access via window.__E2E_TEST__. Reads are synchronous
 * (getState) so they use `execute`; actions may be async so they use
 * `executeAsync`.
 */
import type { Browser } from 'webdriverio';

export type StoreName = 'ui' | 'project' | 'globalView' | 'gasPlan' | 'speleo' | 'export' | 'network';

// Kept in sync with the store keys exposed in src/main.tsx's __E2E_TEST__ block.
const STORE_KEY: Record<StoreName, string> = {
  ui: 'uiStore',
  project: 'projectStore',
  globalView: 'globalViewStore',
  gasPlan: 'gasPlanStore',
  speleo: 'speleoStore',
  export: 'exportStore',
  network: 'networkStore',
};

export interface StoreKeySummary {
  keys: { key: string; type: string }[];
}
export interface StoreValue {
  value: unknown;
  truncated: boolean;
}

/**
 * Read a store. With no `dotPath`, returns a key/type summary (avoids dumping a
 * multi-thousand-line state). With a `dotPath`, returns that value, JSON-capped
 * at `maxBytes` (functions render as "[function]").
 */
export async function readStore(
  browser: Browser,
  store: StoreName,
  dotPath: string | null = null,
  maxBytes = 16384,
): Promise<StoreKeySummary | StoreValue> {
  const result = await browser.execute(
    (storeKey: string, path: string | null, cap: number) => {
      const e2e = (window as unknown as Record<string, Record<string, { getState: () => unknown }>>)
        .__E2E_TEST__;
      const s = e2e?.[storeKey];
      if (!s) return { __agentError: `store ${storeKey} unavailable` };
      let value: unknown = s.getState();
      if (path) {
        for (const part of path.split('.')) {
          if (value == null) break;
          value = (value as Record<string, unknown>)[part];
        }
        let json: string;
        try {
          json = JSON.stringify(value, (_k, v) => (typeof v === 'function' ? '[function]' : v));
        } catch {
          return { value: '[unserializable]', truncated: false };
        }
        if (json === undefined) return { value: undefined, truncated: false };
        if (json.length > cap) return { value: `${json.slice(0, cap)}...`, truncated: true };
        return { value: JSON.parse(json), truncated: false };
      }
      const obj = value as Record<string, unknown>;
      const keys =
        obj && typeof obj === 'object'
          ? Object.keys(obj).map((k) => ({ key: k, type: typeof obj[k] }))
          : [];
      return { keys };
    },
    STORE_KEY[store],
    dotPath,
    maxBytes,
  );
  if (result && typeof result === 'object' && '__agentError' in result) {
    throw new Error(String((result as { __agentError: string }).__agentError));
  }
  return result as StoreKeySummary | StoreValue;
}

/** Call an action on a store, awaiting a promise result. Returns {ok, result?, error?}. */
export async function callStoreAction(
  browser: Browser,
  store: StoreName,
  action: string,
  args: unknown[] = [],
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return browser.executeAsync(
    (storeKey: string, actionName: string, actionArgs: unknown[], done: (r: unknown) => void) => {
      const e2e = (
        window as unknown as Record<string, Record<string, { getState: () => Record<string, unknown> }>>
      ).__E2E_TEST__;
      const s = e2e?.[storeKey];
      if (!s) {
        done({ ok: false, error: `store ${storeKey} unavailable` });
        return;
      }
      const state = s.getState();
      const fn = state[actionName];
      if (typeof fn !== 'function') {
        done({ ok: false, error: `action ${actionName} is not a function` });
        return;
      }
      try {
        Promise.resolve((fn as (...a: unknown[]) => unknown)(...actionArgs))
          .then((result) => {
            let safe: unknown = result;
            try {
              safe = JSON.parse(JSON.stringify(result ?? null));
            } catch {
              safe = '[unserializable]';
            }
            done({ ok: true, result: safe });
          })
          .catch((err: unknown) => done({ ok: false, error: String(err) }));
      } catch (err) {
        done({ ok: false, error: String(err) });
      }
    },
    STORE_KEY[store],
    action,
    args,
  ) as Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface PostDigest {
  view: string | null;
  dialog: string | null;
  activeTool: string | null;
  projectName: string | null;
  projectOpen: boolean;
}

/** One cheap read of the load-bearing UI/project state, for the action log's `post`. */
export async function postDigest(browser: Browser): Promise<PostDigest> {
  return browser.execute(() => {
    const e2e = (
      window as unknown as {
        __E2E_TEST__?: {
          uiStore?: { getState: () => { view?: string; activeDialog?: string | null; activeTool?: string | null } };
          projectStore?: { getState: () => { project?: { metadata?: { name?: string } } | null } };
        };
      }
    ).__E2E_TEST__;
    const ui = e2e?.uiStore?.getState();
    const project = e2e?.projectStore?.getState()?.project ?? null;
    return {
      view: ui?.view ?? null,
      dialog: ui?.activeDialog ?? null,
      activeTool: ui?.activeTool ?? null,
      projectName: project?.metadata?.name ?? null,
      projectOpen: Boolean(project),
    };
  }) as Promise<PostDigest>;
}
