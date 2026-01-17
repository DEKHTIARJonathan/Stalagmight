# Task 46: i18n Infrastructure

## Overview
Set up react-i18next library and create initial translation file structure. Configure language detection and establish patterns for translation key usage.

## Priority
Medium - Phase E (i18n)

## Risk Level
Medium

## Dependencies
- None

## Files to Modify
- `src/i18n/index.ts` - New file, i18n setup
- `src/i18n/locales/en.json` - New file, English translations
- `src/main.tsx` - Initialize i18n
- `package.json` - Add react-i18next dependency

## Specifications

### Library Setup
```typescript
// src/i18n/index.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export default i18n;
```

### Namespace Structure
Organize by feature:
```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "close": "Close"
  },
  "dialogs": {
    "import": { ... },
    "export": { ... }
  },
  "tools": {
    "select": "Select",
    "pan": "Pan"
  },
  "validation": {
    "required": "This field is required"
  }
}
```

### Usage Pattern
```tsx
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation();
  return <button>{t('common.save')}</button>;
}
```

### Missing Key Handling
- Development: Show key name (e.g., `[common.missing]`)
- Production: Show fallback or empty string
- Log missing keys for debugging

### Backend Integration
- Frontend-only i18n
- Rust backend returns error codes
- Frontend maps codes to localized messages

### Language Detection
- Browser language preference
- Stored preference in localStorage
- Fallback to English

## Acceptance Criteria
- [ ] react-i18next installed and configured
- [ ] English translation file created
- [ ] Language detection works
- [ ] Missing keys handled correctly
- [ ] useTranslation hook works in components
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test t() function returns translated string
2. Test useTranslation hook works in component
3. Test browser language detected correctly
4. Test fallback to English when language unknown
5. Test missing key shows key name in dev mode
6. Test interpolation with variables works
7. Test namespace loading works

### WebdriverIO Tests (Full App)
1. Test translations render in real app
2. Test language preference persists in localStorage
3. Test switching language updates all strings
4. Test RTL languages handled (if applicable)
5. Test i18n doesn't break on missing keys

## Edge Cases
- Unknown language code
- Missing translation key
- Interpolation with special characters
- Plural forms
