/**
 * Input-modality tracking for keyboard-only focus rings.
 *
 * The focus ring (the global :focus-visible outline + the Tailwind focus rings)
 * should only show during keyboard navigation, not on mouse clicks — while the
 * element is still focused. :focus-visible alone is unreliable across engines
 * (notably the WebKitGTK webview Tauri uses, which matches :focus-visible on
 * mouse clicks), so we tag <html data-input-modality="pointer|keyboard"> and
 * gate the ring on it in index.css.
 *
 * Runs as a module side-effect (called from main.tsx) rather than a React effect
 * so it is set before first paint and is immune to Fast Refresh skipping it.
 */

// Keys that count as keyboard navigation/interaction (reveal the ring). Typing
// printable characters does not — clicking a field then typing keeps it ringless.
const NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
  'Escape',
]);

type Modality = 'pointer' | 'keyboard';

function setModality(m: Modality): void {
  const el = document.documentElement;
  if (el.dataset.inputModality !== m) {
    el.dataset.inputModality = m;
  }
}

let installed = false;

export function initInputModalityTracking(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // Default to pointer (no ring) before any interaction.
  setModality('pointer');
  if (installed) return;
  installed = true;

  const onPointer = () => setModality('pointer');
  const onKey = (e: KeyboardEvent) => {
    if (NAV_KEYS.has(e.key)) setModality('keyboard');
  };

  // Capture phase so modality is set before focus/click handlers run.
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('mousedown', onPointer, true); // fallback if no Pointer Events
  window.addEventListener('touchstart', onPointer, true);
  // Mouse *movement* also means pointer modality. This matters for UI that grabs
  // focus on hover (e.g. tool-group flyouts focus a menu item when they open): a
  // hover doesn't fire pointerdown, so without this the modality could stay
  // 'keyboard' and the programmatic focus would draw a ring. setModality is a
  // cheap no-op once already 'pointer', so the high event rate is fine.
  window.addEventListener('pointermove', onPointer, true);
  window.addEventListener('mousemove', onPointer, true);
  window.addEventListener('keydown', onKey, true);
}
