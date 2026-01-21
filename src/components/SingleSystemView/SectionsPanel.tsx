import { useRef, useEffect } from 'react';
import { type Section, type SectionId } from '../../types/project';
import { useUIStore } from '../../store/uiStore';

interface SectionsPanelProps {
  sections: Section[];
}

export default function SectionsPanel({ sections }: SectionsPanelProps) {
  const { selection, setSelection, hoveredSectionId, setHoveredSectionId, openDialog } = useUIStore();

  // Track the last hovered section ID set by this panel (for cleanup on unmount)
  const lastHoveredIdRef = useRef<SectionId | null>(null);

  // Clear hoveredSectionId on unmount if it was set by this panel
  useEffect(() => {
    return () => {
      if (lastHoveredIdRef.current !== null) {
        // Only clear if the store still has the ID we set
        const currentHoveredId = useUIStore.getState().hoveredSectionId;
        if (currentHoveredId === lastHoveredIdRef.current) {
          useUIStore.getState().setHoveredSectionId(null);
        }
      }
    };
  }, []);

  const handleSectionClick = (section: Section, e: React.MouseEvent) => {
    // Only handle left mouse button
    if (e.button !== 0) return;
    setSelection({
      type: 'section',
      sectionId: section.id,
    });
  };

  const handleSectionMouseEnter = (sectionId: SectionId) => {
    lastHoveredIdRef.current = sectionId;
    setHoveredSectionId(sectionId);
  };

  const handleSectionMouseLeave = () => {
    lastHoveredIdRef.current = null;
    setHoveredSectionId(null);
  };

  const handleDeleteMouseDown = (e: React.MouseEvent) => {
    // Stop propagation to prevent row selection
    e.stopPropagation();
  };

  const handleAddSection = () => {
    openDialog('import');
  };

  const handleDeleteSection = (sectionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    openDialog('confirm-delete', {
      type: 'section',
      sectionId,
      message: 'Delete this section and all its shots? This cannot be undone.',
    });
  };

  const handleSectionContextMenu = (e: React.MouseEvent, sectionId: number) => {
    e.preventDefault();
    e.stopPropagation();
    openDialog('context-menu', {
      target: { type: 'section', sectionId },
      position: { x: e.clientX, y: e.clientY },
    });
  };

  return (
    <div className="h-full flex flex-col bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="font-medium">Sections</h2>
        <button
          onClick={handleAddSection}
          className="text-accent hover:text-accent/80 text-lg"
          title="Add section"
        >
          +
        </button>
      </div>

      {/* Section list */}
      <div className="flex-1 overflow-auto">
        {sections.length === 0 ? (
          <div className="p-4 text-center text-text-secondary text-sm">
            No sections yet.
            <br />
            <button
              onClick={handleAddSection}
              className="text-accent hover:underline mt-2 inline-block"
            >
              Add a section
            </button>
          </div>
        ) : (
          <ul className="py-1">
            {sections.map((section) => {
              const isSelected =
                selection?.type === 'section' &&
                selection.sectionId === section.id;
              const stats = calculateSectionStats(section);

              return (
                <li
                  key={section.id}
                  data-testid={`section-row-${section.id}`}
                  className={`px-3 py-2 cursor-pointer group transition-colors ${
                    isSelected || hoveredSectionId === section.id ? 'bg-accent/20' : 'hover:bg-accent/20'
                  }`}
                  onMouseDown={(e) => handleSectionClick(section, e)}
                  onContextMenu={(e) => handleSectionContextMenu(e, section.id)}
                  onMouseEnter={() => handleSectionMouseEnter(section.id)}
                  onMouseLeave={handleSectionMouseLeave}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: section.color }}
                    />
                    <span className="flex-1 truncate">
                      {section.name ?? `Section ${section.id}`}
                    </span>
                    <button
                      onClick={(e) => handleDeleteSection(section.id, e)}
                      onMouseDown={handleDeleteMouseDown}
                      className="text-text-secondary hover:text-error opacity-0 group-hover:opacity-100"
                      title="Delete section"
                    >
                      ×
                    </button>
                  </div>
                  <div className="text-xs text-text-secondary mt-1 ml-5">
                    {stats.shotCount} shots · {stats.length.toFixed(1)}m
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function calculateSectionStats(section: Section) {
  let length = 0;
  let virtualCount = 0;

  for (const shot of section.shots) {
    length += shot.length;
    if (shot.is_virtual) {
      virtualCount++;
    }
  }

  return {
    shotCount: section.shots.length,
    length,
    virtualCount,
  };
}
