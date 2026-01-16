# PRD: Add Per-Section Adjustment Dialog (Placement Options)

## Overview

**Task ID:** 10
**Priority:** High
**Phase:** 3 - GPS & Placement
**Estimated Complexity:** High

### Summary

After the main import dialog, show a per-section adjustment dialog allowing modification of metadata and selection of placement method (None, GPS, From Existing Station, Manual Map Placement).

## Background

The two-step import flow separates data entry from placement decisions:
1. **Import Dialog**: Enter/review shot data
2. **Per-Section Dialog**: Adjust metadata and choose how to place each section

This allows precise control over how imported sections integrate with existing survey data.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Show dialog for EACH section (even single imports) | Must |
| F2 | Display section metadata (name, surveyor, date, color) | Must |
| F3 | Placement method selection | Must |
| F4 | Mini-preview in dialog | Must |
| F5 | Map highlight of target station | Must |
| F6 | Show loop closure error % when creating loops | Must |
| F7 | "None" placement positions at map viewport center | Must |
| F8 | Support From Existing Station with section/station dropdowns | Must |
| F9 | Support Manual Map Placement (Task 11) | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Dialog should not block map interaction for preview | Should |
| NF2 | Preview should update instantly | Must |

## User Decisions

- Always show dialog (not skippable) - one per section even for single imports
- Preview: Both mini-preview in dialog AND map highlight
- Loop warnings: Show closure error percentage
- "None" placement: Position section at current map viewport center

## Technical Specification

### Files to Create/Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/SectionAdjustDialog.tsx` | New: Per-section adjustment dialog |
| `src/components/Dialogs/ImportDialog.tsx` | Trigger adjustment flow after main import |
| `src/components/Dialogs/DmpImportDialog.tsx` | Trigger adjustment flow |
| `src-tauri/src/commands/section.rs` | Modify `create_section` to return section ID |

### Backend Change Required

```rust
// src-tauri/src/commands/section.rs
#[tauri::command]
pub async fn create_section(
    state: State<'_, AppState>,
    section_data: SectionInput,
) -> Result<CreateSectionResult, String> {
    // ... existing logic
    Ok(CreateSectionResult {
        success: true,
        section_id: new_section.id,
        warnings: vec![],
    })
}
```

### Implementation Details

1. **Dialog state:**
   ```typescript
   interface SectionAdjustment {
     name: string;
     surveyor: string;
     date: string | null;
     color: string;
     placementMethod: 'none' | 'gps' | 'from_station' | 'manual';
     gpsCoordinates?: ParsedCoordinates;
     connectToSection?: number;
     connectToStation?: number;
     connectStationEnd: 'first' | 'last';
   }
   ```

2. **Dialog component:**
   ```typescript
   const SectionAdjustDialog: React.FC<{
     section: ImportedSection;
     existingSections: Section[];
     onConfirm: (adjustment: SectionAdjustment) => void;
     onCancel: () => void;
   }> = ({ section, existingSections, onConfirm, onCancel }) => {
     const [adjustment, setAdjustment] = useState<SectionAdjustment>({
       name: section.name,
       surveyor: section.surveyor || '',
       date: section.date,
       color: section.color || generateColor(),
       placementMethod: 'none',
       connectStationEnd: 'first',
     });

     const loopError = useMemo(() => {
       if (adjustment.placementMethod !== 'from_station') return null;
       return calculateLoopError(
         section,
         adjustment.connectToSection!,
         adjustment.connectToStation!
       );
     }, [adjustment]);

     return (
       <Dialog>
         <DialogHeader>Adjust Section: {section.name}</DialogHeader>
         <DialogContent>
           <div className="flex gap-4">
             {/* Mini preview on left */}
             <SectionPreview shots={section.shots} />

             {/* Settings on right */}
             <div className="flex-1">
               <TextField label="Name" value={adjustment.name} ... />
               <TextField label="Surveyor" value={adjustment.surveyor} ... />
               <DatePicker label="Date" value={adjustment.date} ... />
               <ColorPicker label="Color" value={adjustment.color} ... />

               <h3>Placement Method</h3>
               <RadioGroup value={adjustment.placementMethod} onChange={...}>
                 <Radio value="none">None (position at map center)</Radio>
                 <Radio value="gps">GPS Coordinates</Radio>
                 <Radio value="from_station">From Existing Station</Radio>
                 <Radio value="manual">Manual Map Placement</Radio>
               </RadioGroup>

               {adjustment.placementMethod === 'from_station' && (
                 <FromStationSelector
                   sections={existingSections}
                   onChange={(s, st, end) => setAdjustment({
                     ...adjustment,
                     connectToSection: s,
                     connectToStation: st,
                     connectStationEnd: end,
                   })}
                 />
               )}

               {loopError && (
                 <WarningBanner>
                   This will create a loop with {loopError.percentage.toFixed(1)}% closure error
                 </WarningBanner>
               )}
             </div>
           </div>
         </DialogContent>
         <DialogFooter>
           <Button onClick={onCancel}>Cancel</Button>
           <Button onClick={() => onConfirm(adjustment)}>Confirm</Button>
         </DialogFooter>
       </Dialog>
     );
   };
   ```

