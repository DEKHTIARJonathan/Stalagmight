Enhanced SectionPreview component with pan, zoom, and click-to-select functionality:

- Added new props: `onStationClick`, `selectedStationIndex`, `size`
- Set zoom limits (0.25x to 4x via MapLibre minZoom/maxZoom)
- Pan via mouse drag (already supported by MapLibre interactive mode)
- Click on station dots triggers `onStationClick` callback with station index
- Selected station shows white highlight ring (8px radius, 3px stroke)
- Cursor changes to pointer on station hover
- Size prop controls preview dimensions (default 250px)
- No visible pan/zoom controls (mouse-only interaction)
