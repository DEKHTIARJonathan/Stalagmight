import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Commit an existing global Shot ID or NONE on Enter or blur. */
export function ShotFromIdInput({ fromId, disabled, testId, parseValue, onChange, onInvalid }: {
  fromId: number | null;
  disabled: boolean;
  testId: string;
  parseValue: (value: string) => number | null;
  onChange: (fromId: number | null) => void;
  onInvalid: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const savedValue = fromId === null ? 'NONE' : String(fromId);
  const [value, setValue] = useState(savedValue);
  const [invalid, setInvalid] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => { setValue(savedValue); setInvalid(false); }, [savedValue]);
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; return; }
    if (disabled || value === savedValue) return;
    try {
      const next = parseValue(value);
      setValue(next === null ? 'NONE' : String(next));
      setInvalid(false);
      onChange(next);
    } catch (error) {
      setInvalid(true);
      onInvalid(error);
    }
  };
  return <input type="text" value={value} disabled={disabled}
    aria-label={t('dataWorkspace.fromId')} aria-invalid={invalid}
    title={invalid ? t('dataWorkspace.invalidOrigin') : t('dataWorkspace.originInputHint')}
    data-testid={testId} autoComplete="off" spellCheck={false}
    className={`w-full min-w-0 rounded border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 ${invalid ? 'border-red-500' : 'border-transparent'}`}
    onMouseDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
    onCopy={event => event.stopPropagation()}
    onCut={event => event.stopPropagation()}
    onPaste={event => event.stopPropagation()}
    onFocus={event => event.currentTarget.select()}
    onChange={event => { setValue(event.target.value); setInvalid(false); }}
    onBlur={commit}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') {
        event.preventDefault(); cancelled.current = true;
        setValue(savedValue); setInvalid(false); event.currentTarget.blur();
      }
    }} />;
}
