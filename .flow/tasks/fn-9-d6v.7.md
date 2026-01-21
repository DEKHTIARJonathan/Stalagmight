# fn-9-d6v.7 Add keyboard accessibility to SectionsPanel

## Description
Add keyboard accessibility to SectionsPanel with roving tabindex and container-level blur.

## Files to Modify

### `src/components/SingleSystemView/SectionsPanel.tsx`

**Add focus state:**
```typescript
const [focusedIndex, setFocusedIndex] = useState<number>(-1);
const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
```

**Container with blur handler:**
```tsx
<div
  role="listbox"
  aria-label="Cave survey sections"
  onBlur={(e) => {
    // CRITICAL: Only clear when focus leaves the listbox ENTIRELY
    // Using relatedTarget to check if new focus target is within container
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setFocusedIndex(-1);
      setHoveredSectionId(null);
    }
  }}
>
```

**Roving tabindex on options (NO per-row onBlur):**
```tsx
{sections.map((section, index) => (
  <div
    key={section.id}
    ref={el => optionRefs.current[index] = el}
    role="option"
    aria-selected={isSelected}
    tabIndex={focusedIndex === index ? 0 : (focusedIndex === -1 && index === 0 ? 0 : -1)}
    data-testid={`section-row-${section.id}`}
    onFocus={() => {
      setFocusedIndex(index);
      setHoveredSectionId(section.id);  // Map highlight on focus
    }}
    // NO onBlur here - handled at container level
    onKeyDown={(e) => handleKeyDown(e, index)}
    // ... existing props
  >
```

**Keyboard handler - ALL relevant keys use preventDefault + stopPropagation:**
```typescript
const handleKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();      // Prevent page scroll
      e.stopPropagation();     // Prevent global shortcuts
      if (currentIndex < sections.length - 1) {
        const nextIndex = currentIndex + 1;
        setFocusedIndex(nextIndex);
        optionRefs.current[nextIndex]?.focus();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        setFocusedIndex(prevIndex);
        optionRefs.current[prevIndex]?.focus();
      }
      break;
    case 'Home':
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(0);
      optionRefs.current[0]?.focus();
      break;
    case 'End':
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(sections.length - 1);
      optionRefs.current[sections.length - 1]?.focus();
      break;
    case 'Enter':
      e.preventDefault();
      e.stopPropagation();
      handleSectionClick(sections[currentIndex]);
      break;
    case ' ':  // Space
      e.preventDefault();
      e.stopPropagation();
      handleSectionClick(sections[currentIndex]);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      clearSelection();  // From uiStore
      break;
  }
};
```

## Key Implementation Details

**Container-level blur (NOT per-row):**
- `onBlur` on container checks `e.relatedTarget` to see if focus moved outside
- `e.currentTarget.contains(e.relatedTarget)` returns false only when leaving entirely
- This avoids the timing issue where moving between rows briefly clears hover

**Roving tabindex pattern:**
- Only the focused option has `tabIndex={0}`, all others have `tabIndex={-1}`
- First option gets `tabIndex={0}` when nothing is focused (`focusedIndex === -1 && index === 0`)
- DOM focus moves between options

**Preventing default behavior:**
- `e.preventDefault()` on ALL navigation keys prevents scroll and default actions
- `e.stopPropagation()` prevents global keyboard shortcuts
## Files to Modify

### `src/components/SingleSystemView/SectionsPanel.tsx`

**Add focus state:**
```typescript
const [focusedIndex, setFocusedIndex] = useState<number>(-1);
const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
```

**Add ARIA attributes to container:**
```tsx
<div
  role="listbox"
  aria-label="Cave survey sections"
  className="..."
>
```

**Roving tabindex on options:**
```tsx
{sections.map((section, index) => (
  <div
    key={section.id}
    ref={el => optionRefs.current[index] = el}
    role="option"
    aria-selected={isSelected}
    tabIndex={focusedIndex === index ? 0 : (focusedIndex === -1 && index === 0 ? 0 : -1)}
    data-testid={`section-row-${section.id}`}
    onFocus={() => {
      setFocusedIndex(index);
      setHoveredSectionId(section.id);  // Map highlight on focus
    }}
    onBlur={() => {
      // Only clear if not moving to another option
      setTimeout(() => {
        if (!optionRefs.current.some(ref => ref === document.activeElement)) {
          setFocusedIndex(-1);
          setHoveredSectionId(null);
        }
      }, 0);
    }}
    onKeyDown={(e) => handleKeyDown(e, index)}
    // ... existing props
  >
```

