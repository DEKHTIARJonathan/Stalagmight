import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { Select, type SelectOption, type SelectOptionGroup } from '../common/Select';
import { invokeIpc } from '../../utils/ipc';

/** The normal Sections-backed data table. Raw tables use `raw:<name>` — the
 *  prefix keeps the sqlite table literally named "sections" unambiguous. */
const SECTIONS_VALUE = 'view:sections';
const RAW_PREFIX = 'raw:';

/**
 * Fullscreen-toolbar table picker: the Sections view (the editable data table)
 * or any raw sqlite table of the project database, browsed read-only.
 */
export default function TableSelectDropdown() {
  const { t } = useTranslation();
  const rawTableSelection = useUIStore((s) => s.rawTableSelection);
  const setRawTableSelection = useUIStore((s) => s.setRawTableSelection);
  // null = still loading; 'unavailable' = no database yet (unsaved project) or
  // the listing failed — shown as one disabled explanatory entry.
  const [rawTables, setRawTables] = useState<string[] | 'unavailable' | null>(null);

  useEffect(() => {
    let cancelled = false;
    invokeIpc<string[]>('get_raw_table_names', undefined, {
      purpose: 'list raw sqlite tables for the fullscreen table picker',
    })
      .then((names) => {
        // Defensive: anything but a list (e.g. a mocked null) reads as "no
        // database to browse", same as the unsaved-project error.
        if (!cancelled) setRawTables(Array.isArray(names) ? names : 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setRawTables('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      if (value === SECTIONS_VALUE) setRawTableSelection(null);
      else if (value.startsWith(RAW_PREFIX)) setRawTableSelection(value.slice(RAW_PREFIX.length));
    },
    [setRawTableSelection]
  );

  const rawOptions: SelectOption[] = Array.isArray(rawTables)
    ? rawTables.map((name) => ({ value: `${RAW_PREFIX}${name}`, label: name }))
    : [
        {
          value: RAW_PREFIX,
          label: rawTables === 'unavailable' ? t('dataTable.rawData.unavailable') : t('dataTable.rawData.loading'),
          disabled: true,
        },
      ];
  const groups: SelectOptionGroup[] = [
    {
      label: t('dataTable.tableSelect.sections'),
      options: [{ value: SECTIONS_VALUE, label: t('dataTable.tableSelect.sections') }],
    },
    { label: t('dataTable.tableSelect.rawData'), options: rawOptions },
  ];

  return (
    <Select
      value={rawTableSelection === null ? SECTIONS_VALUE : `${RAW_PREFIX}${rawTableSelection}`}
      onChange={handleChange}
      options={groups}
      className="w-52 text-sm"
      aria-label={t('dataTable.title')}
      data-testid="table-select-dropdown"
    />
  );
}
