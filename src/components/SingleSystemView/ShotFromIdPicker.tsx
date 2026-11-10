import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, type SelectOption } from '../common/Select';

/** Search the whole project without mounting one option per shot in every cell. */
export function ShotFromIdPicker({ shotNumber, fromId, choices, byId, disabled, testId, onChange }: {
  shotNumber: number | undefined;
  fromId: number | null;
  choices: readonly SelectOption[];
  byId: ReadonlyMap<string, SelectOption>;
  disabled: boolean;
  testId: string;
  onChange: (fromId: number | null) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const options = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const results: SelectOption[] = [];
    if (term) for (const option of choices) {
      if (Number(option.value) === shotNumber) continue;
      const haystack = /^\d+$/.test(term) ? option.value : `${option.value} ${option.label}`.toLocaleLowerCase();
      if (haystack.includes(term)) results.push(option);
      if (results.length === 50) break;
    }
    const selected = fromId === null ? undefined : byId.get(String(fromId));
    if (selected && !results.some(option => option.value === selected.value)) results.push(selected);
    return [{ value: '-1', label: t('dataWorkspace.noOrigin'), alwaysVisible: true }, ...results];
  }, [choices, byId, shotNumber, fromId, query, t]);
  return <Select variant="cell" fitContent dropdownRightMargin={100}
    value={String(fromId ?? -1)} options={options} disabled={disabled}
    searchLabel={t('dataWorkspace.searchShots')} onQueryChange={setQuery}
    noResultsLabel={query.trim() ? t('dataWorkspace.noShots') : t('dataWorkspace.searchShotsHint')}
    aria-label={t('dataWorkspace.fromId')} data-testid={testId}
    onChange={value => onChange(value === '-1' ? null : Number(value))} />;
}
