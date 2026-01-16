# PRD: Add Export Options Preview

## Overview

**Task ID:** 17
**Priority:** High
**Phase:** 5 - Polish
**Estimated Complexity:** Medium

### Summary

Add a 400px preview thumbnail to the Export Dialog showing actual project data, with progressive rendering (fast low-res, then high-res) and debounced auto-update.

## Background

A preview before export helps users verify their settings before generating the final output. This prevents wasted time from incorrect resolution, cropping, or display settings.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Show 400px preview thumbnail | Must |
| F2 | Preview shows actual project data | Must |
| F3 | Progressive rendering (low-res first, then high-res) | Must |
| F4 | Preview for image exports only (SVG/PNG/PDF) | Must |
| F5 | Debounced auto-update (500ms default) | Must |
| F6 | Settings for update mode (live/manual/debounced) | Should |
| F7 | Preview updates when options change | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Low-res preview should appear within 100ms | Should |
| NF2 | Preview should not block UI interactions | Must |

## User Decisions

- Preview size: 400px medium size
- Preview fidelity: Progressive (low-res fast, then high-res)
- Preview formats: Image exports only (SVG/PNG/PDF) - no preview for CSV/JSON
- Preview data: Actual project data (not generic sample)
- Debounced by default; all modes configurable in Settings

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/ExportDialog.tsx` | Add preview panel |
| `src/types/config.ts` | Add preview update mode setting |

### Implementation Details

1. **Preview state:**
   ```typescript
   type PreviewMode = 'live' | 'manual' | 'debounced';

   interface PreviewState {
     lowRes: string | null;
     highRes: string | null;
     loading: boolean;
     error: string | null;
   }

   const [preview, setPreview] = useState<PreviewState>({
     lowRes: null,
     highRes: null,
     loading: false,
     error: null,
   });
   ```

2. **Preview generation:**
   ```typescript
   const generatePreview = async (options: ImageExportOptions) => {
     setPreview(prev => ({ ...prev, loading: true, error: null }));

     try {
       // Generate low-res quickly
       const lowResCanvas = await captureMapCanvas({
         width: 200,
         height: 200,
         ...options,
       });
       setPreview(prev => ({
         ...prev,
         lowRes: lowResCanvas.toDataURL('image/png'),
       }));

       // Generate high-res
       const highResCanvas = await captureMapCanvas({
         width: 400,
         height: 400,
         ...options,
       });
       setPreview(prev => ({
         ...prev,
         highRes: highResCanvas.toDataURL('image/png'),
         loading: false,
       }));
     } catch (e) {
       setPreview(prev => ({
         ...prev,
         loading: false,
         error: 'Failed to generate preview',
       }));
     }
   };
   ```

3. **Debounced update:**
   ```typescript
   const debouncedGenerate = useMemo(
     () => debounce(generatePreview, config.export.previewDebounceMs),
     [config.export.previewDebounceMs]
   );

   useEffect(() => {
     if (config.export.previewMode === 'debounced') {
       debouncedGenerate(imageOptions);
     } else if (config.export.previewMode === 'live') {
       generatePreview(imageOptions);
     }
     // Manual mode: only update on button click

     return () => debouncedGenerate.cancel();
   }, [imageOptions, config.export.previewMode]);
   ```

4. **Preview component:**
   ```typescript
   const ExportPreview: React.FC<{
     preview: PreviewState;
     onRefresh: () => void;
     showRefreshButton: boolean;
   }> = ({ preview, onRefresh, showRefreshButton }) => (
     <div className="w-[400px] bg-muted rounded border">
       <div className="p-2 border-b flex justify-between items-center">
         <span className="text-sm font-medium">Preview</span>
         {showRefreshButton && (
           <Button variant="ghost" size="sm" onClick={onRefresh}>
             ↻ Refresh
           </Button>
         )}
       </div>

       <div className="aspect-square relative">
         {preview.loading && !preview.lowRes && (
           <div className="absolute inset-0 flex items-center justify-center">
             <Spinner />
           </div>
         )}

         {preview.error && (
           <div className="absolute inset-0 flex items-center justify-center text-destructive">
             {preview.error}
           </div>
         )}

         {(preview.highRes || preview.lowRes) && (
           <img
             src={preview.highRes || preview.lowRes}
             alt="Export preview"
             className={cn(
               'w-full h-full object-contain',
               !preview.highRes && preview.lowRes && 'blur-sm'
             )}
           />
         )}

         {preview.loading && preview.lowRes && (
           <div className="absolute top-2 right-2">
             <Spinner size="sm" />
           </div>
         )}
       </div>
     </div>
   );
   ```

5. **Format-based visibility:**
   ```typescript
   const showPreview = ['svg', 'png', 'pdf'].includes(selectedFormat);
   ```

## UI/UX Specification

### Dialog Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Export                                                       X │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────┐  Format                                │
│ │ Preview         [↻] │  ○ SVG                                 │
│ ├─────────────────────┤  ○ PNG                                 │
│ │                     │  ○ PDF                                 │
│ │                     │  ○ CSV                                 │
│ │     [Actual         │  ○ JSON                                │
│ │      Survey         │                                        │
│ │      Preview]       │  Resolution (PNG only)                 │
│ │                     │  [1920] x [1080]                       │
│ │                     │                                        │
│ │                     │  [ ] Include scale bar                 │
│ │                     │  [ ] Include section names             │
│ │                     │                                        │
│ └─────────────────────┘                                        │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                      [Cancel]    [Export]       │
└─────────────────────────────────────────────────────────────────┘
```

### Progressive Rendering

1. **Initial state**: Loading spinner
2. **Low-res loaded**: Blurred image (200px scaled up)
3. **High-res loading**: Clear image with small spinner overlay
4. **Complete**: Clear 400px image

### No Preview for Data Formats

When CSV or JSON selected:
```
┌─────────────────────────────────────────────────────────────────┐
│ Export                                                       X │
├─────────────────────────────────────────────────────────────────┤
│  Format                                                         │
│  ○ SVG                                                          │
│  ○ PNG                                                          │
│  ● CSV  ← Selected                                              │
│  ○ JSON                                                         │
│                                                                 │
│  (No preview - data will be exported as CSV)                    │
│                                                                 │
```

### Settings UI

```
Export Settings
├─ Preview update mode:
│    ○ Live (instant updates)
│    ○ Debounced (Recommended)
│    ○ Manual (refresh button only)
├─ Debounce delay: [500] ms
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Very large project | Use sampling or limit detail |
| Rapid option changes | Cancel previous render |
| Map not ready | Show "Loading map..." |
| Format change to data | Hide preview |
| Export while preview loading | Use current preview state |

## Testing

### Manual Tests

1. Open Export Dialog with PNG selected
2. Verify preview shows project data
3. Change resolution, verify preview updates
4. Switch to CSV, verify preview hidden
5. Switch to PDF, verify preview shows
6. Test manual refresh mode

### Automated Tests

```typescript
describe('ExportPreview', () => {
  it('shows preview for image formats', () => {});
  it('hides preview for data formats', () => {});
  it('shows progressive rendering', () => {});
  it('debounces updates', () => {});
  it('shows refresh button in manual mode', () => {});
});
```

## Dependencies

- None (uses existing map capture logic)

## Acceptance Criteria

- [ ] 400px preview thumbnail displays
- [ ] Preview shows actual project data
- [ ] Progressive rendering (low-res then high-res)
- [ ] Preview only for SVG/PNG/PDF
- [ ] Debounced updates (500ms default)
- [ ] Settings for update mode
- [ ] Preview updates when options change
- [ ] No preview for CSV/JSON formats
