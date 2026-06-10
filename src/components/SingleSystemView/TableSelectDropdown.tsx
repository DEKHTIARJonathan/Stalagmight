import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { Select, type SelectOption } from '../common/Select';

const SECTIONS_VALUE = 'sections';
const RAW_VALUE = 'raw';

/**
 * Fullscreen-toolbar view picker: the Sections-backed data table, or the raw
 * sqlite tables of the project database. WHICH raw table is browsed is chosen
 * in the data-table sub-header next to the table-name pill; selecting "Raw
 * data" here enters raw mode with an empty selection that the sub-header
 * resolves to the last-browsed (or first) table.
 */
export default function TableSelectDropdown() {
  const { t } = useTranslation();
  const rawTableSelection = useUIStore((s) => s.rawTableSelection);
  const setRawTableSelection = useUIStore((s) => s.setRawTableSelection);

  const handleChange = useCallback(
    (value: string) => {
      setRawTableSelection(value === RAW_VALUE ? '' : null);
    },
    [setRawTableSelection]
  );

  const options: SelectOption[] = [
    { value: SECTIONS_VALUE, label: t('dataTable.tableSelect.sections') },
    { value: RAW_VALUE, label: t('dataTable.tableSelect.rawData') },
  ];

  return (
    <Select
      value={rawTableSelection === null ? SECTIONS_VALUE : RAW_VALUE}
      onChange={handleChange}
      options={options}
      className="w-40 text-sm"
      aria-label={t('dataTable.title')}
      data-testid="table-select-dropdown"
    />
  );
}
