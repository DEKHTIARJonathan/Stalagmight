# Task 47: Extract UI Strings

## Overview
Replace all hardcoded strings in UI components with i18n translation keys. Single-pass extraction organized by feature namespace.

## Priority
High (tedious) - Phase E (i18n)

## Risk Level
High

## Dependencies
- Task 46: i18n infrastructure

## Files to Modify
- All components in `src/components/`
- `src/i18n/locales/en.json` - Add all extracted strings
- Estimated: 50+ files

## Specifications

### Extraction Scope
All user-visible strings:
- Button labels
- Dialog titles and content
- Form labels and placeholders
- Error messages
- Tooltips
- Status messages
- Menu items

### NOT Extracted
- Log messages (Rust backend)
- Internal comments
- Test data
- Technical identifiers

### Namespace Organization
```json
{
  "common": {
    "actions": {
      "save": "Save",
      "cancel": "Cancel",
      "close": "Close",
      "delete": "Delete",
      "edit": "Edit",
      "add": "Add"
    },
    "labels": {
      "name": "Name",
      "description": "Description"
    }
  },
  "dialogs": {
    "import": {
      "title": "Import DMP File",
      "selectFile": "Select file...",
      "importing": "Importing..."
    },
    "export": {
      "title": "Export Project",
      "format": "Format"
    },
    "settings": {
      "title": "Settings",
      "tabs": {
        "display": "Display",
        "validation": "Validation"
      }
    }
  },
  "tools": {
    "select": "Select (S)",
    "pan": "Pan (P)",
    "zoom": "Zoom (Z)"
  },
  "validation": {
    "errors": {
      "required": "This field is required",
      "invalidNumber": "Must be a valid number"
    }
  },
  "status": {
    "saved": "Project saved",
    "saving": "Saving...",
    "unsaved": "Unsaved changes"
  }
}
```

### Pluralization
```typescript
t('shots', { count: 5 }) // "5 shots"
```
```json
{
  "shots_one": "{{count}} shot",
  "shots_other": "{{count}} shots"
}
```

### Interpolation
```typescript
t('fileSize', { size: '2.5 MB' }) // "File size: 2.5 MB"
```
```json
{
  "fileSize": "File size: {{size}}"
}
```

### Extraction Process
1. Single pass through all components
2. Create translation key for each string
3. Replace string with t() call
4. Add to en.json

## Acceptance Criteria
- [ ] All UI strings extracted
- [ ] Namespaces organized by feature
- [ ] Pluralization where needed
- [ ] Interpolation where needed
- [ ] No hardcoded visible strings remain
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test common.save renders "Save"
2. Test common.cancel renders "Cancel"
3. Test dialogs.import.title renders correctly
4. Test tools.select renders "Select (S)"
5. Test pluralization: 1 shot → "1 shot"
6. Test pluralization: 5 shots → "5 shots"
7. Test interpolation: fileSize with variable
8. Test no hardcoded strings in main dialogs

### WebdriverIO Tests (Full App)
1. Test all button labels use translations
2. Test all dialog titles use translations
3. Test all error messages use translations
4. Test all tooltip text uses translations
5. Test translation coverage (spot check 10 components)

## Edge Cases
- Strings with HTML entities
- Strings with variables
- Context-dependent translations
- Very long strings
