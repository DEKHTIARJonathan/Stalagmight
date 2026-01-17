# Task 48: Number/Date Formatting

## Overview
Implement locale-aware number and date formatting using Intl APIs. Display formatting only - storage always uses ISO format.

## Priority
Low-Medium - Phase E (i18n)

## Risk Level
Low-Medium

## Dependencies
- Task 46: i18n infrastructure

## Files to Modify
- `src/utils/formatting.ts` - New file
- `src/hooks/useFormatting.ts` - New hook
- Components that display numbers/dates

## Specifications

### Number Formatting
```typescript
// src/utils/formatting.ts
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDistance(meters: number, locale: string): string {
  // Returns "1,234.56 m" or "1.234,56 m" depending on locale
  return formatNumber(meters, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' m';
}
```

### Date Formatting
```typescript
export function formatDate(
  date: Date | string,
  locale: string,
  format: 'short' | 'medium' | 'long' = 'medium'
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const options: Intl.DateTimeFormatOptions = {
    short: { month: 'numeric', day: 'numeric', year: '2-digit' },
    medium: { month: 'short', day: 'numeric', year: 'numeric' },
    long: { month: 'long', day: 'numeric', year: 'numeric' },
  }[format];
  return new Intl.DateTimeFormat(locale, options).format(d);
}
```

### Hook for Components
```typescript
export function useFormatting() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  return {
    formatNumber: (n: number) => formatNumber(n, locale),
    formatDistance: (m: number) => formatDistance(m, locale),
    formatDate: (d: Date | string) => formatDate(d, locale),
  };
}
```

### Storage vs Display
- Storage: Always ISO 8601 (e.g., "2024-01-15")
- Display: Localized based on user preference
- User can choose preferred date format in settings

### Units
- Hardcoded to metric (meters) in v1
- Unit conversion deferred to v2

### User Preference
- Default: System locale
- Can override in settings
- Settings options:
  - Locale-based (auto)
  - ISO format
  - Custom format selection

### Date Format Options
- ISO: 2024-01-15
- Short: 1/15/24 (US) or 15/1/24 (EU)
- Medium: Jan 15, 2024
- Long: January 15, 2024

## Acceptance Criteria
- [ ] Number formatting respects locale
- [ ] Date formatting respects locale
- [ ] Formatting utility functions work
- [ ] useFormatting hook available
- [ ] User preference override works
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test formatNumber with en-US locale (1,234.56)
2. Test formatNumber with de-DE locale (1.234,56)
3. Test formatDistance adds " m" suffix
4. Test formatDate short format
5. Test formatDate medium format
6. Test formatDate long format
7. Test useFormatting hook returns all formatters
8. Test locale override from settings

### WebdriverIO Tests (Full App)
1. Test numbers formatted correctly throughout app
2. Test dates formatted correctly throughout app
3. Test locale preference persists
4. Test format changes when locale changed
5. Test ISO storage format unchanged by display format

## Edge Cases
- Invalid date strings
- Very large/small numbers
- Unsupported locale
- Scientific notation numbers
