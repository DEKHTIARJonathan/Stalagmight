# fn-51-g8j.6 Create AppearanceSettings tab and wire into SettingsDialog

## Description

Create a new Appearance settings tab component and integrate it into the existing Settings dialog infrastructure.

## Files to create

- `src/components/Dialogs/settings/AppearanceSettings.tsx` — The Appearance tab

## Files to modify

- `src/components/Dialogs/settings/SettingsSidebar.tsx` — Add 'appearance' to `SettingsCategory` type union AND `CATEGORIES` array (NOTE: the type is defined in this file at lines 6-15, NOT in types.ts)
- `src/components/Dialogs/SettingsDialog.tsx` — Import and render AppearanceSettings, add to `getCategoryDefaults()`, handle category change

## Implementation

### AppearanceSettings.tsx

Follow the existing `SettingsCategoryProps` pattern. The tab should contain:

1. **Theme** section with a radio group for Dark / Light / Auto
   - Dark: "Use dark colors for the interface"
   - Light: "Use light colors with warm tones"
   - Auto: "Follow your operating system's appearance setting"

Use `SettingsSection` and `SettingRow` components for layout consistency.

```typescript
import type { SettingsCategoryProps } from './SettingsSidebar';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import type { ThemeMode } from '../../../types/config';

export function AppearanceSettings({ config, onChange, changedFields }: SettingsCategoryProps) {
  const theme = config.appearance.theme;
  
  const handleThemeChange = (value: ThemeMode) => {
    onChange({ appearance: { ...config.appearance, theme: value } });
  };

  // Radio group for theme selection
  // ...
}
```

### SettingsSidebar.tsx

1. Add `'appearance'` to the `SettingsCategory` union type (lines 6-15):
```typescript
export type SettingsCategory =
  | 'appearance'  // NEW — add near top
  | 'general'
  | 'units'
  // ... rest unchanged
```

2. Add to `CATEGORIES` array. Place after 'general' (second position — appearance is a fundamental user preference):
```typescript
const CATEGORIES: CategoryConfig[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },  // NEW
  { id: 'units', label: 'Units' },
  // ... rest unchanged
];
```

### SettingsDialog.tsx

1. Import `AppearanceSettings`
2. Add case in the category switch/render logic
3. Add `'appearance'` case in `getCategoryDefaults()`:
   ```typescript
   case 'appearance':
     return { appearance: { ...defaultConfig.appearance } };
   ```

## Acceptance

- [ ] `SettingsCategory` type in SettingsSidebar.tsx includes `'appearance'`
- [ ] `CATEGORIES` array includes `{ id: 'appearance', label: 'Appearance' }`
- [ ] Appearance tab appears in Settings sidebar (second position)
- [ ] Tab shows theme selector with Dark, Light, Auto options
- [ ] Each option has a description label
- [ ] Selecting a theme updates config via `onChange()`
- [ ] Changed field highlighting works (shows modified indicator)
- [ ] "Reset to defaults" works for Appearance category
- [ ] `pnpm tsc --noEmit` passes
- [ ] Tab follows existing SettingsCategoryProps pattern exactly
- [ ] ARIA: radio group has proper role and labeling
