# PRD: Add GPS-Based Map Display in GlobalView

## Overview

**Task ID:** 13
**Priority:** High
**Phase:** 4 - GlobalView Enhancements
**Estimated Complexity:** High

### Summary

Add a map view tab to GlobalView that displays full project surveys positioned by their GPS coordinates, with project-level selection.

## Background

The GlobalView currently shows a grid of recent projects. Adding a map view allows users to see their projects geographically positioned, useful for managing multiple cave systems in a region.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Tab system: Grid view + Map view | Must |
| F2 | Default to Grid view | Must |
| F3 | Render full project surveys (not just markers) | Must |
| F4 | Project-level selection (click any part selects whole project) | Must |
| F5 | Layer overlapping projects with most recent on top | Must |
| F6 | Map tab disabled when no GPS projects exist | Must |
| F7 | Text-based tabs (not icons) | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Map should render smoothly with multiple projects | Must |
| NF2 | Selection should be instant | Must |

## User Decisions

- Tab style: Text tabs (not icons)
- Default view: Grid view (not map)
- Project overlap handling: Layer on top (most recent on top)
- Render full surveys; project-level selection
- Map tab disabled when no GPS projects exist

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/GlobalView/GlobalView.tsx` | Add tab system and map view |
| `src/types/project.ts` | Extend ProjectMetadata with GPS |
| `src-tauri/src/models/project.rs` | Add GPS to ProjectMetadata |
| `src-tauri/src/commands/project.rs` | Update metadata extraction |

### Backend Change Required

```rust
// src-tauri/src/models/project.rs
#[derive(Serialize, Deserialize)]
pub struct ProjectMetadata {
    pub name: String,
    pub path: PathBuf,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub section_count: usize,
    pub shot_count: usize,
    pub total_length: f64,
    // New fields
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
}