**Keyboard handler - ALL relevant keys use preventDefault + stopPropagation:**
```typescript
const handleKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();      // Prevent page scroll
      e.stopPropagation();     // Prevent global shortcuts
      if (currentIndex < sections.length - 1) {
        const nextIndex = currentIndex + 1;
        setFocusedIndex(nextIndex);
        optionRefs.current[nextIndex]?.focus();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        setFocusedIndex(prevIndex);
        optionRefs.current[prevIndex]?.focus();
      }
      break;
    case 'Home':
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(0);
      optionRefs.current[0]?.focus();
      break;
    case 'End':
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(sections.length - 1);
      optionRefs.current[sections.length - 1]?.focus();
      break;
    case 'Enter':
      e.preventDefault();      // Prevent form submission
      e.stopPropagation();
      handleSectionClick(sections[currentIndex]);
      break;
    case ' ':  // Space
      e.preventDefault();      // Prevent page scroll
      e.stopPropagation();
      handleSectionClick(sections[currentIndex]);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      clearSelection();  // From uiStore
      break;
  }
};
```

## Key Implementation Details

**Roving tabindex pattern:**
- Only the focused option has `tabIndex={0}`, all others have `tabIndex={-1}`
- First option gets `tabIndex={0}` when nothing is focused AND it's index 0
- DOM focus moves between options (not `aria-activedescendant`)

**Preventing default behavior:**
- `e.preventDefault()` on ALL navigation keys prevents:
  - Arrow keys from scrolling the page
  - Space from scrolling the page
  - Enter from triggering form submission
- `e.stopPropagation()` prevents arrow keys from triggering global keyboard shortcuts

**Focus on blur handling:**
- `setTimeout` allows focus to move to next element before checking
- Only clears hover if focus left the panel entirely
## Files to Modify

### `src/components/SingleSystemView/SectionsPanel.tsx`

**Add focus state:**
```typescript
const [focusedIndex, setFocusedIndex] = useState<number>(-1);
const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
```

**Add ARIA attributes to container:**
```tsx
<div
  role="listbox"
  aria-label="Cave survey sections"
  className="..."
>
```

**Roving tabindex on options:**
```tsx
{sections.map((section, index) => (
  <div
    key={section.id}
    ref={el => optionRefs.current[index] = el}
    role="option"
    aria-selected={isSelected}
    tabIndex={focusedIndex === index ? 0 : -1}  // ROVING TABINDEX
    data-testid={`section-row-${section.id}`}
    onFocus={() => {
      setFocusedIndex(index);
      setHoveredSectionId(section.id);  // Map highlight on focus
    }}
    onBlur={() => {
      // Only clear if not moving to another option
      setTimeout(() => {
        if (!optionRefs.current.some(ref => ref === document.activeElement)) {
          setFocusedIndex(-1);
          setHoveredSectionId(null);
        }
      }, 0);
    }}
    onKeyDown={(e) => handleKeyDown(e, index)}
    // ... existing props
  >
```

**Keyboard handler with stopPropagation:**
```typescript
const handleKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();  // CRITICAL: Prevent global shortcuts
      if (currentIndex < sections.length - 1) {
        const nextIndex = currentIndex + 1;
        setFocusedIndex(nextIndex);
        optionRefs.current[nextIndex]?.focus();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        setFocusedIndex(prevIndex);
        optionRefs.current[prevIndex]?.focus();
      }
      break;
    case 'Home':
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(0);
      optionRefs.current[0]?.focus();
      break;
    case 'End':
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(sections.length - 1);
      optionRefs.current[sections.length - 1]?.focus();
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      e.stopPropagation();
      handleSectionClick(sections[currentIndex]);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      clearSelection();  // From uiStore
      break;
  }
};
```

## Key Implementation Details

**Roving tabindex pattern:**
- Only the focused option has `tabIndex={0}`, all others have `tabIndex={-1}`
- DOM focus moves between options (not `aria-activedescendant`)
- First option gets `tabIndex={0}` when nothing is focused (`focusedIndex === -1 && index === 0`)

