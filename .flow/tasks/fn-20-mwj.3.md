# fn-20-mwj.3 Replace section dropdown with themed Select component

## Description
Replace the native HTML `<select>` element in DataTable header with the themed `Select` component for consistent styling.

**Size:** S
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`

## Approach

1. Import Select component from `src/components/common/Select.tsx`

2. Convert sections array to SelectOption format:
   - `value`: String of section.id
   - `label`: section.name ?? `Section ${section.id}`

3. Replace native select (lines 153-164) with:
   ```tsx
   <Select
     value={String(selectedSectionId ?? '')}
     onChange={(value) => setSelectedSectionId(Number(value))}
     options={sectionOptions}
     data-testid="data-table-section-select"
   />
   ```

4. Keep "Section:" label prefix before the Select

## Key context

Select component signature at `src/components/common/Select.tsx:18-37`:
- `value: string` - currently selected value
- `onChange: (value: string) => void`
- `options: SelectOption[] | SelectOptionGroup[]`
- SelectOption: `{ value: string; label: string; disabled?: boolean }`
## Acceptance
- [ ] Native `<select>` replaced with themed `<Select>` component
- [ ] "Section:" label text preserved
- [ ] Section selection still works (changes displayed section)
- [ ] Dropdown uses dark theme styling (matches app theme)
- [ ] Keyboard navigation works in dropdown (Arrow keys, Enter, Escape)
- [ ] data-testid="data-table-section-select" preserved
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Replaced native HTML `<select>` in DataTable header with themed `<Select>` component for consistent dark theme styling.

Changes:
- Imported Select component and SelectOption type
- Added memoized sectionOptions array conversion (id → value string, name → label)
- Replaced native select (lines 153-164) with themed Select component
- Updated e2e tests to use custom Select interaction pattern (click to open, click option)

The Select component provides:
- Dark theme styling matching rest of app
- Keyboard navigation (Arrow keys, Enter, Escape)
- Accessible ARIA attributes
## Evidence
- Commits:
- Tests: command, result
- PRs: