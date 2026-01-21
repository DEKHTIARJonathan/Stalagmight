import { useRef, useEffect, useState } from 'react';
import { type Section, type SectionId } from '../../types/project';
import { useUIStore } from '../../store/uiStore';

interface SectionsPanelProps {
  sections: Section[];
}

export default function SectionsPanel({ sections }: SectionsPanelProps) {
  const { selection, setSelection, clearSelection, hoveredSectionId, setHoveredSectionId, openDialog, triggerZoomToSection } = useUIStore();

  // Track the last hovered section ID set by this panel (for cleanup on unmount)
  const lastHoveredIdRef = useRef<SectionId | null>(null);

  // Keyboard accessibility: track focused index and refs for roving tabindex
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

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

  const handleSectionClick = (section: Section, e?: React.MouseEvent) => {
    // Only handle left mouse button for mouse events
    if (e && e.button !== 0) return;
    setSelection({
      type: 'section',
      sectionId: section.id,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
    // Only handle keyboard events when the list item itself is focused,
    // not when focus is on nested controls (like the delete button)
    if (e.target !== e.currentTarget) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (currentIndex < sections.length - 1) {
          const nextIndex = currentIndex + 1;
          setFocusedIndex(nextIndex);
          optionRefs.current[nextIndex]?.focus();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (currentIndex > 0) {
          const prevIndex = currentIndex - 1;
          setFocusedIndex(prevIndex);
          optionRefs.current[prevIndex]?.focus();
        }
        break;
      case 'Home':
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex(0);
        optionRefs.current[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex(sections.length - 1);
        optionRefs.current[sections.length - 1]?.focus();
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (sections[currentIndex]) {
          handleSectionClick(sections[currentIndex]);
        }
        break;
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        if (sections[currentIndex]) {
          handleSectionClick(sections[currentIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
        break;
    }
  };

  const handleContainerBlur = (e: React.FocusEvent<HTMLUListElement>) => {
    // CRITICAL: Only clear when focus leaves the listbox ENTIRELY
    // Using relatedTarget to check if new focus target is within container
    const next = e.relatedTarget;
    if (!next || !(next instanceof Node) || !e.currentTarget.contains(next)) {
      setFocusedIndex(-1);
      lastHoveredIdRef.current = null;
      setHoveredSectionId(null);
    }
  };

  const handleSectionMouseEnter = (sectionId: SectionId) => {
    lastHoveredIdRef.current = sectionId;
    setHoveredSectionId(sectionId);
  };

  const handleSectionMouseLeave = () => {
    // Only clear hover on mouse leave if no row has keyboard focus
    // This preserves the "focus highlights map" behavior
    if (focusedIndex === -1) {
      lastHoveredIdRef.current = null;
      setHoveredSectionId(null);
    }
  };

  const handleDeleteMouseDown = (e: React.MouseEvent) => {
    // Stop propagation to prevent row selection
    e.stopPropagation();
  };

  const handleSectionDoubleClick = (section: Section, e: React.MouseEvent) => {
    // Only handle left mouse button
    if (e.button !== 0) return;
    // Don't trigger if double-clicking nested controls (like delete button)
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('button')) return;
    // Ensure selection happens (in case mouseDown was prevented)
    handleSectionClick(section, e);
    // Trigger zoom to section
    triggerZoomToSection(section.id);
  };

  const handleDeleteDoubleClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent row zoom
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
          <ul
            role="listbox"
            aria-label="Cave survey sections"
            className="py-1"
            onBlur={handleContainerBlur}
          >
            {sections.map((section, index) => {
              const isSelected =
                selection?.type === 'section' &&
                selection.sectionId === section.id;
              const stats = calculateSectionStats(section);

              return (
                <li
                  key={section.id}
                  ref={(el) => { optionRefs.current[index] = el; }}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={focusedIndex === index ? 0 : (focusedIndex === -1 && index === 0 ? 0 : -1)}
                  data-testid={`section-row-${section.id}`}
                  className={`px-3 py-2 cursor-pointer group transition-colors outline-none focus:ring-2 focus:ring-accent focus:ring-inset ${
                    isSelected || hoveredSectionId === section.id ? 'bg-accent/20' : 'hover:bg-accent/20'
                  }`}
                  onMouseDown={(e) => handleSectionClick(section, e)}
                  onDoubleClick={(e) => handleSectionDoubleClick(section, e)}
                  onContextMenu={(e) => handleSectionContextMenu(e, section.id)}
                  onMouseEnter={() => handleSectionMouseEnter(section.id)}
                  onMouseLeave={handleSectionMouseLeave}
                  onFocus={() => {
                    setFocusedIndex(index);
                    lastHoveredIdRef.current = section.id;
                    setHoveredSectionId(section.id);
                  }}
                  onKeyDown={(e) => handleKeyDown(e, index)}
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
                      onDoubleClick={handleDeleteDoubleClick}
                      tabIndex={-1}
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
