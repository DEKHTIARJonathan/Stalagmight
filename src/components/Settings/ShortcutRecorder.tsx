/**
 * ShortcutRecorder component for capturing keyboard shortcuts.
 *
 * Features:
 * - Click to enter recording mode
 * - Captures keyboard combos on keydown, completes on keyup
 * - Escape cancels recording
 * - Blocks F1-F12, Tab, CapsLock, Meta keys
 * - Keyboard-style badge display with platform symbols
 * - Clear button to remove binding
 * - ARIA accessibility support
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { parseKeyEvent, formatShortcut, isMac } from '../../utils/shortcuts';

/**
 * Keys that are blocked from being assigned as shortcuts.
 * These are either OS-reserved or have special handling.
 */
export const BLOCKED_KEYS: ReadonlySet<string> = new Set([
  // Function keys
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  // Special keys
  'Tab',
  'Enter',
  'CapsLock',
  'Meta', // OS key (Windows/Command)
  'OS', // Firefox name for Meta
]);

/**
 * Check if a KeyboardEvent represents a blocked key.
 * Uses BLOCKED_KEYS set for consistent blocking.
 */
export function isBlockedKey(event: KeyboardEvent): boolean {
  return BLOCKED_KEYS.has(event.key);
}

/**
 * Format a single key part as a keyboard badge.
 */
function KeyBadge({ keyPart }: { keyPart: string }) {
  return (
    <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-medium bg-panel border border-border rounded shadow-sm min-w-[1.5rem]">
      {keyPart}
    </span>
  );
}

export interface ShortcutRecorderProps {
  /** Current shortcut value (normalized form, e.g., "Ctrl+S") */
  value: string | null;
  /** Called when shortcut changes */
  onChange: (shortcut: string | null) => void;
  /** Called when a blocked key is pressed (for error feedback) */
  onBlockedKey?: (key: string) => void;
  /** Unique ID for ARIA labeling */
  id?: string;
  /** Accessible label */
  ariaLabel?: string;
  /** Whether the recorder is disabled */
  disabled?: boolean;
  /** Test ID for testing */
  'data-testid'?: string;
}

