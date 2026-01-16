# PRD: Add Multi-Select for System Merging in GlobalView

## Overview

**Task ID:** 15
**Priority:** High
**Phase:** 4 - GlobalView Enhancements
**Estimated Complexity:** High

### Summary

Add multi-select capability to GlobalView (max 2 projects for v1) with Shift/Ctrl click behavior, and ability to merge selected projects with conflict resolution.

## Background

Merging projects combines multiple cave system surveys into a single unified project. This is useful when separate surveys need to be combined, such as when different teams survey different sections of the same cave system.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Multi-select with Shift/Ctrl click | Must |
| F2 | Maximum 2 projects for merge (v1) | Must |
| F3 | Merge action creates new project | Must |
| F4 | Archive original projects to system folder | Must |
| F5 | Show merge preview (map + statistics) | Must |
| F6 | Handle name conflicts (user resolves by default) | Must |
| F7 | Settings for conflict resolution strategy | Should |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Merge operation should not corrupt data | Must |
| NF2 | Original projects must be recoverable | Must |

## User Decisions

- Max select: 2 projects only (for v1)
- Original projects: Archive to system folder (~/.config/cavechef/archive/)
- Merge preview: Show both map preview and statistics summary
- Name conflicts: User resolves by default; auto-suffix and keep-all also available in Settings

## Technical Specification

### Files to Create/Modify

| File | Changes |
|------|---------|
| `src/components/GlobalView/GlobalView.tsx` | Multi-select logic |
| `src/components/Dialogs/MergeProjectsDialog.tsx` | New: Merge dialog |
| `src-tauri/src/commands/project.rs` | New: merge_projects command |

### Backend Changes

```rust
// src-tauri/src/commands/project.rs

#[derive(Deserialize)]
pub struct MergeProjectsInput {
    pub project_paths: Vec<PathBuf>,
    pub output_name: String,
    pub section_renames: HashMap<String, String>, // old_name -> new_name
    pub archive_originals: bool,
}

#[derive(Serialize)]
pub struct MergeResult {
    pub success: bool,
    pub output_path: PathBuf,
    pub archived_paths: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn merge_projects(
    state: State<'_, AppState>,
    input: MergeProjectsInput,
) -> Result<MergeResult, String> {
    // 1. Load both projects
    // 2. Combine sections
    // 3. Resolve conflicts based on renames
    // 4. Create new project
    // 5. Archive originals
}
```

### Implementation Details

1. **Multi-select state:**
   ```typescript
   const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());

   const handleSelect = (path: string, event: React.MouseEvent) => {
     if (event.shiftKey || event.ctrlKey || event.metaKey) {
       // Add/toggle selection
       setSelectedProjects(prev => {
         const next = new Set(prev);
         if (next.has(path)) {
           next.delete(path);
         } else if (next.size < 2) {
           next.add(path);
         }
         return next;
       });
     } else {
       // Single select
       setSelectedProjects(new Set([path]));
     }
   };
   ```

2. **Merge dialog:**
   ```typescript
   interface MergeConflict {
     type: 'section_name';
     value: string;
     projects: string[];
   }

   const MergeProjectsDialog: React.FC<{
     projects: ProjectMetadata[];
     onMerge: (config: MergeConfig) => void;
     onCancel: () => void;
   }> = ({ projects, onMerge, onCancel }) => {
     const [outputName, setOutputName] = useState('Merged Project');
     const [conflicts, setConflicts] = useState<MergeConflict[]>([]);
     const [resolutions, setResolutions] = useState<Map<string, string>>(new Map());

     // Detect conflicts
     useEffect(() => {
       const sectionNames = new Map<string, string[]>();
       for (const project of projects) {
         for (const section of project.sections) {
           const existing = sectionNames.get(section.name) || [];
           sectionNames.set(section.name, [...existing, project.path]);
         }
       }

       const conflicts = Array.from(sectionNames.entries())
         .filter(([_, paths]) => paths.length > 1)
         .map(([name, paths]) => ({
           type: 'section_name' as const,
           value: name,
           projects: paths,
         }));

       setConflicts(conflicts);
     }, [projects]);

     return (
       <Dialog>
         <DialogHeader>Merge Projects</DialogHeader>
         <DialogContent>
           {/* Preview */}
           <div className="flex gap-4 mb-4">
             <MergePreviewMap projects={projects} />
             <MergeStats projects={projects} />
           </div>

           {/* Output name */}
           <TextField
             label="Merged Project Name"
             value={outputName}
             onChange={setOutputName}
           />

           {/* Conflicts */}
           {conflicts.length > 0 && (
             <div className="mt-4">
               <h3>Name Conflicts</h3>
               {conflicts.map(conflict => (
                 <ConflictResolver
                   key={conflict.value}
                   conflict={conflict}
                   resolution={resolutions.get(conflict.value)}
                   onResolve={(newName) => {
                     setResolutions(new Map(resolutions).set(conflict.value, newName));
                   }}
                 />
               ))}
             </div>
           )}
         </DialogContent>
         <DialogFooter>
           <Button variant="outline" onClick={onCancel}>Cancel</Button>
           <Button
             onClick={() => onMerge({ outputName, resolutions })}
             disabled={conflicts.some(c => !resolutions.has(c.value))}
           >
             Merge Projects
           </Button>
         </DialogFooter>
       </Dialog>
     );
   };
   ```

