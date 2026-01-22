# fn-16-axa.1 Create Toggle component for iOS-style switches

## Description
Create a reusable Toggle/Switch component styled like iOS toggles for boolean settings. The component must be fully accessible with proper ARIA attributes and keyboard support.

**Size:** S
**Files:**
- `src/components/common/Toggle.tsx` - New component

## Approach

1. Follow Button.tsx pattern at `src/components/common/Button.tsx` for component structure
2. **Use non-button focusable element** (`div tabIndex={0}`) with `role="switch"` and `aria-checked` attribute
   - This avoids Enter key triggering toggle (Enter triggers click on buttons)
3. Style with Tailwind using existing theme colors:
   - Off state: `bg-gray-600` (dark background)
   - On state: `bg-accent` (`#4ecdc4` from tailwind.config.js)
   - Thumb: white circle with smooth transition
4. **Space key toggles** (keydown handler for Space)
5. **Enter key does NOT toggle** (no click handler, Space-only activation)
6. Include visible focus ring using `focus:ring-2 focus:ring-accent` pattern
7. Props interface: `{ checked: boolean, onChange: (checked: boolean) => void, disabled?: boolean, label?: string, 'aria-label'?: string, 'aria-labelledby'?: string, 'data-testid'?: string }`

## Key Context

- No existing toggle component in codebase - checkboxes use native HTML with custom CSS (`src/index.css:80-145`)
- Existing Button component has good patterns for variants, sizes, and disabled states
- Use `transition-all duration-200` for smooth animations (existing pattern)
- Tailwind colors from `tailwind.config.js:16-41`: accent=#4ecdc4, background=#1a1a2e
- **Critical**: Must NOT use `<button>` element to prevent Enter key from toggling

## Acceptance
- [ ] Component accepts checked, onChange, disabled, label props
- [ ] Uses `role="switch"` with `aria-checked` attribute
- [ ] **Space key toggles the switch**
- [ ] **Enter key does NOT toggle** (unlike standard buttons)
- [ ] Visible focus ring on keyboard focus (`focus:ring-2 focus:ring-accent`)
- [ ] Smooth 200ms transition between on/off states
- [ ] Disabled state visually distinct and non-interactive
- [ ] Works with external label via aria-labelledby
- [ ] Implemented as non-button focusable element (div with tabIndex=0)
- [ ] pnpm tsc --noEmit passes