**Preventing global shortcuts:**
- `e.stopPropagation()` on all key handlers prevents arrow keys from triggering global keyboard shortcuts (like map panning)
- The handler is scoped to the panel, not attached globally

**Focus on blur handling:**
- `setTimeout` allows focus to move to next element before checking
- Only clears hover if focus left the panel entirely
## Files to Modify

### `src/components/SingleSystemView/SectionsPanel.tsx`

**Add ARIA attributes to container:**
```tsx
<div
  role="listbox"
  aria-label="Cave survey sections"
  tabIndex={0}
  onKeyDown={handleKeyDown}
  className="..."
>
  {sections.map((section, index) => (
    <div
      key={section.id}
      role="option"
      aria-selected={isSelected}
      tabIndex={isSelected || (index === 0 && !selection) ? 0 : -1}
      data-testid={`section-row-${section.id}`}
      onFocus={() => handleSectionMouseEnter(section.id)}
      onBlur={() => handleSectionMouseLeave()}
      // ... existing props
    >
```

**Add keyboard handler:**
```typescript
const handleKeyDown = (e: React.KeyboardEvent) => {
  const currentIndex = sections.findIndex(s => 
    (selection?.type === 'section' && selection.sectionId === s.id) ||
    hoveredSectionId === s.id
  );

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (currentIndex < sections.length - 1) {
        const nextSection = sections[currentIndex + 1];
        setHoveredSectionId(nextSection.id);
        // Focus the row element
        document.querySelector(`[data-testid="section-row-${nextSection.id}"]`)?.focus();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (currentIndex > 0) {
        const prevSection = sections[currentIndex - 1];
        setHoveredSectionId(prevSection.id);
        document.querySelector(`[data-testid="section-row-${prevSection.id}"]`)?.focus();
      }
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      const focusedSection = sections.find(s => hoveredSectionId === s.id);
      if (focusedSection) {
        handleSectionClick(focusedSection);
      }
      break;
    case 'Escape':
      e.preventDefault();
      clearSelection(); // Uses existing uiStore.clearSelection
      break;
  }
};
```

**Focus triggers hover highlight (per interview):**
`onFocus` calls the same `setHoveredSectionId` as mouse hover, so keyboard focus shows map highlight.

## Accessibility Pattern
- Listbox pattern: container has `role="listbox"`, items have `role="option"`
- DOM focus movement: focus actually moves between options (not aria-activedescendant)
- Arrow keys navigate, Enter/Space select, Escape clears
- Focus on row triggers map highlight (same as mouse hover)
## Acceptance
- [ ] Container has `role="listbox"` and `aria-label`
- [ ] Container has `onBlur` that uses `e.relatedTarget` to detect focus leaving entirely
- [ ] Section rows have `role="option"` and `aria-selected`
- [ ] Roving tabindex: focused row has `tabIndex={0}`, others have `tabIndex={-1}`
- [ ] First row has `tabIndex={0}` when nothing is focused
- [ ] NO per-row `onBlur` handlers (container handles it)
- [ ] `focusedIndex` state tracks which option has focus
- [ ] `optionRefs` array enables programmatic focus movement
- [ ] Arrow down uses `e.preventDefault()` AND `e.stopPropagation()`
- [ ] Arrow up uses `e.preventDefault()` AND `e.stopPropagation()`
- [ ] Home/End use `e.preventDefault()` AND `e.stopPropagation()`
- [ ] Enter uses `e.preventDefault()` AND `e.stopPropagation()`
- [ ] Space uses `e.preventDefault()` AND `e.stopPropagation()`
- [ ] Escape uses `e.preventDefault()` AND `e.stopPropagation()`
- [ ] Enter/Space select the focused section
- [ ] Escape calls clearSelection() from uiStore
- [ ] `onFocus` sets hoveredSectionId for map highlight
- [ ] Moving between rows does NOT briefly clear hover
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added keyboard accessibility to SectionsPanel with roving tabindex pattern, container-level blur handling, and proper ARIA attributes for listbox/option semantics.
## Evidence
- Commits: f436d59, c261cb0, f2e3a60
- Tests: pnpm tsc --noEmit
- PRs: