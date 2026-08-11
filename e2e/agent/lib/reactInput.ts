/**
 * In-page script bodies (run via `evalInApp`) that recover two macOS
 * tauri-wd route defects, both observed during the #394 walkthrough and
 * filed as #531:
 *
 * 1. `type_text`: typing into a controlled React input through the driver's
 *    `setValue()` lands the DOM value (a plain read-back matches) but
 *    React's onChange never fires, so component state stays stale. The
 *    well-known workaround - write through the value setter on the
 *    element's PROTOTYPE (bypassing the instance-level setter React
 *    installs on a controlled node, which is what stops a plain
 *    `el.value = x` + `input` event from being seen as a change) and then
 *    dispatch a real `input` event - is verified to work here:
 *    `reactInput.test.ts` runs this exact script against a live
 *    React-rendered controlled `<input>` and asserts onChange fires.
 * 2. `press_keys(['Escape'])`: the native WebDriver key action produces no
 *    observable effect on this route (no error, no app response). A
 *    manually dispatched `KeyboardEvent('keydown', {key: 'Escape'})` on the
 *    focused element does. This module does not diagnose *why* the native
 *    path drops the key - only what was observed - and ships the dispatch
 *    as a documented fallback.
 *
 * Exported as script-body strings (not functions) because `evalInApp` ships
 * them across the WebDriver boundary as source text - see
 * `e2e/agent/lib/page.ts`.
 */

/**
 * INPUT types this script treats as free-text entry - the ones where typing
 * a string is the whole interaction. Deliberately excludes date/time/month/
 * week/datetime-local: those are segmented native pickers a single string
 * assignment does not faithfully replay (format/locale-sensitive, no keyed
 * per-segment interaction), plus color/range/file/checkbox/radio/button/
 * submit/reset/hidden/image, none of which "typing text" describes.
 *
 * args: [selector: string, text: string, clear: boolean]
 * result: { ok: boolean; verified?: boolean; truncated?: boolean; reason?: string }
 */
export const REACT_SAFE_SET_VALUE_SCRIPT = `
  const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
  const el = document.querySelector(args[0]);
  if (!el) return { ok: false, reason: 'not-found' };
  const text = args[1];
  const clear = args[2];
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
    // Native setter + input event only makes sense for INPUT/TEXTAREA -
    // a SELECT has its own dedicated select_option tool, and anything else
    // (e.g. contenteditable) is not a control this harness claims to type
    // into.
    return { ok: false, reason: 'unsupported-element' };
  }
  if (tag === 'INPUT' && !TEXT_INPUT_TYPES.includes(el.type)) {
    // A checkbox/radio/date/color/file/etc. has a value the prototype
    // setter would happily overwrite as a string, certifying a write that
    // never touched the control's actual (checked/segmented/file) state.
    return { ok: false, reason: 'not-a-text-input' };
  }
  if (el.disabled || el.readOnly) {
    // The prototype setter writes through disabled/readOnly - certifying
    // that write as "typed" would hide a real read-only-mode regression.
    return { ok: false, reason: 'not-editable' };
  }
  const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = descriptor && descriptor.set;
  if (!setter) return { ok: false, reason: 'no-native-setter' };
  const fire = (v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // The prototype setter bypasses maxLength the same way it bypasses
  // disabled/readOnly - real typing truncates at the limit, so mirror that
  // here rather than certifying a value a user could never have produced.
  let truncated = false;
  let target = text;
  if (typeof el.maxLength === 'number' && el.maxLength >= 0 && target.length > el.maxLength) {
    target = target.slice(0, el.maxLength);
    truncated = true;
  }
  el.focus();
  if (clear && el.value !== '') fire('');
  fire(target);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // A synchronous read here only proves the DOM accepted our assignment -
  // exactly the non-evidence this whole workaround exists to get past.
  // Give React (and any app-level validation/clamping in onChange, e.g. a
  // maxLength clamp) a tick to commit its re-render before reading back.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ok: true, verified: el.value === target, truncated };
`;

/**
 * Synthesize a keydown/keyup pair for a key whose native WebDriver delivery
 * was observed to drop on the macOS tauri-wd route (#531: 'Escape'; also
 * used for the Enter that `type_text`'s `submit` relies on).
 *
 * Prefers the focused element (an event dispatched there bubbles up through
 * the app's mounted root on its way to document, so any listener along that
 * path still sees it). When nothing is focused, dispatching on `document`
 * would NOT reach the app: React 18 delegates its listeners to the root
 * container it was `createRoot()`-ed on (`src/main.tsx`, `#root`), which
 * sits BELOW document in the tree - an event dispatched at document only
 * bubbles further up, never down into `#root`'s descendants. So the
 * nothing-focused fallback targets `#root` itself (a `dispatchEvent` call
 * fires same-node listeners too, not just descendants' bubbled ones).
 *
 * args: [key: string]
 * result: true
 */
export const SYNTHETIC_KEY_SCRIPT = `
  const key = args[0];
  const keyCodes = { Escape: 27, Enter: 13 };
  const active = document.activeElement;
  const appRoot = document.getElementById('root');
  const target = active && active !== document.body ? active : appRoot || document;
  const opts = {
    key,
    code: key,
    keyCode: keyCodes[key] || 0,
    which: keyCodes[key] || 0,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
`;
