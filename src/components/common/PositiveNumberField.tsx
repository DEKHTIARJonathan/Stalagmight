import { useEffect, useState } from 'react';

/** Round a value to `precision` decimals for display; `String(value)` when omitted. */
function formatDraft(value: number, precision?: number): string {
  if (precision == null) return String(value);
  const factor = 10 ** precision;
  return String(Math.round(value * factor) / factor);
}

/**
 * Controlled positive-number input with a local draft so the field is fully
 * deletable (no leading-0 trap): an empty/intermediate value is shown but NOT
 * committed, and only a finite, strictly-positive number reaches `onCommit`. This
 * keeps a transient blank from poisoning downstream consumers (e.g. the gas fetch,
 * which rejects a 0/NaN RMV or fill and would otherwise blank the whole overlay).
 *
 * `value`/`onCommit` are in whatever unit the caller chooses (the RMV field passes
 * display-unit values + converts in onCommit). The draft re-syncs from an EXTERNAL
 * value change (reset / preset add / unit toggle) ONLY while not focused, so a
 * unit-toggle re-labels the field but in-progress keystrokes are never clobbered.
 *
 * Extracted from GasPlanPanel (#38) so the Plan-setup sidebar, the Cylinders tab, and
 * the Gas settings panel share one deletable-number control.
 */
export function PositiveNumberField({
  value,
  onCommit,
  step,
  displayPrecision,
  className,
  ariaLabel,
  testId,
  allowZero = false,
}: {
  value: number;
  onCommit: (n: number) => void;
  step?: number;
  displayPrecision?: number;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  /** Accept 0 as a valid committed value (e.g. a cylinder's Free usable gas), not just > 0. */
  allowZero?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatDraft(value, displayPrecision));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(formatDraft(value, displayPrecision));
  }, [value, focused, displayPrecision]);
  return (
    <input
      type="number"
      min={0}
      step={step}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setDraft(formatDraft(value, displayPrecision));
      }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text); // allow empty / intermediate so the field stays deletable
        // An empty/blank draft must NOT commit - `Number('')` is 0, which `allowZero` would
        // otherwise write mid-edit (the strictly-positive path already rejects 0). Keep it a draft.
        if (text.trim() === '') return;
        const n = Number(text);
        if (Number.isFinite(n) && (allowZero ? n >= 0 : n > 0)) onCommit(n);
      }}
      className={className}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  );
}