3. **Import flow integration:**
   ```typescript
   // In ImportDialog.tsx
   const handleImport = async () => {
     // Step 1: Validate data
     // Step 2: Show per-section adjustment dialogs
     for (const section of sectionsToImport) {
       const adjustment = await showAdjustmentDialog(section);
       if (!adjustment) {
         // User cancelled
         return;
       }
       adjustments.push(adjustment);
     }

     // Step 3: Execute imports with adjustments
     for (let i = 0; i < sectionsToImport.length; i++) {
       const result = await createSection(sectionsToImport[i], adjustments[i]);
       if (adjustments[i].placementMethod === 'gps') {
         await setZeroDatum(result.section_id, 0, adjustments[i].gpsCoordinates);
       } else if (adjustments[i].placementMethod === 'from_station') {
         await mergeStations(/* ... */);
       }
     }
   };
   ```

## UI/UX Specification

### Dialog Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Adjust Section: Main Passage                                  X │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐  Name: [Main Passage_______________]           │
│ │             │  Surveyor: [John Doe________________]          │
│ │   Preview   │  Date: [2024-01-15]                            │
│ │     ●──●    │  Color: [█ Blue ▼]                             │
│ │     │       │                                                 │
│ │     ●──●    │  Placement Method                              │
│ │             │  ○ None (position at map center)               │
│ └─────────────┘  ○ GPS Coordinates                             │
│                  ○ From Existing Station                       │
│                  ○ Manual Map Placement                        │
│                                                                 │
│                  ⚠ This will create a loop with 2.3% error     │
├─────────────────────────────────────────────────────────────────┤
│                                      [Cancel]  [Confirm]        │
└─────────────────────────────────────────────────────────────────┘
```

### From Existing Station Selector

```
Connect to:
Section: [Section A ▼]
Station: [Station 5 ▼]
Connect using: ○ First station  ○ Last station
```

### Map Highlight

When "From Existing Station" is selected, highlight the target station on the map with a pulsing indicator.

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No existing sections | Hide "From Existing Station" option |
| GPS unavailable | Show GPS input field anyway |
| Cancel mid-flow | Revert all changes, no partial import |
| Loop with high error | Show warning but allow proceed |
| Single section import | Still show dialog |

## Testing

### Manual Tests

1. Import single section, verify dialog appears
2. Import multiple sections, verify dialog for each
3. Test each placement method
4. Create a loop, verify error percentage shown
5. Cancel mid-flow, verify no partial import
6. Use manual placement mode

### Automated Tests

```typescript
describe('SectionAdjustDialog', () => {
  it('shows for each section', () => {});
  it('allows metadata editing', () => {});
  it('calculates loop error correctly', () => {});
  it('triggers manual placement mode', () => {});
});
```

## Dependencies

- Task 11 (Manual Map Placement) for manual placement mode
- Backend change: `create_section` must return section ID

## Acceptance Criteria

- [ ] Dialog appears for EVERY section imported
- [ ] Metadata fields editable (name, surveyor, date, color)
- [ ] All 4 placement methods available
- [ ] Mini-preview shows section shape
- [ ] Map highlights target station for "From Existing Station"
- [ ] Loop closure error % displayed when applicable
- [ ] "None" places section at map viewport center
- [ ] Cancel aborts entire import flow
