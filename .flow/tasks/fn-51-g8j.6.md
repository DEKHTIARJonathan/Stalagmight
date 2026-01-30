# fn-51-g8j.6 Create AppearanceSettings tab and wire into SettingsDialog

## Description

Create a new Appearance settings tab component and integrate it into the existing Settings dialog infrastructure.

## Files to create

- `src/components/Dialogs/settings/AppearanceSettings.tsx` — The Appearance tab

## Files to modify

- `src/components/Dialogs/settings/SettingsSidebar.tsx` — Add 'appearance' to category list
- `src/components/Dialogs/settings/types.ts` — Add 'appearance' to `SettingsCategory` union type
- `src/components/Dialogs/SettingsDialog.tsx` — Import and render AppearanceSettings, add to `getCategoryDefaults()`, handle category change

## Implementation

### AppearanceSettings.tsx

Follow the existing `SettingsCategoryProps` pattern. The tab should contain:

1. **Theme** section with a radio group or select for Dark / Light / Auto
   - Dark: "Use dark colors for the interface"
   - Light: "Use light colors with warm tones"
   - Auto: "Follow your operating system's appearance setting"

Use `SettingsSection` and `SettingRow` components for layout consistency.

```typescript
import { SettingsCategoryProps } from './types';
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

Add `'appearance'` to the `CATEGORIES` array. Place it first or second in the list (appearance is a fundamental setting).

### types.ts

Add `'appearance'` to the `SettingsCategory` union type.

### SettingsDialog.tsx

1. Import `AppearanceSettings`
2. Add case in the category switch/render logic
3. Add `'appearance'` case in `getCategoryDefaults()`:
   ```typescript
   case 'appearance':
     return { appearance: { ...defaultConfig.appearance } };
   ```

## Acceptance

- [ ] Appearance tab appears in Settings sidebar
- [ ] Tab shows theme selector with Dark, Light, Auto options
- [ ] Each option has a description label
- [ ] Selecting a theme updates config via `onChange()`
- [ ] Changed field highlighting works (shows modified indicator)
- [ ] "Reset to defaults" works for Appearance category
- [ ] `pnpm tsc --noEmit` passes
- [ ] Tab follows existing SettingsCategoryProps pattern exactly
- [ ] ARIA: radio group has proper role and labeling
