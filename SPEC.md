# CaveChef - Cave Survey Processing Application

## Specification Document v1.0

**Last Updated**: 2024-01-12
**Status**: Draft for Implementation
**Target Version**: 1.0 (Pilot Release)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Glossary](#2-glossary)
3. [Data Model](#3-data-model)
4. [Architecture](#4-architecture)
5. [User Interface](#5-user-interface)
6. [Workflows](#6-workflows)
7. [Command System](#7-command-system)
8. [Configuration](#8-configuration)
9. [Logging](#9-logging)
10. [File Formats](#10-file-formats)
11. [Technical Stack](#11-technical-stack)
12. [Future Versions](#12-future-versions)

---

## 1. Overview

### 1.1 Purpose

CaveChef is a desktop application for processing underwater cave survey data. It provides tools to import, visualize, edit, and export cave survey data collected by cave divers using mNemo devices or manual methods.

### 1.2 Target Users

- Experienced cave divers with survey training
- Non-technical users who need intuitive workflows
- Power users who want advanced configuration options

### 1.3 Design Principles

1. **Offline-first**: Must work without internet connection. Privacy-conscious users are suspicious of network access.
2. **Performance**: Smooth rendering of large surveys (500km+ passages, 100,000+ line segments).
3. **Ease of use**: Self-guiding workflows, no tutorial needed for basic operations.
4. **AI-friendly**: Documentation and code structure optimized for AI-assisted development and support.
5. **Config-driven**: All defaults, thresholds, and display options in editable config file.

### 1.4 Scope - Version 1.0

**In Scope:**
- DMP file import from mNemo devices
- Manual data entry via spreadsheet interface
- 2D plan view map with satellite imagery
- Section management (create, edit, delete, merge)
- Virtual shots for temporary survey connections
- Loop closure detection and error distribution
- Multi-project workspace (Global View)
- Export: PNG, SVG, PDF (map images), CSV, JSON (data)
- SQLite project storage
- Undo/redo with persistence

**Out of Scope (Future Versions):**
- SpeleoDB integration (V2 high priority)
- 3D visualization
- Profile views
- Mobile/web versions
- Direct mNemo device communication
- Ariane .ari file import
- Advanced statistics beyond basic metrics

---

## 2. Glossary

| Term | Definition |
|------|------------|
| **Shot** | A single survey measurement between two stations. Contains azimuth, length, depth, and optionally LRUD. |
| **Station** | A point in the cave where a shot measurement is taken. Tied to cave line at physical markers. |
| **Section** | A group of consecutive shots collected during a single survey session. Has metadata (name, surveyor, date). |
| **Virtual Shot** | A temporary shot used to connect sections that aren't physically connected yet. Displayed with dotted line. |
| **Zero Datum** | A station with GPS coordinates assigned. The fixed reference point for the coordinate system. |
| **LRUD** | Left, Right, Up, Down - passage dimension measurements at a station. |
| **Loop Closure** | When two survey paths meet at the same physical point, creating a loop. |
| **Closure Error** | The discrepancy between expected and actual positions when a loop closes. Expressed as percentage. |
| **DMP File** | Binary file format from mNemo device containing survey data. |
| **Cave System** | A complete cave survey project. One cave system per project file. |
| **Global View** | Application view showing all cave systems on a map. |
| **Single System View** | Application view for editing a specific cave system. |

---

## 3. Data Model

### 3.1 Entity Hierarchy

```
Project (Cave System)
├── Metadata
│   ├── name: String
│   ├── location: Option<String>
│   ├── created_at: DateTime
│   └── modified_at: DateTime
├── Sections[]
│   ├── id: u32 (internal, immutable)
│   ├── name: Option<String>
│   ├── surveyor: Option<String>
│   ├── date: Option<Date>
│   ├── color: Color
│   └── Shots[]
│       ├── id: u32 (internal, immutable)
│       ├── azimuth_in: f64 (degrees, 0-360)
│       ├── azimuth_out: f64 (degrees, 0-360)
│       ├── length: f64 (meters)
│       ├── depth_in: f64 (meters)
│       ├── depth_out: f64 (meters)
│       ├── pitch_in: Option<f64> (degrees, -90 to 90)
│       ├── pitch_out: Option<f64> (degrees, -90 to 90)
│       ├── left: Option<f64> (meters)
│       ├── right: Option<f64> (meters)
│       ├── up: Option<f64> (meters)
│       ├── down: Option<f64> (meters)
│       ├── comment: Option<String>
│       ├── is_virtual: bool
│       ├── marker_index: Option<u32>
│       └── temperature: Option<f64> (celsius)
├── Stations[] (computed from shots)
│   ├── id: StationRef (section_id:shot_index)
│   ├── coordinates: Option<Coordinates> (computed or GPS)
│   ├── is_zero_datum: bool
│   └── merged_with: Vec<StationRef>
└── Settings
    ├── display_preferences: DisplaySettings
    └── export_preferences: ExportSettings
```

### 3.2 Station Identification

Stations use a dual-ID system to preserve provenance through merges:

```
StationRef = section_id:station_index

Examples:
- 0:0  → First station of section 0
- 0:15 → 16th station of section 0
- Merged station: [0:15, 1:0] → Station 15 of section 0 merged with station 0 of section 1
```

### 3.3 Coordinate System

- **Internal coordinates**: X (East), Y (North), Z (Depth) in meters
- **Origin**: First zero datum station, or (0,0,0) if no GPS assigned
- **GPS coordinates**: WGS84 (latitude, longitude, depth reference)
- **Azimuth**: Degrees from magnetic north (0-360), support for declination correction
- **Depth**: Positive values = below surface

### 3.4 Computed Values

These are derived from shot data, not stored:

- Station coordinates (from azimuth, length, depth chain)
- Section statistics (total length, depth range, shot count)
- Loop closure errors
- Penetration distance (maximum line distance from zero datum)

---

## 4. Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tauri Application                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              React + TypeScript (Strict Mode)            │   │
│  │                                                          │   │
│  │  ┌──────────────┐  ┌────────────────┐  ┌─────────────┐ │   │
│  │  │ UI Components │  │  Map Component  │  │   Dialogs   │ │   │
│  │  │ (Panels,      │  │  (MapLibre GL   │  │  (Import,   │ │   │
│  │  │  Toolbar)     │  │   + deck.gl)    │  │   Export)   │ │   │
│  │  └──────────────┘  └────────────────┘  └─────────────┘ │   │
│  │           │                │                  │         │   │
│  │           └────────────────┼──────────────────┘         │   │
│  │                            ▼                            │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │           Zustand Store (State Cache)             │  │   │
│  │  │  • Caches backend state for UI                   │  │   │
│  │  │  • Manages transient UI state (drag, hover)      │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                            │                            │   │
│  │                            ▼                            │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │         Command Dispatcher (TypeScript)           │  │   │
│  │  │  • Converts UI actions to typed Commands         │  │   │
│  │  │  • Batches transient operations                  │  │   │
│  │  │  • Handles optimistic updates                    │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ Tauri IPC (invoke)               │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Rust Backend                           │   │
│  │                                                           │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │              Command Executor                        │ │   │
│  │  │  1. Validate command                                │ │   │
│  │  │  2. Execute against state                           │ │   │
│  │  │  3. Generate undo data                              │ │   │
│  │  │  4. Push to undo stack                              │ │   │
│  │  │  5. Log command                                     │ │   │
│  │  │  6. Persist to SQLite                               │ │   │
│  │  │  7. Return result                                   │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  │                            │                              │   │
│  │  ┌─────────────────────────┼─────────────────────────┐   │   │
│  │  │                         ▼                          │   │   │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │   │   │
│  │  │  │    State    │  │  Undo/Redo  │  │   Logger  │ │   │   │
│  │  │  │   Manager   │  │    Stack    │  │ (tracing) │ │   │   │
│  │  │  └─────────────┘  └─────────────┘  └───────────┘ │   │   │
│  │  │         │                                         │   │   │
│  │  │         ▼                                         │   │   │
│  │  │  ┌─────────────────────────────────────────────┐ │   │   │
│  │  │  │              SQLite Database                 │ │   │   │
│  │  │  └─────────────────────────────────────────────┘ │   │   │
│  │  └───────────────────────────────────────────────────┘   │   │
│  │                                                           │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │              File Parsers                            │ │   │
│  │  │  • DMP parser (rewritten from pytool_mnemo_lib)     │ │   │
│  │  │  • Project file I/O                                 │ │   │
│  │  │  • Export generators (PNG, SVG, PDF, CSV, JSON)     │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  │                                                           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 State Management

**Single Source of Truth**: Rust backend holds authoritative state.

**Zustand Store** (TypeScript):
- Caches backend state for efficient UI rendering
- Manages transient state (drag previews, hover states, pan/zoom)
- Invalidated and refreshed after each command execution

**State Flow**:
```
User Action → Command Dispatcher → Tauri IPC → Rust Executor
     ↑                                              │
     │                                              ▼
     └──────────── Zustand Update ←──────── Command Result
```

### 4.3 Transient vs Persistent Operations

| Type | Examples | Logging | Undo | Storage |
|------|----------|---------|------|---------|
| **Transient** | Pan, zoom, hover, drag preview | No | No | Zustand only |
| **Persistent** | Create/edit/delete shots, merge stations | Yes | Yes | SQLite |

---

## 5. User Interface

### 5.1 Application Views

#### 5.1.1 Global View

Shows all cave systems the user has loaded.

```
┌─────────────────────────────────────────────────────────────────┐
│  [Import] [New Project] [Settings]                    CaveChef │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                                                                 │
│                     Map showing all cave systems                │
│                     (positioned by GPS coordinates)             │
│                                                                 │
│                     Click system → metadata in side panel       │
│                     Double-click → open in Single System View   │
│                                                                 │
│                     Multi-select: Shift+click, Ctrl+click       │
│                     Right-click → Merge Systems, Export, etc.   │
│                                                                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Systems: 5 | Total Length: 127.4 km | Status: Ready           │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.1.2 Single System View

Primary view for survey work.

```
┌─────────────────────────────────────────────────────────────────┐
│  [←Back] [Save] [Import] [Export] [Undo] [Redo]  │ Tools │     │
│                                                   │[S][P][Z]... │
├────────────┬────────────────────────────┬───────────────────────┤
│            │                            │                       │
│  Sections  │                            │    Detail Panel       │
│   Panel    │        Map Canvas          │    (collapsible)      │
│            │                            │                       │
│ [+] Main   │   ★ ──●──●──●──●          │  Station: 0:15        │
│ [ ] Side A │        \                   │  Depth: 12.3m         │
│ [ ] Side B │         ●──●──●            │  Section: Main Line   │
│            │                            │                       │
│ (resize)   │                            │  [Edit] [Delete]      │
│ (collapse) │                            │                       │
├────────────┴────────────────────────────┴───────────────────────┤
│  Data Table (collapsible)                                       │
│  Section: [Main Line ▼]                                         │
│  ┌────┬────────┬────────┬───────┬───┬───┬───┬───┬─────────────┐│
│  │ ID │ Length │ Azimuth│ Depth │ L │ R │ U │ D │ Comment     ││
│  ├────┼────────┼────────┼───────┼───┼───┼───┼───┼─────────────┤│
│  │ 1  │ 3.2    │ 45.0   │ 5.1   │...│...│...│...│             ││
│  │ 2  │ 4.1    │ 52.3   │ 6.2   │...│...│...│...│ ⚠          ││
│  └────┴────────┴────────┴───────┴───┴───┴───┴───┴─────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Panel Behavior

| Panel | Default State | Behavior |
|-------|---------------|----------|
| Sections Panel | Open, 250px | Resizable, collapsible |
| Detail Panel | Open, 300px | Resizable, collapsible |
| Data Table | Collapsed | Resizable (height), collapsible |

### 5.3 Tools

| Tool | Shortcut | Click Station | Click Shot | Click Empty | Drag |
|------|----------|---------------|------------|-------------|------|
| **Select** | S | Open detail panel | Open shot details | Deselect | Box select |
| **Pan** | P | Pan | Pan | Pan | Pan map |
| **Zoom** | Z | Zoom in | Zoom in | Zoom in | Zoom area |
| **Draw** | D | Start shot from here | - | - | - |
| **Delete** | X | Delete station (confirm) | Delete shot (confirm) | - | - |
| **Merge** | M | Select for merge | - | - | - |
| **Measure** | R | Start measurement | - | Start measurement | - |
| **Move Section** | V | - | - | - | Drag unanchored section |
| **Move Station** | T | - | - | - | Drag unanchored station |

### 5.4 Map Features

#### Display Toggles (Right-click or menu)
- Stations (dots)
- Section names (labels)
- Shot data (azimuth, length, depth)
- Virtual shots (dotted lines)
- Zero datum (golden star)
- Grid overlay
- Scale bar
- Satellite imagery
- Depth color gradient (configurable palette)
- LRUD passage walls (future)

#### Map Interactions
- Pan: Middle mouse drag, Pan tool, or Space+drag
- Zoom: Scroll wheel, +/- keys, Zoom tool
- Select: Left click
- Multi-select: Shift+click (add), Ctrl+click (toggle), drag box
- Context menu: Right click
- Snap to station: Automatic when within threshold (configurable)

### 5.5 Visual Indicators

| Element | Appearance |
|---------|------------|
| Regular shot | Solid colored line (section color) |
| Virtual shot | Dotted line, semi-transparent |
| Station | Filled circle |
| Selected station | Highlighted ring |
| Zero datum | Golden star icon |
| Validation warning | Red highlight, ⚠ icon |
| Marked as resolved | Light red highlight |
| Loop closure line | Dashed line with error percentage |

### 5.6 Dialogs

#### Import/Create Section Dialog (Unified)

```
┌─ Import Section ─────────────────────────────────────────────────┐
│                                                                  │
│  ┌────────────────────┐  Section Name: [Main Line___________]   │
│  │                    │  Surveyor:     [J. Smith____________]   │
│  │   Section Preview  │  Date:         [2024-01-12__________]   │
│  │   (live rendering) │  Color:        [████ ▼] (auto-selected) │
│  │                    │                                          │
│  │       ●──●──●      │  Direction:    [IN ▼]                   │
│  │          \         │                                          │
│  │           ●──●     │  Statistics:                             │
│  │                    │    Shots: 24                             │
│  └────────────────────┘    Length: 187.3m                        │
│                            Depth: 3.2m - 17.8m                   │
│                                                                  │
│  ┌─ Data Table ─────────────────────────────────────────────────┐│
│  │ ID │ Len  │ Azi  │ Depth │ L   │ R   │ U   │ D   │ Virtual  ││
│  │ 1  │ 3.2  │ 45.0 │ 5.1   │ 1.2 │ 0.8 │ 2.1 │ 1.5 │ [ ]     ││
│  │ 2  │ 4.1  │ 52.3 │ 6.2   │ ... │ ... │ ... │ ... │ [ ]  ⚠  ││
│  │ ...                                                          ││
│  │ [+ Add Row]                                                  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Placement Method:                                               │
│  (○) GPS Coordinates                                            │
│      Latitude:  [________] Longitude: [________]                │
│      Zero Datum Station: [First ▼]                              │
│  (○) From Existing Station                                      │
│      Connect: [Section ▼] Station [# ▼] to [Start/End ▼]       │
│  (●) Manual Placement                                           │
│      Click on map to position section                           │
│                                                                  │
│  [ Cancel ]                                      [ Import ]      │
└──────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Same dialog for Import (DMP file loaded) and Manual Entry (empty table)
- Live preview updates as user edits data
- Color auto-selected from palette to minimize repetition
- Validation warnings shown inline with ⚠ icon
- "Mark as resolved" option for acknowledged warnings

#### Merge Stations Dialog

```
┌─ Merge Stations ─────────────────────────────────────────────────┐
│                                                                  │
│  Station A: Section "Main Line" #15 (depth: 12.3m)              │
│  Station B: Section "Side Passage" #1 (depth: 12.8m)            │
│                                                                  │
│  Distance between: 2.4m                                          │
│  Depth difference: 0.5m                                          │
│                                                                  │
│  ⚠ This creates a loop. Closure error: 3.2%                     │
│                                                                  │
│  How to handle closure error?                                    │
│  (○) Distribute proportionally by shot length                   │
│  (○) Distribute equally across all shots                        │
│  (○) Keep raw data (stations won't align perfectly)             │
│  (○) Adjust manually later                                      │
│                                                                  │
│  [ Cancel ]                                      [ Merge ]       │
└──────────────────────────────────────────────────────────────────┘
```

#### Export Dialog

```
┌─ Export ─────────────────────────────────────────────────────────┐
│                                                                  │
│  Export Type: [Map Image ▼]                                     │
│    • Map Image (PNG, SVG, PDF)                                  │
│    • Survey Data (CSV, JSON)                                    │
│                                                                  │
│  Format: [PNG ▼]                                                │
│                                                                  │
│  Options:                                                        │
│    [✓] Include satellite imagery                                │
│    [ ] Include grid                                             │
│    [✓] Include station labels                                   │
│    [✓] Include section names                                    │
│    [ ] Include shot data (azimuth, length, depth)               │
│                                                                  │
│  Resolution: [High (300 DPI) ▼]                                 │
│                                                                  │
│  [ Cancel ]                                      [ Export ]      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Workflows

### 6.1 First Launch

1. Application opens to Global View (empty)
2. Empty state message: "No cave systems yet"
3. Prominent buttons: [Import DMP] [New Project] [Open Existing]
4. No tutorial - interface should be self-guiding

### 6.2 Creating New Project

1. User clicks [New Project]
2. Dialog: Enter name, optional location description
3. Optional: Enter GPS coordinates (creates zero datum station)
4. Project created, opens in Single System View
5. If GPS provided: Single station with golden star visible
6. User can now import sections or add manually

### 6.3 Importing DMP File

1. User clicks [Import] or drags .dmp file onto application
2. DMP parsed, Import Dialog opens with data populated
3. User reviews/edits:
   - Section metadata (name, surveyor, date, color)
   - Shot data (can edit values, mark virtual)
   - Validation warnings shown, can "mark as resolved"
4. User selects placement method:
   - **GPS**: Enter coordinates, select zero datum station
   - **From Station**: Select existing station to merge with
   - **Manual**: Proceed to map placement
5. User clicks [Import]
6. If Manual: Section outline follows cursor, click to place
7. Section added to project, visible on map
8. Auto-saved

### 6.4 Manual Data Entry

1. User clicks [New Section] or [+] in Sections Panel
2. Import Dialog opens with empty table
3. User enters metadata and shot data row by row
4. Live preview updates as data entered
5. Quick entry mode: Tab advances cells, Enter advances rows
6. Same placement flow as DMP import
7. Auto-saved

### 6.5 Connecting Sections with Virtual Shots

**Scenario**: Two sections exist but aren't connected. User surveyed the gap.

1. User imports/creates new section with the connection survey
2. In data table, user marks connecting shots as Virtual (checkbox)
3. User places section using "From Station" to connect one end
4. User uses Merge Tool to connect other end to second section
5. Loop detected, closure error displayed
6. User selects error distribution method
7. Virtual shots displayed as dotted lines
8. User can toggle virtual shot visibility in display options

### 6.6 Editing Existing Data

**Via Data Table:**
1. User expands Data Table panel
2. Selects section from dropdown
3. Clicks cell, edits value
4. Map updates in real-time
5. Auto-saved

**Via Map:**
1. User clicks station/shot with Select tool
2. Detail Panel shows properties
3. User edits in Detail Panel
4. Map updates in real-time
5. Auto-saved

**Via Right-Click:**
1. Right-click station/shot
2. Context menu → Edit, Delete, Mark Virtual, etc.
3. Dialog or inline edit as appropriate

### 6.7 Deleting Data

**Deleting a Shot:**
1. Select shot, press Delete (or right-click → Delete)
2. Confirmation: "Delete shot? This will split the section."
3. Confirm → Shot deleted, section splits into two with suffixes (A, B)
4. Further splits: C, D, E...

**Deleting a Station:**
1. Select station, press Delete
2. Confirmation: "Delete station? Connected shots will also be deleted."
3. Confirm → Station and connected shots deleted, sections split as needed

**Deleting a Section:**
1. Right-click section in Sections Panel → Delete
2. Confirmation with statistics: "Delete 'Main Line'? (24 shots, 187.3m)"
3. Confirm → Section removed

### 6.8 Merging Cave Systems

1. User is in Global View
2. Multi-select two systems (Shift+click or Ctrl+click)
3. Right-click → "Merge Systems"
4. Dialog:
   - Shows both system names and statistics
   - Enter new merged system name
   - Warning: Original files will be archived
5. Confirm → Systems merged into single file
6. Auto-switch to Single System View
7. User connects the systems using Merge Tool

### 6.9 Moving Unanchored Sections

**Section is unanchored** (not connected to zero datum):
1. Select Move Section tool (V)
2. Click and drag section to new position
3. Release to place
4. Can still move until connected to anchored section/station

**Section becomes anchored** (connected to zero datum through shots):
1. Move Section tool no longer works on this section
2. Individual stations can be moved with Move Station tool (if unanchored)
3. This preserves zero datum integrity

---

## 7. Command System

### 7.1 Command Pattern

All persistent operations go through the Command Executor:

```rust
pub enum Command {
    // Section commands
    CreateSection {
        name: Option<String>,
        surveyor: Option<String>,
        date: Option<NaiveDate>,
        color: Color,
        shots: Vec<ShotData>,
        placement: Placement,
    },
    DeleteSection {
        section_id: SectionId,
    },
    UpdateSectionMetadata {
        section_id: SectionId,
        name: Option<String>,
        surveyor: Option<String>,
        date: Option<NaiveDate>,
        color: Option<Color>,
    },

    // Shot commands
    CreateShot {
        section_id: SectionId,
        shot: ShotData,
        after_shot_id: Option<ShotId>,
    },
    UpdateShot {
        section_id: SectionId,
        shot_id: ShotId,
        updates: ShotUpdates,
    },
    DeleteShot {
        section_id: SectionId,
        shot_id: ShotId,
    },
    SetShotVirtual {
        section_id: SectionId,
        shot_id: ShotId,
        is_virtual: bool,
    },

    // Station commands
    MergeStations {
        station_a: StationRef,
        station_b: StationRef,
        closure_strategy: ClosureStrategy,
    },
    UnmergeStations {
        station_ref: StationRef,
    },
    SetZeroDatum {
        station_ref: StationRef,
        coordinates: GpsCoordinates,
    },
    RemoveZeroDatum {
        station_ref: StationRef,
    },

    // Project commands
    MergeProjects {
        project_paths: Vec<PathBuf>,
        new_name: String,
    },

    // Batch commands
    Batch {
        commands: Vec<Command>,
    },
}
```

### 7.2 Command Execution

```rust
pub struct CommandResult {
    pub success: bool,
    pub state_update: StateUpdate,
    pub undo_data: UndoData,
    pub warnings: Vec<Warning>,
}

pub enum UndoData {
    /// Simple inverse command
    InverseCommand(Command),

    /// State delta for complex operations
    StateDelta {
        affected_entities: Vec<EntitySnapshot>,
    },

    /// Full state snapshot for destructive operations
    Snapshot(ProjectSnapshot),
}

impl CommandExecutor {
    pub fn execute(&mut self, cmd: Command) -> Result<CommandResult> {
        // 1. Validate
        self.validate(&cmd)?;

        // 2. Execute
        let (state_update, undo_data) = self.apply(&cmd)?;

        // 3. Push to undo stack
        self.undo_stack.push(UndoEntry { cmd: cmd.clone(), undo_data: undo_data.clone() });
        self.redo_stack.clear();

        // 4. Log
        info!(command = ?cmd, "Command executed");
        debug!(undo_data = ?undo_data, "Undo data generated");

        // 5. Persist
        self.persist()?;

        Ok(CommandResult { success: true, state_update, undo_data, warnings: vec![] })
    }

    pub fn undo(&mut self) -> Result<CommandResult> {
        let entry = self.undo_stack.pop().ok_or(Error::NothingToUndo)?;
        let result = self.apply_undo(&entry.undo_data)?;
        self.redo_stack.push(entry);
        info!("Undo performed");
        Ok(result)
    }

    pub fn redo(&mut self) -> Result<CommandResult> {
        let entry = self.redo_stack.pop().ok_or(Error::NothingToRedo)?;
        let result = self.apply(&entry.cmd)?;
        self.undo_stack.push(entry);
        info!("Redo performed");
        Ok(result)
    }
}
```

### 7.3 Transient Operations

These do NOT go through Command Executor:

- Pan/zoom map
- Hover highlights
- Drag preview (before release)
- UI panel resize/collapse
- Tooltip display

Managed entirely in Zustand store on frontend.

---

## 8. Configuration

### 8.1 Config File Format

TOML format at `~/.config/cavechef/config.toml` (Linux/Mac) or `%APPDATA%\cavechef\config.toml` (Windows).

```toml
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"  # "meters" | "feet"
depth = "meters"   # "meters" | "feet"
angle = "degrees"  # "degrees" | "gradians"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
station_size = 6
line_thickness = 2
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
# Color palette for auto-assigning section colors
# Cycles through these, avoiding recent colors
palette = [
    "#4ecdc4",  # Teal
    "#ff6b6b",  # Coral
    "#95e1d3",  # Mint
    "#f38181",  # Salmon
    "#aa96da",  # Lavender
    "#fcbad3",  # Pink
    "#a8d8ea",  # Sky blue
    "#ffcb77",  # Peach
]

[map]
satellite_provider = "openstreetmap"  # "openstreetmap" | "mapbox" | "bing"
satellite_enabled = false
snap_threshold_pixels = 10
zoom_default = 15
zoom_min = 1
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0  # Between in and out readings

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"  # "error" | "warn" | "info" | "debug" | "trace"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_section = "V"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"
```

### 8.2 Config Loading Priority

1. Built-in defaults (compiled into binary)
2. System config file (if exists)
3. User config file (if exists)

Later sources override earlier ones.

---

## 9. Logging

### 9.1 Log Levels

| Level | Usage | Example |
|-------|-------|---------|
| **ERROR** | Operation failed, requires attention | "Failed to save project: permission denied" |
| **WARN** | Suspicious but recoverable | "Shot length 0.05m below threshold" |
| **INFO** | Normal operations, audit trail | "Command: CreateSection { name: 'Main' }" |
| **DEBUG** | Detailed execution info | "Generated undo data: StateDelta with 5 entities" |
| **TRACE** | Very verbose, performance debugging | "Rendering 45000 line segments" |

### 9.2 Log File Management

- **Location**: `~/.local/share/cavechef/logs/` (Linux), `~/Library/Application Support/cavechef/logs/` (Mac), `%APPDATA%\cavechef\logs\` (Windows)
- **Naming**: `cavechef_YYYY-MM-DD_HH-MM-SS.log`
- **New file**: Created each application session
- **Rotation**: Delete oldest logs when directory exceeds `max_directory_size_mb` (default 128MB)
- **Level**: Configurable in settings

### 9.3 Log Format

Structured JSON for machine parsing:

```json
{"ts":"2024-01-12T14:32:15.123Z","level":"INFO","target":"cavechef::commands","msg":"Command executed","command":"CreateSection","section_name":"Main Line","shots":24}
{"ts":"2024-01-12T14:32:15.125Z","level":"DEBUG","target":"cavechef::commands","msg":"Undo data generated","type":"InverseCommand","inverse":"DeleteSection"}
{"ts":"2024-01-12T14:32:15.130Z","level":"INFO","target":"cavechef::persistence","msg":"Project saved","path":"/home/user/caves/sistema.cave","size_kb":245}
```

### 9.4 Instrumentation Requirements

**All code must include appropriate logging:**

```rust
use tracing::{info, warn, error, debug, trace, instrument};

#[instrument(skip(state), fields(section_id))]
pub fn create_section(state: &mut State, cmd: CreateSectionCommand) -> Result<Section> {
    info!(name = ?cmd.name, shots = cmd.shots.len(), "Creating section");

    // Validation
    if cmd.shots.is_empty() {
        warn!("Creating section with no shots");
    }

    for (i, shot) in cmd.shots.iter().enumerate() {
        if shot.length < config.validation.warn_shot_length_min {
            warn!(shot_index = i, length = shot.length, "Shot length below threshold");
        }
        trace!(shot_index = i, shot = ?shot, "Processing shot");
    }

    // Execution
    let section = state.add_section(cmd)?;
    debug!(section_id = section.id, "Section added to state");

    // Error handling
    if let Err(e) = state.validate_integrity() {
        error!(error = ?e, "State integrity check failed after section creation");
        return Err(e);
    }

    info!(section_id = section.id, "Section created successfully");
    Ok(section)
}
```

---

## 10. File Formats

### 10.1 Project File (.cave)

SQLite database with the following schema:

```sql
-- Project metadata
CREATE TABLE project (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
);

-- Sections
CREATE TABLE sections (
    id INTEGER PRIMARY KEY,
    name TEXT,
    surveyor TEXT,
    date TEXT,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Shots
CREATE TABLE shots (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES sections(id),
    sequence_order INTEGER NOT NULL,
    azimuth_in REAL NOT NULL,
    azimuth_out REAL NOT NULL,
    length REAL NOT NULL,
    depth_in REAL NOT NULL,
    depth_out REAL NOT NULL,
    pitch_in REAL,
    pitch_out REAL,
    left_distance REAL,
    right_distance REAL,
    up_distance REAL,
    down_distance REAL,
    comment TEXT,
    is_virtual INTEGER NOT NULL DEFAULT 0,
    marker_index INTEGER,
    temperature REAL,
    UNIQUE(section_id, sequence_order)
);

-- Station merges
CREATE TABLE station_merges (
    id INTEGER PRIMARY KEY,
    station_a_section INTEGER NOT NULL,
    station_a_index INTEGER NOT NULL,
    station_b_section INTEGER NOT NULL,
    station_b_index INTEGER NOT NULL,
    merged_at TEXT NOT NULL
);

-- Zero datums
CREATE TABLE zero_datums (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL,
    station_index INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    depth_reference REAL NOT NULL,
    UNIQUE(section_id, station_index)
);

-- Undo/redo stack (persisted)
CREATE TABLE undo_stack (
    id INTEGER PRIMARY KEY,
    sequence INTEGER NOT NULL,
    command_json TEXT NOT NULL,
    undo_data_json TEXT NOT NULL,
    executed_at TEXT NOT NULL
);

-- Display settings (per-project)
CREATE TABLE display_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_shots_section ON shots(section_id);
CREATE INDEX idx_undo_sequence ON undo_stack(sequence);
```

### 10.2 DMP File Import

Rewrite `pytool_mnemo_lib` parser in Rust. Key structures:

```rust
pub struct DmpFile {
    pub version: u8,  // 2-5
    pub sections: Vec<DmpSection>,
}

pub struct DmpSection {
    pub name: [u8; 3],  // 3-char identifier
    pub direction: Direction,  // IN or OUT
    pub date: NaiveDate,
    pub shots: Vec<DmpShot>,
}

pub struct DmpShot {
    pub shot_type: ShotType,  // CSA, CSB, STANDARD, END_OF_SURVEY
    pub heading_in: f64,
    pub heading_out: f64,
    pub length: f64,
    pub depth_in: f64,
    pub depth_out: f64,
    pub pitch_in: f64,
    pub pitch_out: f64,
    pub left: f64,
    pub right: f64,
    pub up: f64,
    pub down: f64,
    pub temperature: f64,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub marker_index: u8,
}
```

### 10.3 Export Formats

**Map Image (PNG/SVG/PDF):**
- Render current map view with selected options
- SVG preserves vector quality
- PDF includes metadata

**Survey Data (CSV):**
```csv
section_id,section_name,shot_id,length,azimuth_in,azimuth_out,depth_in,depth_out,left,right,up,down,is_virtual,comment
0,Main Line,0,3.2,45.0,225.0,5.1,5.8,1.2,0.8,2.1,1.5,false,
0,Main Line,1,4.1,52.3,232.0,5.8,6.2,1.0,1.1,1.8,1.2,false,
```

**Survey Data (JSON):**
```json
{
  "project": {
    "name": "Sistema Norte",
    "exported_at": "2024-01-12T14:32:15Z"
  },
  "sections": [
    {
      "id": 0,
      "name": "Main Line",
      "surveyor": "J. Smith",
      "date": "2024-01-10",
      "shots": [
        {
          "id": 0,
          "length": 3.2,
          "azimuth_in": 45.0,
          "azimuth_out": 225.0,
          "depth_in": 5.1,
          "depth_out": 5.8,
          "lrud": [1.2, 0.8, 2.1, 1.5],
          "is_virtual": false
        }
      ]
    }
  ]
}
```

---

## 11. Technical Stack

### 11.1 Overview

| Layer | Technology |
|-------|------------|
| **Runtime** | Tauri 2.x |
| **Backend** | Rust (stable) |
| **Frontend** | React 18+ with TypeScript (strict mode) |
| **State** | Zustand |
| **Map Rendering** | MapLibre GL JS + deck.gl |
| **Database** | SQLite (via rusqlite) |
| **Logging** | tracing + tracing-subscriber |
| **Build** | pnpm + Vite + Tauri CLI |
| **Testing** | Rust: cargo test, TS: Vitest |

### 11.2 Dependencies

**Rust (Cargo.toml):**
```toml
[dependencies]
tauri = { version = "2", features = ["shell-open"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.31", features = ["bundled"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
tracing-appender = "0.2"
chrono = { version = "0.4", features = ["serde"] }
thiserror = "1"
anyhow = "1"
toml = "0.8"
directories = "5"
```

**TypeScript (package.json):**
```json
{
  "dependencies": {
    "react": "^18",
    "react-dom": "^18",
    "@tauri-apps/api": "^2",
    "zustand": "^4",
    "maplibre-gl": "^4",
    "@deck.gl/core": "^9",
    "@deck.gl/layers": "^9",
    "@deck.gl/mapbox": "^9"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "vite": "^5",
    "@vitejs/plugin-react": "^4",
    "vitest": "^1",
    "@tauri-apps/cli": "^2"
  }
}
```

### 11.3 TypeScript Configuration

**tsconfig.json (strict mode required):**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",

    "strict": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,

    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### 11.4 Project Structure

```
cavechef/
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs               # Tauri entry point
│       ├── lib.rs                # Library root
│       ├── commands/             # Tauri command handlers
│       │   ├── mod.rs
│       │   ├── project.rs
│       │   ├── section.rs
│       │   └── shot.rs
│       ├── core/                 # Business logic
│       │   ├── mod.rs
│       │   ├── command.rs        # Command enum and executor
│       │   ├── state.rs          # State manager
│       │   ├── undo.rs           # Undo/redo stack
│       │   └── validation.rs     # Data validation
│       ├── models/               # Data structures
│       │   ├── mod.rs
│       │   ├── project.rs
│       │   ├── section.rs
│       │   ├── shot.rs
│       │   └── station.rs
│       ├── parsers/              # File format parsers
│       │   ├── mod.rs
│       │   └── dmp.rs            # mNemo DMP parser
│       ├── persistence/          # Database operations
│       │   ├── mod.rs
│       │   └── sqlite.rs
│       ├── export/               # Export generators
│       │   ├── mod.rs
│       │   ├── image.rs
│       │   ├── csv.rs
│       │   └── json.rs
│       ├── config/               # Configuration
│       │   ├── mod.rs
│       │   └── defaults.rs
│       └── logging/              # Logging setup
│           └── mod.rs
│
├── src/                          # TypeScript frontend
│   ├── main.tsx                  # React entry point
│   ├── App.tsx                   # Root component
│   ├── components/               # React components
│   │   ├── GlobalView/
│   │   │   ├── GlobalView.tsx
│   │   │   └── SystemCard.tsx
│   │   ├── SingleSystemView/
│   │   │   ├── SingleSystemView.tsx
│   │   │   ├── Toolbar.tsx
│   │   │   ├── SectionsPanel.tsx
│   │   │   ├── DetailPanel.tsx
│   │   │   └── DataTable.tsx
│   │   ├── Map/
│   │   │   ├── MapCanvas.tsx
│   │   │   ├── SurveyLayer.tsx
│   │   │   └── controls/
│   │   ├── Dialogs/
│   │   │   ├── ImportDialog.tsx
│   │   │   ├── MergeDialog.tsx
│   │   │   └── ExportDialog.tsx
│   │   └── common/
│   │       ├── Button.tsx
│   │       ├── Panel.tsx
│   │       └── Table.tsx
│   ├── store/                    # Zustand stores
│   │   ├── projectStore.ts
│   │   ├── uiStore.ts
│   │   └── configStore.ts
│   ├── commands/                 # Command dispatcher
│   │   ├── dispatcher.ts
│   │   └── types.ts
│   ├── hooks/                    # Custom React hooks
│   │   ├── useProject.ts
│   │   ├── useMap.ts
│   │   └── useKeyboardShortcuts.ts
│   ├── utils/                    # Utility functions
│   │   ├── coordinates.ts
│   │   └── colors.ts
│   └── types/                    # TypeScript types
│       ├── project.ts
│       ├── commands.ts
│       └── api.ts
│
├── tests/                        # Test files
│   ├── rust/                     # Rust unit/integration tests
│   └── ts/                       # TypeScript tests
│
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
├── SPEC.md                       # This document
└── README.md
```

---

## 12. Future Versions

### 12.1 Version 2.0 (High Priority)

- **SpeleoDB Integration**: Push/pull survey data, authentication
- **Loop Closure Algorithms**: Least squares adjustment, more distribution options
- **Profile Views**: Side elevation visualization
- **Advanced Statistics**: Survey efficiency, quality scores, progress over time

### 12.2 Version 2.x (Medium Priority)

- **Ariane .ari Import**: Migration path for existing users
- **Additional Export Formats**: Survex, Therion, KML/KMZ
- **3D Visualization**: Basic 3D cave model
- **LRUD Passage Walls**: Render passage cross-sections on 2D map

### 12.3 Version 3.0+ (Future)

- **Web Version**: Same frontend, different backend
- **Mobile Version**: Flutter or React Native
- **Direct mNemo Communication**: USB/Bluetooth device connection
- **OCR for Dive Slates**: Photo import with text recognition
- **Collaborative Editing**: Real-time multi-user (via SpeleoDB)
- **Floating/Dockable Panels**: Customizable UI layout

---

## Appendix A: Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Select Tool | S |
| Pan Tool | P |
| Zoom Tool | Z |
| Draw Tool | D |
| Delete Tool | X |
| Merge Tool | M |
| Measure Tool | R |
| Move Section Tool | V |
| Move Station Tool | T |
| Undo | Ctrl+Z |
| Redo | Ctrl+Y / Ctrl+Shift+Z |
| Save | Ctrl+S |
| Import | Ctrl+I |
| Export | Ctrl+E |
| Delete Selected | Delete / Backspace |
| Select All | Ctrl+A |
| Deselect | Escape |
| Zoom In | + / = |
| Zoom Out | - |
| Fit to View | Ctrl+0 |
| Toggle Sections Panel | Ctrl+1 |
| Toggle Detail Panel | Ctrl+2 |
| Toggle Data Table | Ctrl+3 |

---

## Appendix B: Validation Rules

| Rule | Severity | Message |
|------|----------|---------|
| Shot length < 0.1m | Warning | "Shot length {length}m below minimum threshold" |
| Shot length > 50m | Warning | "Shot length {length}m above maximum threshold" |
| Depth change > 10m per shot | Warning | "Depth change {change}m exceeds threshold" |
| Azimuth deviation > 30° | Warning | "Azimuth in/out deviation {dev}° exceeds threshold" |
| Zero length shot | Error | "Shot length cannot be zero" |
| Negative values | Error | "Length and LRUD values must be positive" |
| Invalid azimuth | Error | "Azimuth must be between 0 and 360 degrees" |
| Duplicate station merge | Error | "Station is already merged with target" |

---

## Appendix C: Color Palette (Default)

```
Section Colors (auto-assigned):
#4ecdc4 - Teal
#ff6b6b - Coral
#95e1d3 - Mint
#f38181 - Salmon
#aa96da - Lavender
#fcbad3 - Pink
#a8d8ea - Sky Blue
#ffcb77 - Peach

UI Colors:
Background: #1a1a2e
Panel Background: #16213e
Border: #0f3460
Text Primary: #f5f5f5
Text Secondary: #a0a0a0
Accent: #4ecdc4
Warning: #ffcb77
Error: #ff6b6b
Success: #95e1d3

Map Colors:
Grid: #333366
Zero Datum Star: #ffd700 (Gold)
Virtual Shot: #ffffff40 (White, 25% opacity)
Selection Highlight: #4ecdc4
Loop Closure Line: #ffcb77 (dashed)
```

---

*End of Specification Document*