export function ShortcutRecorder({
  value,
  onChange,
  onBlockedKey,
  id,
  ariaLabel = 'Keyboard shortcut',
  disabled = false,
  'data-testid': testId,
}: ShortcutRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Use refs to avoid stale closures in event handlers
  const pendingShortcutRef = useRef<string | null>(null);
  const isCapturingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onBlockedKeyRef = useRef(onBlockedKey);

  // Keep refs in sync with props/state
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onBlockedKeyRef.current = onBlockedKey;
  }, [onBlockedKey]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Start recording on click
  const handleClick = useCallback(() => {
    if (disabled) return;

    setIsRecording(true);
    setPendingShortcut(null);
    pendingShortcutRef.current = null;
    isCapturingRef.current = false;
    setAnnouncement('Recording shortcut. Press a key combination, or Escape to cancel.');
  }, [disabled]);

  // Cancel recording
  const cancelRecording = useCallback(() => {
    setIsRecording(false);
    setPendingShortcut(null);
    pendingShortcutRef.current = null;
    isCapturingRef.current = false;
    setAnnouncement('Recording cancelled.');
  }, []);

  // Cancel recording when value is externally reset (e.g., "Reset to default")
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (isRecording && value !== prevValueRef.current) {
      cancelRecording();
    }
    prevValueRef.current = value;
  }, [value, isRecording, cancelRecording]);

  // Complete recording with current pending shortcut (reads from ref)
  const completeRecording = useCallback(() => {
    const captured = pendingShortcutRef.current;
    if (captured) {
      onChangeRef.current(captured);
      setAnnouncement(`Shortcut set to ${captured}.`);
    }
    setIsRecording(false);
    setPendingShortcut(null);
    pendingShortcutRef.current = null;
    isCapturingRef.current = false;
  }, []);

  // Stable keydown handler - reads from refs to avoid stale closures
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isRecordingRef.current) return;

      event.preventDefault();
      event.stopPropagation();

      // Escape cancels (allow even on repeat)
      if (event.key === 'Escape') {
        cancelRecording();
        return;
      }

      // Ignore repeated key events (except Escape)
      if (event.repeat) {
        return;
      }

      // Check for blocked keys
      if (isBlockedKey(event)) {
        onBlockedKeyRef.current?.(event.key);
        setAnnouncement(`${event.key} is not allowed. Try a different key.`);
        return;
      }

      // Ignore modifier-only presses
      if (['Control', 'Alt', 'Shift'].includes(event.key)) {
        return;
      }

      // Parse and set pending shortcut
      const shortcut = parseKeyEvent(event);
      if (shortcut) {
        pendingShortcutRef.current = shortcut;
        setPendingShortcut(shortcut);
        isCapturingRef.current = true;
        setAnnouncement(`Captured ${shortcut}. Release to confirm.`);
      }
    },
    [cancelRecording]
  );

  // Stable keyup handler - reads from refs to avoid stale closures
  const handleKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (!isRecordingRef.current || !isCapturingRef.current) return;

      event.preventDefault();
      event.stopPropagation();

      // Ignore modifier releases
      if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(event.key)) {
        return;
      }

      // Complete recording
      completeRecording();
    },
    [completeRecording]
  );

  // Attach/detach global keyboard listeners once when recording starts
  useEffect(() => {
    if (isRecording) {
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('keyup', handleKeyUp, true);

      return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('keyup', handleKeyUp, true);
      };
    }
    return undefined;
  }, [isRecording, handleKeyDown, handleKeyUp]);

  // Handle blur - cancel recording
  useEffect(() => {
    const handleBlur = () => {
      if (isRecordingRef.current) {
        cancelRecording();
      }
    };

    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [cancelRecording]);

  // Clear shortcut handler
  const handleClear = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onChange(null);
      setAnnouncement('Shortcut cleared.');
    },
    [onChange]
  );

  // Format value for display
  const displayValue = isRecording
    ? pendingShortcut
    : value;

  // Split shortcut into parts for badge display
  const shortcutParts = displayValue
    ? formatShortcut(displayValue, isMac()).split(isMac() ? '' : '+')
    : [];

  // For Mac, we need to handle the concatenated symbols differently
  const displayParts = isMac() && displayValue
    ? formatMacParts(displayValue)
    : shortcutParts;

  return (
    <div
      ref={containerRef}
      id={id}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={isRecording}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      onClick={handleClick}
      onKeyDown={(e) => {
        // Allow Enter/Space to activate
        if ((e.key === 'Enter' || e.key === ' ') && !isRecording) {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`
        relative inline-flex items-center gap-1.5 px-3 py-2 min-w-[8rem] min-h-[2.5rem]
        bg-background border rounded cursor-pointer transition-all
        ${isRecording
          ? 'border-accent ring-2 ring-accent-30 bg-accent-5'
          : 'border-border hover:border-text-secondary'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      data-testid={testId}
      data-recording={isRecording}
    >
      {/* Shortcut display or placeholder */}
      {displayParts.length > 0 ? (
        <div className="flex items-center gap-1">
          {displayParts.map((part, index) => (
            <KeyBadge key={index} keyPart={part} />
          ))}
        </div>
      ) : (
        <span className="text-text-secondary text-sm">
          {isRecording ? 'Press keys...' : 'Click to record'}
        </span>
      )}

      {/* Clear button */}
      {value && !isRecording && !disabled && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-secondary hover:text-text rounded hover:bg-panel"
          aria-label="Clear shortcut"
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}

      {/* ARIA live region for announcements */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </span>
    </div>
  );
}

/**
 * Format Mac shortcut into separate display parts.
 * Mac shortcuts use concatenated symbols without separators.
 */
function formatMacParts(shortcut: string): string[] {
  const formatted = formatShortcut(shortcut, true);
  const parts: string[] = [];

  // Mac symbols for modifiers
  const macSymbols = ['\u2318', '\u2325', '\u21E7']; // Cmd, Option, Shift

  let remaining = formatted;
  for (const symbol of macSymbols) {
    if (remaining.startsWith(symbol)) {
      parts.push(symbol);
      remaining = remaining.slice(symbol.length);
    }
  }

  // The rest is the key
  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

export default ShortcutRecorder;
