# PRD: Add Metadata Side Panel to GlobalView

## Overview

**Task ID:** 14
**Priority:** High
**Phase:** 4 - GlobalView Enhancements
**Estimated Complexity:** Medium

### Summary

Add a side panel on the right of GlobalView that shows project metadata and thumbnail preview when a project is selected, with an "Open" button to open the project.

## Background

Currently, clicking a project card immediately opens it. A side panel allows users to preview project details before deciding to open, especially useful when browsing multiple projects.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Single-click selects project, shows panel | Must |
| F2 | Double-click opens project | Must |
| F3 | Panel on right side | Must |
| F4 | Show extended metadata (name, path, dates, stats) | Must |
| F5 | Show thumbnail preview | Must |
| F6 | Panel always visible when project selected | Must |
| F7 | "Open" button in panel | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Panel should animate smoothly | Should |
| NF2 | Thumbnail should load quickly | Should |

## User Decisions

- Panel position: Right side
- Panel content: Extended metadata (name, path, dates, stats) + thumbnail preview
- Panel collapse: No collapse (always visible when project selected)

## Technical Specification

### Files to Create/Modify

| File | Changes |
|------|---------|
| `src/components/GlobalView/GlobalView.tsx` | Add selection state and panel |
| `src/components/GlobalView/ProjectDetailPanel.tsx` | New: Side panel component |
| `src/components/GlobalView/SystemCard.tsx` | Change to select on click |

### Implementation Details

1. **Selection state:**
   ```typescript
   // In GlobalView.tsx
   const [selectedProject, setSelectedProject] = useState<string | null>(null);

   const selectedMetadata = useMemo(() =>
     projects.find(p => p.path === selectedProject),
     [projects, selectedProject]
   );
   ```

2. **SystemCard changes:**
   ```typescript
   const SystemCard: React.FC<{
     project: ProjectMetadata;
     isSelected: boolean;
     onSelect: () => void;
     onOpen: () => void;
   }> = ({ project, isSelected, onSelect, onOpen }) => {
     return (
       <div
         className={cn(
           'card cursor-pointer transition-all',
           isSelected && 'ring-2 ring-blue-500'
         )}
         onClick={onSelect}
         onDoubleClick={onOpen}
       >
         <h3>{project.name}</h3>
         <p>{formatDate(project.modified_at)}</p>
       </div>
     );
   };
   ```

3. **ProjectDetailPanel component:**
   ```typescript
   // src/components/GlobalView/ProjectDetailPanel.tsx

   interface ProjectDetailPanelProps {
     project: ProjectMetadata;
     onOpen: () => void;
     onClose: () => void;
   }

   export const ProjectDetailPanel: React.FC<ProjectDetailPanelProps> = ({
     project,
     onOpen,
     onClose,
   }) => {
     const [thumbnail, setThumbnail] = useState<string | null>(null);

     useEffect(() => {
       // Load thumbnail
       loadProjectThumbnail(project.path).then(setThumbnail);
     }, [project.path]);

     return (
       <div className="w-[300px] border-l bg-background p-4 flex flex-col">
         <div className="flex justify-between items-center mb-4">
           <h2 className="text-lg font-semibold">{project.name}</h2>
           <button onClick={onClose} aria-label="Close panel">×</button>
         </div>

         {/* Thumbnail */}
         <div className="aspect-square bg-muted rounded mb-4 flex items-center justify-center">
           {thumbnail ? (
             <img src={thumbnail} alt="Project preview" className="w-full h-full object-contain" />
           ) : (
             <span className="text-muted-foreground">Loading preview...</span>
           )}
         </div>

         {/* Metadata */}
         <div className="space-y-2 flex-1">
           <MetadataRow label="Path" value={project.path} />
           <MetadataRow label="Created" value={formatDate(project.created_at)} />
           <MetadataRow label="Modified" value={formatDate(project.modified_at)} />
           <MetadataRow label="Sections" value={project.section_count} />
           <MetadataRow label="Shots" value={project.shot_count} />
           <MetadataRow label="Total Length" value={`${project.total_length.toFixed(1)} m`} />
           {project.gps_latitude && (
             <MetadataRow
               label="GPS"
               value={`${project.gps_latitude.toFixed(6)}, ${project.gps_longitude?.toFixed(6)}`}
             />
           )}
         </div>

         {/* Open button */}
         <Button className="w-full mt-4" onClick={onOpen}>
           Open Project
         </Button>
       </div>
     );
   };

   const MetadataRow: React.FC<{ label: string; value: string | number }> = ({
     label,
     value,
   }) => (
     <div className="flex justify-between text-sm">
       <span className="text-muted-foreground">{label}</span>
       <span className="truncate max-w-[180px]" title={String(value)}>{value}</span>
     </div>
   );
   ```

