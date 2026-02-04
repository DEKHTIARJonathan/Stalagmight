# UI Component Inventory

This inventory lists reusable UI components, their purpose, and where they live.

## Common Primitives (`src/components/common`)
- `Button` (`Button.tsx`) - Primary button component with variants (`primary`, `secondary`, `ghost`, `danger`) and optional leading icon.
- `IconButton` (`Button.tsx`) - Icon-only button for dense toolbars and inline actions; supports `size` and `tooltip`.
- `Panel` (`Panel.tsx`) - Bordered container with optional collapsible header and header actions.
- `ResizablePanel` (`Panel.tsx`) - Wrapper that adds a resize handle for sidebars or split panes.
- `Table` (`Table.tsx`) - Read-only table with optional row selection.
- `EditableTable` (`Table.tsx`) - Inline-editable table with row hover/selection and keyboard navigation.
- `Select` (`Select.tsx`) - Custom select input with portal rendering.
- `Toggle` (`Toggle.tsx`) - On/off switch UI.
- `DatePicker` (`DatePicker.tsx`) - Date input wrapper around the themed picker.
- `ContextMenu` (`ContextMenu.tsx`) - Right-click context menu component.
- `DetailLink` (`DetailLink.tsx`) - Inline link style used in detail panels.
- `SectionMetadataForm` (`SectionMetadataForm.tsx`) - Form fields for section metadata editing.
- `ShotTableEditor` (`ShotTableEditor.tsx`) - Editing grid for shot data (validation + warnings).
- `OfflineIndicator` (`OfflineIndicator.tsx`) - Connectivity status badge.
- `Icons` (`icons.tsx`) - SVG icon set used across the app.

## Dialog Foundations (`src/components/Dialogs`)
- `DialogWrapper` (`DialogWrapper.tsx`) - Base dialog container (focus trap, overlay, sizing).
- `AlertDialog` (`AlertDialog.tsx`) - Confirmation/alert modal built on `DialogWrapper`.

## View-Level Components
- `GlobalView` (`src/components/GlobalView/GlobalView.tsx`) - Landing view for recent systems and map/list tabs.
- `SingleSystemView` (`src/components/SingleSystemView/SingleSystemView.tsx`) - Main editing workspace view.
- `MetadataPanel` (`src/components/GlobalView/MetadataPanel.tsx`) - Project metadata sidebar.
- `Toolbar` (`src/components/SingleSystemView/Toolbar.tsx`) - Main tool + action header.
- `DisplayMenu` (`src/components/SingleSystemView/DisplayMenu.tsx`) - Map display toggles menu.
- `DataTable` (`src/components/SingleSystemView/DataTable.tsx`) - Shot data table with selection sync.

## Notes
- Prefer common primitives over ad-hoc markup to keep states and spacing consistent.
- Use SVG icons from `src/components/common/icons.tsx` instead of emoji or text glyphs.
