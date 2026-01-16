# PRD: Add Comment Field to Manual Import Dialog

## Overview

**Task ID:** 3
**Priority:** High
**Phase:** 1 - Import Dialog Enhancements
**Estimated Complexity:** Low

### Summary

Add a text comment field per shot row in the manual Import Dialog, allowing users to capture notes and observations for each survey shot.

## Background

Survey comments capture important contextual information:
- Station descriptions
- Survey conditions
- Observations about passage features
- Warnings or notes for future reference

This data is valuable for documentation and can be searched across the project.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Add comment text input column to shots table | Must |
| F2 | Support multi-line text input | Must |
| F3 | No character limit | Must |
| F4 | Truncate display with ellipsis, show full on hover | Must |
| F5 | Include comments in global search | Must |
| F6 | Empty/whitespace maps to `null` | Must |
| F7 | Field visibility controlled via Settings | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Long comments should not disrupt table layout | Must |
| NF2 | Performance stable with many long comments | Should |

## User Decisions

- No character limit
- Multi-line text allowed
- In compact table view: Truncate with ellipsis (full on hover)
- Comments included in global search

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/ImportDialog.tsx` | Add comment column with popover editor |
| `src/types/config.ts` | Add `showCommentField` setting |
| `src/utils/search.ts` | Include comments in search indexing |

### Implementation Details

1. **Compact input with expand:**
   ```typescript
   const CommentCell: React.FC<{ value: string; onChange: (v: string) => void }> = ({
     value,
     onChange
   }) => {
     const [expanded, setExpanded] = useState(false);

     return (
       <div className="relative">
         <input
           className="w-full truncate"
           value={value}
           onChange={(e) => onChange(e.target.value)}
           title={value} // Full text on hover
         />
         {value.length > 20 && (
           <button onClick={() => setExpanded(true)}>...</button>
         )}
         {expanded && (
           <Popover onClose={() => setExpanded(false)}>
             <textarea
               value={value}
               onChange={(e) => onChange(e.target.value)}
               rows={4}
             />
           </Popover>
         )}
       </div>
     );
   };
   ```

2. **Value normalization:**
   ```typescript
   const normalizeComment = (value: string): string | null => {
     const trimmed = value.trim();
     return trimmed.length > 0 ? trimmed : null;
   };
   ```

3. **Search integration:**
   ```typescript
   // In search indexing
   const indexShot = (shot: Shot) => ({
     ...existingIndex,
     comment: shot.comment || '',
   });
   ```

## UI/UX Specification

### Layout

```
| ... | D | Comment          | Actions |
|-----|---|------------------|---------|
| ... |0.8| "Large room w... | [x]     |
```

### Input Behavior

- **Default view**: Single-line input, truncated with ellipsis
- **Hover**: Show full comment in tooltip
- **Click expand button**: Open popover with textarea
- **Width**: Flexible, minimum 100px, expands to available space

### Popover Editor

```
┌─────────────────────────────┐
│ Comment                   X │
├─────────────────────────────┤
│ Large room with flowstone   │
│ formations on the left      │
│ wall. Water level marked.   │
│                             │
└─────────────────────────────┘
```

### Settings UI

Add to Import Settings tab:
```
[ ] Show comment field in Import Dialog
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Very long comment (1000+ chars) | Allow, truncate in table, full in popover |
| Whitespace-only comment | Normalize to `null` |
| Line breaks in comment | Preserve, display as single line in table |
| Special characters | Allow all characters |
| Paste multi-line text | Accept and preserve |

## Testing

### Manual Tests

1. Enter comments in Import Dialog, import section
2. Verify truncation with ellipsis for long comments
3. Hover to see full comment tooltip
4. Use expand popover for multi-line editing
5. Search for comment text in global search
6. Verify whitespace-only becomes null

### Automated Tests

```typescript
describe('ImportDialog comment field', () => {
  it('truncates long comments with ellipsis', () => {});
  it('shows full comment on hover', () => {});
  it('opens popover for editing', () => {});
  it('normalizes whitespace to null', () => {});
  it('preserves line breaks', () => {});
});
```

## Dependencies

- None (self-contained)

## Acceptance Criteria

- [ ] Comment column appears in Import Dialog when enabled
- [ ] Long comments truncate with ellipsis
- [ ] Full comment visible on hover
- [ ] Popover editor allows multi-line editing
- [ ] No character limit enforced
- [ ] Empty/whitespace becomes `null`
- [ ] Comments searchable in global search
- [ ] Settings toggle controls visibility