4. **GlobalView layout:**
   ```typescript
   <div className="flex h-full">
     {/* Main content */}
     <div className="flex-1 overflow-auto p-4">
       <Tabs ...>
         {/* Grid and Map tabs */}
       </Tabs>
     </div>

     {/* Side panel */}
     {selectedMetadata && (
       <ProjectDetailPanel
         project={selectedMetadata}
         onOpen={() => openProject(selectedMetadata.path)}
         onClose={() => setSelectedProject(null)}
       />
     )}
   </div>
   ```

5. **Thumbnail generation:**
   ```typescript
   const loadProjectThumbnail = async (path: string): Promise<string> => {
     // Option 1: Pre-generated thumbnail stored with project
     // Option 2: Generate on-demand using canvas rendering
     const result = await invoke('generate_project_thumbnail', { path });
     return `data:image/png;base64,${result}`;
   };
   ```

## UI/UX Specification

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ CaveChef                                                        │
├─────────────────────────────────────────────────────────────────┤
│  [Grid]  [Map]                                                  │
├───────────────────────────────────────────┬─────────────────────┤
│                                           │ Project Name      X │
│  ┌──────┐  ┌──────┐  ┌──────┐            │                     │
│  │      │  │ ████ │  │      │            │ ┌─────────────────┐ │
│  │ Proj │  │ Proj │  │ Proj │            │ │                 │ │
│  │  A   │  │  B   │  │  C   │            │ │    Thumbnail    │ │
│  └──────┘  └──────┘  └──────┘            │ │                 │ │
│                 ↑ selected                │ └─────────────────┘ │
│                                           │                     │
│  ┌──────┐  ┌──────┐                      │ Path: /path/to/proj │
│  │      │  │      │                      │ Created: Jan 15     │
│  │ Proj │  │ Proj │                      │ Modified: Jan 20    │
│  │  D   │  │  E   │                      │ Sections: 5         │
│  └──────┘  └──────┘                      │ Shots: 127          │
│                                           │ Total: 1,234.5 m    │
│                                           │                     │
│                                           │ [  Open Project  ]  │
└───────────────────────────────────────────┴─────────────────────┘
```

### Interaction

| Action | Result |
|--------|--------|
| Click project card | Select, show panel |
| Double-click card | Open project |
| Click "Open" button | Open project |
| Click X on panel | Deselect, hide panel |
| Click outside all cards | Deselect, hide panel |

### Panel Appearance

- **Width**: 300px fixed
- **Background**: Same as app background
- **Border**: Left border for separation
- **Thumbnail**: Square aspect ratio, contained fit
- **Animation**: Slide in from right (optional)

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Very long project name | Truncate with ellipsis |
| Very long path | Truncate with ellipsis, full on hover |
| Thumbnail load failure | Show placeholder icon |
| Rapid selection changes | Cancel previous thumbnail load |
| Window resize | Panel width fixed, content scrolls if needed |

## Testing

### Manual Tests

1. Click project card, verify panel appears
2. Verify all metadata displays correctly
3. Click "Open" button, verify project opens
4. Double-click card, verify project opens
5. Click X, verify panel closes
6. Click outside cards, verify deselection

### Automated Tests

```typescript
describe('ProjectDetailPanel', () => {
  it('shows project metadata', () => {});
  it('loads thumbnail', () => {});
  it('opens project on button click', () => {});
  it('truncates long values', () => {});
});

describe('GlobalView selection', () => {
  it('single click selects', () => {});
  it('double click opens', () => {});
  it('deselects on outside click', () => {});
});
```

## Dependencies

- Task 13 (GlobalView Map) for shared selection state

## Acceptance Criteria

- [ ] Single-click selects project, shows panel
- [ ] Double-click opens project
- [ ] Panel on right side, 300px width
- [ ] Shows name, path, dates, stats
- [ ] Shows thumbnail preview
- [ ] Panel always visible when selected
- [ ] "Open" button works
- [ ] X button closes panel