impl ProjectMetadata {
    pub fn from_project(project: &Project, path: PathBuf) -> Self {
        // Get GPS from first zero datum
        let (lat, lng) = project.zero_datums
            .first()
            .map(|zd| (zd.latitude, zd.longitude))
            .unwrap_or((None, None));

        Self {
            // ... existing fields
            gps_latitude: lat,
            gps_longitude: lng,
        }
    }
}
```

### Implementation Details

1. **Tab state:**
   ```typescript
   type GlobalViewTab = 'grid' | 'map';

   const [activeTab, setActiveTab] = useState<GlobalViewTab>('grid');

   const hasGpsProjects = useMemo(() =>
     projects.some(p => p.gps_latitude != null && p.gps_longitude != null),
     [projects]
   );
   ```

2. **Tab component:**
   ```typescript
   <Tabs value={activeTab} onValueChange={setActiveTab}>
     <TabsList>
       <TabsTrigger value="grid">Grid</TabsTrigger>
       <TabsTrigger value="map" disabled={!hasGpsProjects}>
         Map
       </TabsTrigger>
     </TabsList>

     <TabsContent value="grid">
       <ProjectGrid projects={projects} ... />
     </TabsContent>

     <TabsContent value="map">
       <GlobalMap projects={gpsProjects} ... />
     </TabsContent>
   </Tabs>
   ```

3. **Map rendering:**
   ```typescript
   const GlobalMap: React.FC<{
     projects: ProjectMetadata[];
     selectedProject: string | null;
     onSelect: (path: string) => void;
   }> = ({ projects, selectedProject, onSelect }) => {
     const mapRef = useRef<maplibregl.Map>(null);

     // Build GeoJSON for all projects
     const projectsGeoJSON = useMemo(() => {
       const features = projects
         .filter(p => p.gps_latitude && p.gps_longitude)
         .sort((a, b) => new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime())
         .map(project => ({
           type: 'Feature' as const,
           properties: {
             path: project.path,
             name: project.name,
           },
           geometry: buildProjectGeometry(project),
         }));

       return { type: 'FeatureCollection' as const, features };
     }, [projects]);

     // Handle click for project selection
     const handleClick = (e: MapMouseEvent) => {
       const features = mapRef.current?.queryRenderedFeatures(e.point, {
         layers: ['project-lines', 'project-stations'],
       });

       if (features && features.length > 0) {
         onSelect(features[0].properties.path);
       }
     };

     return (
       <Map
         ref={mapRef}
         onClick={handleClick}
         initialViewState={calculateBounds(projects)}
       >
         <Source id="projects" type="geojson" data={projectsGeoJSON}>
           <Layer
             id="project-lines"
             type="line"
             paint={{
               'line-color': ['case',
                 ['==', ['get', 'path'], selectedProject], '#3b82f6',
                 '#888888'
               ],
               'line-width': ['case',
                 ['==', ['get', 'path'], selectedProject], 3,
                 2
               ],
             }}
           />
           <Layer
             id="project-stations"
             type="circle"
             paint={{
               'circle-radius': 3,
               'circle-color': ['case',
                 ['==', ['get', 'path'], selectedProject], '#3b82f6',
                 '#888888'
               ],
             }}
           />
         </Source>
       </Map>
     );
   };
   ```

4. **Build project geometry:**
   ```typescript
   const buildProjectGeometry = (project: ProjectMetadata): GeoJSON.Geometry => {
     // Need to load project data for full geometry
     // This could be cached or loaded on demand
     const sections = loadProjectSections(project.path);

     const coordinates: [number, number][][] = sections.map(section => {
       return section.stations.map(station => [
         project.gps_longitude! + metersToLngOffset(station.x),
         project.gps_latitude! + metersToLatOffset(station.y),
       ]);
     });

     return {
       type: 'MultiLineString',
       coordinates,
     };
   };
   ```

## UI/UX Specification

### Tab Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ CaveChef                                                        │
├─────────────────────────────────────────────────────────────────┤
│  [Grid]  [Map]                                                  │
│  ────────                                                       │
│                                                                 │
│  (Tab content here)                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Map View

```
┌─────────────────────────────────────────────────────────────────┐
│  [Grid]  [Map]                                                  │
│          ────                                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                    ●──●──●                                      │
│                       │     Cave System A                       │
│                    ●──●                                         │
│                                                                 │
│        ●──●──●──●                                               │
│                 │       Cave System B (selected)                │
│              ●──●──●                                            │
│                                                                 │
│                               [+ zoom]  [-]                     │
└─────────────────────────────────────────────────────────────────┘
```

### Selection Highlighting

| State | Style |
|-------|-------|
| Unselected | Gray lines (#888), 2px width |
| Selected | Blue lines (#3b82f6), 3px width |
| Hovered | Cursor pointer, slight opacity change |

### Disabled Map Tab

When no projects have GPS:
```
  [Grid]  [Map]
  ────    ────
          ↳ Grayed out, tooltip: "No projects with GPS coordinates"
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No GPS projects | Disable map tab |
| Projects at same location | Layer by modified date |
| Project spans dateline | Handle coordinate wrapping |
| Very distant projects | Fit bounds to show all |
| Single GPS project | Center on that project |

## Testing

### Manual Tests

1. Open GlobalView with GPS projects
2. Switch between Grid and Map tabs
3. Click project on map, verify selection
4. Verify most recent project renders on top
5. Open GlobalView with no GPS projects, verify map disabled

### Automated Tests

```typescript
describe('GlobalView map', () => {
  it('shows tabs', () => {});
  it('defaults to grid view', () => {});
  it('disables map when no GPS', () => {});
  it('selects project on click', () => {});
  it('layers by modified date', () => {});
});
```

### Integration Tests

```rust
// Backend tests for ProjectMetadata GPS
#[test]
fn test_project_metadata_includes_gps() {
    let project = create_test_project_with_gps();
    let metadata = ProjectMetadata::from_project(&project, path);
    assert!(metadata.gps_latitude.is_some());
}
```

## Dependencies

- Backend change: `ProjectMetadata` GPS extension

## Acceptance Criteria

- [ ] Tab system with Grid and Map views
- [ ] Grid view is default
- [ ] Map renders full project surveys
- [ ] Click any part of project selects whole project
- [ ] Most recent project renders on top
- [ ] Map tab disabled when no GPS projects
- [ ] Text-based tab labels