3. **Conflict resolution component:**
   ```typescript
   const ConflictResolver: React.FC<{
     conflict: MergeConflict;
     resolution: string | undefined;
     onResolve: (newName: string) => void;
   }> = ({ conflict, resolution, onResolve }) => {
     return (
       <div className="p-2 border rounded mb-2">
         <p className="font-medium">
           Section "{conflict.value}" exists in both projects
         </p>
         <div className="flex gap-2 mt-2">
           <TextField
             placeholder="New name for duplicate"
             value={resolution || ''}
             onChange={onResolve}
           />
         </div>
       </div>
     );
   };
   ```

4. **Archive handling:**
   ```typescript
   const archiveProjects = async (paths: string[]): Promise<string[]> => {
     const archiveDir = await join(
       await appConfigDir(),
       'archive',
       new Date().toISOString().split('T')[0]
     );

     await createDir(archiveDir, { recursive: true });

     const archivedPaths = [];
     for (const path of paths) {
       const filename = await basename(path);
       const destPath = await join(archiveDir, filename);
       await copyFile(path, destPath);
       archivedPaths.push(destPath);
     }

     return archivedPaths;
   };
   ```

## UI/UX Specification

### Multi-Select Visual

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────┐  ┌──────┐  ┌──────┐                                │
│  │ ████ │  │      │  │ ████ │    2 selected                  │
│  │ Proj │  │ Proj │  │ Proj │    [Merge]  [Cancel]           │
│  │  A   │  │  B   │  │  C   │                                │
│  └──────┘  └──────┘  └──────┘                                │
│  selected            selected                                 │
│  (ring)              (ring)                                   │
└──────────────────────────────────────────────────────────────┘
```

### Merge Dialog

```
┌─────────────────────────────────────────────────────────────────┐
│ Merge Projects                                               X │
├─────────────────────────────────────────────────────────────────┤
│ ┌────────────────────┐ ┌────────────────────────────────────┐  │
│ │                    │ │ Combined Statistics                │  │
│ │   Map Preview      │ │                                    │  │
│ │   (both projects)  │ │ Total Sections: 8                  │  │
│ │                    │ │ Total Shots: 245                   │  │
│ │                    │ │ Total Length: 3,456.7 m            │  │
│ └────────────────────┘ └────────────────────────────────────┘  │
│                                                                 │
│ Merged Project Name: [Combined Survey_________________]        │
│                                                                 │
│ ⚠ Name Conflicts                                               │
│ ┌─────────────────────────────────────────────────────────────┐│
│ │ Section "Main Passage" exists in both projects              ││
│ │ Rename to: [Main Passage (Project B)_______________]        ││
│ └─────────────────────────────────────────────────────────────┘│
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                      [Cancel]    [Merge]        │
└─────────────────────────────────────────────────────────────────┘
```

### Settings UI

```
Merge Settings
├─ Default conflict resolution:
│    ○ Ask user (Recommended)
│    ○ Auto-suffix (e.g., "Section A (2)")
│    ○ Keep all names (allow duplicates)
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Same project selected twice | Prevent (max 1 of each) |
| Projects with same name | User must rename output |
| Archive folder full | Create dated subfolder |
| Merge fails mid-process | Rollback, keep originals |
| No conflicts | Skip conflict step |

## Testing

### Manual Tests

1. Ctrl+click to multi-select 2 projects
2. Click Merge, verify dialog appears
3. Resolve any conflicts
4. Verify merged project created
5. Verify originals archived

### Integration Tests

```rust
#[tokio::test]
async fn test_merge_projects() {
    let project_a = create_test_project("A");
    let project_b = create_test_project("B");

    let result = merge_projects(MergeProjectsInput {
        project_paths: vec![project_a.path, project_b.path],
        output_name: "Merged".into(),
        section_renames: HashMap::new(),
        archive_originals: true,
    }).await.unwrap();

    assert!(result.success);
    assert!(result.output_path.exists());
}
```

## Dependencies

- Task 13 (GlobalView Map) for selection infrastructure
- Task 14 (Metadata Panel) for panel integration
- New backend command: `merge_projects`

## Acceptance Criteria

- [ ] Shift/Ctrl click enables multi-select
- [ ] Maximum 2 projects selectable
- [ ] Merge dialog shows preview (map + stats)
- [ ] Name conflicts detected and resolution UI shown
- [ ] Default: User resolves conflicts
- [ ] Settings for auto-suffix and keep-all options
- [ ] Original projects archived to system folder
- [ ] Merged project created successfully
