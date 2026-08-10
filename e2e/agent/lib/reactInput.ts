/**
 * In-page script bodies (run via `evalInApp`) that deliver a value into a
 * form control the way React's controlled-input machinery can see it (#531).
 *
 * `element.value = text` on a React-controlled input writes through the
 * instance-level setter React installs on the node, which also updates
 * React's internal value tracker - so a later native `input` event finds
 * tracker.getValue() already equal to the DOM value and treats it as a
 * no-op, and onChange never fires. This bit macOS's tauri-wd route
 * specifically: its WebDriver `setValue()` sets the DOM value directly
 * (no real per-keystroke events), so the text "lands" (a plain DOM read
 * matches) while React state stays stale.
 *
 * The fix is the well-known React workaround: write through the
 * *prototype's* value setter (bypassing the instance-level override React
 * installed, so the tracker is NOT updated) and then dispatch a real
 * `input` event. React's listener compares the tracker's stale value
 * against the now-different DOM value, sees a change, and fires onChange.
 *
 * Exported as script-body strings (not functions) because `evalInApp`
 * ships them across the WebDriver boundary as source text - see
 * `e2e/agent/lib/page.ts`. `reactInput.test.ts` runs this same string
 * in-process (mocked `browser.executeAsync` + jsdom) against a real
 * controlled React input, so it is exercised by more than a manual replay.
 */

/**
 * args: [selector: string, text: string, clear: boolean]
 * result: { ok: boolean; verified?: boolean }
 */
export const REACT_SAFE_SET_VALUE_SCRIPT = `
  const el = document.querySelector(args[0]);
  if (!el) return { ok: false };
  const text = args[1];
  const clear = args[2];
  const isTextarea = el.tagName === 'TEXTAREA';
  const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const fire = (v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  el.focus();
  if (clear && el.value !== '') fire('');
  fire(text);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, verified: el.value === text };
`;

/**
 * Fallback for `press_keys(['Escape'])` on the macOS tauri-wd route (#531):
 * the native WebDriver key action there lands on the window, not the
 * webview's focused element, so Escape is silently dropped. Synthesizes the
 * KeyboardEvent directly on `document.activeElement` instead.
 *
 * args: none
 * result: true
 */
export const SYNTHETIC_ESCAPE_KEYDOWN_SCRIPT = `
  const active = document.activeElement;
  const target = active && active !== document.body ? active : document;
  const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
`;
