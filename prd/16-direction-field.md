# PRD: Add Direction Field to DMP Import Dialog

## Overview

**Task ID:** 16
**Priority:** High
**Phase:** 5 - Polish
**Estimated Complexity:** Medium

### Summary

Add an IN/OUT direction field to each section in the DMP Import Dialog, always visible, with a separate "Reverse Section" action that applies full data transformation on import.

## Background

Survey direction (IN = entering cave, OUT = exiting) is important metadata. Some DMP files contain direction data that should be displayed and editable. The reverse operation transforms shot data (reverses order, adjusts azimuths) for sections surveyed in the opposite direction.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Display direction dropdown (IN/OUT) per section | Must |
| F2 | Direction always visible in section row | Must |
| F3 | Direction stored as metadata | Must |
| F4 | Separate "Reverse Section" button per section | Must |
| F5 | Reverse applies: reverse shot order + adjust azimuths (+180°) | Must |
| F6 | Apply reverse transformation on import | Must |
| F7 | No confirmation needed for reverse (undoable) | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Reverse transformation should be instant | Must |
| NF2 | Visual feedback when section reversed | Should |

## User Decisions

- Direction display: Always visible in section row
- Direction values: IN/OUT enum (simple two-value)
- Reverse operation: Full transformation (reverse order + adjust azimuths)
- Reverse timing: Apply transformation on import (not stored as deferred operation)
- Reverse confirmation: No confirmation needed (undoable)

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dialogs/DmpImportDialog.tsx` | Add direction dropdown and reverse button |
| `src-tauri/src/models/section.rs` | Add direction field to Section model |
| `src/types/project.ts` | Add direction to Section type |

### Backend Changes

```rust
// src-tauri/src/models/section.rs

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SurveyDirection {
    In,
    Out,
}

impl Default for SurveyDirection {
    fn default() -> Self {
        Self::In
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    // ... existing fields
    pub direction: SurveyDirection,
}
```

### Implementation Details

1. **Direction state in dialog:**
   ```typescript
   type SurveyDirection = 'in' | 'out';

   interface DmpSectionState {
     selected: boolean;
     name: string;
     direction: SurveyDirection;
     reversed: boolean;
     shots: Shot[];
   }

