/**
 * Keep webdriver's fetch dispatch inside ITS OWN undici copy (Node >= 26).
 *
 * All undici copies share one global-dispatcher slot on globalThis
 * (Symbol.for('undici.globalDispatcher.1')), and Node's BUILTIN undici (v8)
 * rewrites that slot with a compat wrapper ('Dispatcher1Wrapper') on the first
 * use of global fetch - even when another copy's Agent already sits there, and
 * at any later point in the process lifetime. webdriver's bundled undici (v6)
 * getGlobalDispatcher() then hands that foreign wrapper to its dispatcher
 * picker, which mistakes it for a deliberate custom dispatcher and routes its
 * undici-6 fetch through undici-8 internals; the cross-copy conversion mangles
 * the request and every WebDriver command dies with UND_ERR_INVALID_ARG
 * ("invalid content-length header") before reaching tauri-driver.
 *
 * A one-shot setGlobalDispatcher() pin loses that race (the next builtin fetch
 * re-poisons the slot), so instead patch the getGlobalDispatcher EXPORT of the
 * undici instance webdriver resolves: whenever the slot holds anything that is
 * not a plain Agent/MockAgent, return a stable plain Agent from that same
 * instance. webdriver's picker then falls through to building its own
 * per-session Agent, keeping the whole request path in one undici copy.
 *
 * MUST be imported before webdriverio: the ESM wrapper for the CJS undici
 * module snapshots export values when webdriver's import links, so the patch
 * has to land first - session.ts lists this module as its first import for
 * exactly that reason. Inert where the slot never goes foreign (Node 22/24).
 * Best-effort by design: a resolution failure leaves webdriver untouched to
 * fail (or work) exactly as it would have anyway.
 */
import { createRequire } from 'module';

type DispatcherLike = { constructor: { name: string } };
type UndiciExports = {
  getGlobalDispatcher: () => DispatcherLike | undefined;
  Agent: new () => DispatcherLike;
};

try {
  const hereRequire = createRequire(import.meta.url);
  const webdriverMain = createRequire(hereRequire.resolve('webdriverio')).resolve('webdriver');
  const undici = createRequire(webdriverMain)('undici') as UndiciExports;
  const original = undici.getGlobalDispatcher.bind(undici);
  let pinned: DispatcherLike | undefined;
  undici.getGlobalDispatcher = () => {
    const current = original();
    const name = current?.constructor?.name;
    if (name === 'Agent' || name === 'MockAgent') return current;
    pinned ??= new undici.Agent();
    return pinned;
  };
} catch {
  // Never let the pin break a session start; without it the attach fails with
  // the UND_ERR_INVALID_ARG explainer in session.ts.
}