   const [sections, setSections] = useState<DmpSectionState[]>([]);
   ```

2. **Direction dropdown:**
   ```typescript
   const DirectionDropdown: React.FC<{
     value: SurveyDirection;
     onChange: (value: SurveyDirection) => void;
   }> = ({ value, onChange }) => (
     <Select value={value} onValueChange={onChange}>
       <SelectTrigger className="w-24">
         <SelectValue />
       </SelectTrigger>
       <SelectContent>
         <SelectItem value="in">IN</SelectItem>
         <SelectItem value="out">OUT</SelectItem>
       </SelectContent>
     </Select>
   );
   ```

3. **Reverse transformation:**
   ```typescript
   const reverseSection = (section: DmpSectionState): DmpSectionState => {
     const reversedShots = [...section.shots].reverse().map((shot, i, arr) => ({
       ...shot,
       // Swap from/to indices
       from_index: arr.length - 1 - i,
       to_index: arr.length - i,
       // Adjust azimuths by 180°
       azimuth: shot.azimuth !== null
         ? (shot.azimuth + 180) % 360
         : null,
       azimuth_in: shot.azimuth_in !== null
         ? (shot.azimuth_in + 180) % 360
         : null,
       azimuth_out: shot.azimuth_out !== null
         ? (shot.azimuth_out + 180) % 360
         : null,
     }));

     return {
       ...section,
       reversed: !section.reversed,
       shots: reversedShots,
     };
   };
   ```

4. **Section row in dialog:**
   ```typescript
   const SectionRow: React.FC<{
     section: DmpSectionState;
     onToggle: () => void;
     onDirectionChange: (dir: SurveyDirection) => void;
     onReverse: () => void;
   }> = ({ section, onToggle, onDirectionChange, onReverse }) => (
     <tr className={section.reversed ? 'bg-yellow-500/10' : ''}>
       <td>
         <Checkbox checked={section.selected} onChange={onToggle} />
       </td>
       <td>{section.name}</td>
       <td>{section.shots.length} shots</td>
       <td>
         <DirectionDropdown
           value={section.direction}
           onChange={onDirectionChange}
         />
       </td>
       <td>
         <Button
           variant="outline"
           size="sm"
           onClick={onReverse}
         >
           {section.reversed ? '↩ Undo Reverse' : '↔ Reverse'}
         </Button>
       </td>
     </tr>
   );
   ```

5. **Import handler:**
   ```typescript
   const handleImport = async () => {
     for (const section of selectedSections) {
       // Shots already transformed if reversed
       await createSection({
         name: section.name,
         direction: section.direction,
         shots: section.shots,
         // ... other fields
       });
     }
   };
   ```

## UI/UX Specification

### Section List Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ DMP Import: survey.dmp                                       X │
├─────────────────────────────────────────────────────────────────┤
│ Select sections to import:                                      │
│                                                                 │
│ | ☐ | Name           | Shots | Direction | Actions    |        │
│ |---|----------------|-------|-----------|------------|        │
│ | ☑ | Main Passage   | 45    | [IN ▼]    | [Reverse]  |        │
│ | ☑ | Side Gallery   | 23    | [OUT ▼]   | [Reverse]  |        │
│ | ☐ | Dead End       | 8     | [IN ▼]    | [Reverse]  |        │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                      [Cancel]    [Import]       │
└─────────────────────────────────────────────────────────────────┘
```

### Reversed State Visual

When a section is reversed:
- Row background: Subtle yellow tint
- Button text changes: "↩ Undo Reverse"

```
│ | ☑ | Side Gallery   | 23    | [OUT ▼]   | [↩ Undo]   |        │
│                                          highlighted row         │
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| DMP has no direction | Default to "IN" |
| Single-shot section | Reverse adjusts azimuth only |
| Section with no azimuth data | Skip azimuth adjustment |
| Reverse twice | Returns to original |
| Mixed directions in DMP | Parse from file |

## Testing

### Manual Tests

1. Open DMP with direction data, verify displayed
2. Change direction dropdown, verify persists
3. Click Reverse, verify shots transform
4. Click Undo Reverse, verify restore
5. Import reversed section, verify data correct

### Automated Tests

```typescript
describe('reverseSection', () => {
  it('reverses shot order', () => {
    const section = { shots: [shot1, shot2, shot3] };
    const reversed = reverseSection(section);
    expect(reversed.shots[0]).toBe(shot3);
  });

  it('adjusts azimuths by 180°', () => {
    const section = { shots: [{ azimuth: 45 }] };
    const reversed = reverseSection(section);
    expect(reversed.shots[0].azimuth).toBe(225);
  });

  it('handles azimuth wraparound', () => {
    const section = { shots: [{ azimuth: 270 }] };
    const reversed = reverseSection(section);
    expect(reversed.shots[0].azimuth).toBe(90);
  });
});
```

### Integration Tests

```rust
#[test]
fn test_section_direction_serialization() {
    let section = Section {
        direction: SurveyDirection::Out,
        ..Default::default()
    };
    let json = serde_json::to_string(&section).unwrap();
    assert!(json.contains("\"direction\":\"Out\""));
}
```

## Dependencies

- Backend model change: Section direction field

## Acceptance Criteria

- [ ] Direction dropdown (IN/OUT) visible for each section
- [ ] Direction defaults to IN if not in DMP
- [ ] Direction stored as metadata in Section
- [ ] Reverse button transforms shot data
- [ ] Reverse: shots order reversed
- [ ] Reverse: azimuths adjusted by +180°
- [ ] Transformation applied on import (not stored)
- [ ] No confirmation for reverse
- [ ] Undo reverse available
