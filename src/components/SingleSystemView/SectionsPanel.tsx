import { useRef, useEffect, useState, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { type Section, type SectionId } from '../../types/project';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { SHOT_FLAG_IS_REFERENCE } from '../../types/survey-data';
import { useShallow } from 'zustand/react/shallow';
import { formatFixed, formatNumber } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { IconButton } from '../common/Button';
import { ExternalLinkIcon, PlusIcon } from '../common/icons';
import { setSource } from '../../utils/telemetry';
import { useLongPress } from '../../hooks';
import { DATA_TABLE_MIN_HEIGHT, DATA_TABLE_MAX_HEIGHT } from './layoutConstants';

interface SectionsPanelProps {
  sections: Section[];
}

// Focus-mode data-table height as a fraction of the viewport, clamped to the
// data-table panel's shared [min, max] bounds. The post-collapse map re-fit
// lives in SingleSystemView (which stays mounted across focus toggles, unlike
// this panel which collapses away in focus mode).
const SECTION_FOCUS_TABLE_FRACTION = 0.3;

export default function SectionsPanel({ sections }: SectionsPanelProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const { selection, setSelection, clearSelection, hoveredSectionId, hoveredShot, hoveredStation, setHoveredSectionId, openDialog, enterSectionFocus, triggerZoomToSection } = useUIStore(
    useShallow((s) => ({
      selection: s.selection,
      setSelection: s.setSelection,
      clearSelection: s.clearSelection,
      hoveredSectionId: s.hoveredSectionId,
      hoveredShot: s.hoveredShot,
      hoveredStation: s.hoveredStation,
      setHoveredSectionId: s.setHoveredSectionId,
      openDialog: s.openDialog,
      enterSectionFocus: s.enterSectionFocus,
      triggerZoomToSection: s.triggerZoomToSection,
    }))
  );

  // The closure-adjusted view is read-only — section add/delete are disabled there.
  const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');

  // The row to highlight comes from any of: an explicit section hover (panel row /
  // DetailPanel section link), or — for map hovers — the section that owns the
  // currently hovered shot or station. Deriving in the panel keeps the map-driven
  // highlight out of `hoveredSectionId`, which is also consumed by the map's
  // section-wide highlighter.
  const effectiveHoveredSectionId: SectionId | null =
    hoveredSectionId ?? hoveredShot?.sectionId ?? hoveredStation?.section_id ?? null;

  // The section that owns the current selection — a directly selected section, or
  // the section of a selected shot/station (selected from the map, data table, or
  // details panel). The matching row is highlighted and scrolled into view so the
  // Sections panel always reflects what's selected elsewhere. Same mapping used by
  // SingleSystemView / the data table.
  const selectedSectionId: SectionId | null =
    selection?.type === 'section' || selection?.type === 'shot'
      ? selection.sectionId ?? null
      : selection?.type === 'station'
        ? selection.stationRef?.section_id ?? null
        : null;

  // Track the last hovered section ID set by this panel (for cleanup on unmount)
  const lastHoveredIdRef = useRef<SectionId | null>(null);

  // Scroll container for the section list, plus the scroll position captured
  // before an *external* hover (map / data table / details panel) auto-scrolled
  // the hovered row into view. Restored once nothing is hovered again so the
  // panel doesn't drift while the user skims other surfaces. `null` means there
  // is no external-hover scroll to undo.
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const preHoverScrollTopRef = useRef<number | null>(null);

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

  // Scroll the hovered section's row into view when it's off-screen.
  // block: 'nearest' is a no-op when the row is already visible, so this
  // is silent for panel-internal hovers and only acts on external (map) hovers.
  //
  // For external hovers (map / data table / details panel — the panel itself did
  // not set the hover, so `lastHoveredIdRef` is null) we remember the scroll
  // position before the first auto-scroll and restore it once nothing is hovered
  // anywhere, so skimming other surfaces doesn't permanently move the list.
  useEffect(() => {
    const container = listContainerRef.current;
    if (effectiveHoveredSectionId === null) {
      // Nothing hovered anywhere — undo any external-hover auto-scroll.
      if (preHoverScrollTopRef.current !== null && container) {
        container.scrollTop = preHoverScrollTopRef.current;
      }
      preHoverScrollTopRef.current = null;
      return;
    }
    const idx = sections.findIndex((s) => s.id === effectiveHoveredSectionId);
    if (idx < 0) return;
    // Panel-internal row hovers (lastHoveredIdRef set) are the user already
    // interacting with the list — don't capture/restore for those.
    const isExternalHover = lastHoveredIdRef.current === null;
    if (isExternalHover && preHoverScrollTopRef.current === null && container) {
      preHoverScrollTopRef.current = container.scrollTop;
    }
    optionRefs.current[idx]?.scrollIntoView({ block: 'nearest' });
  }, [effectiveHoveredSectionId, sections]);

  // Scroll the selected section's row into view when the selection changes (a
  // shot/station/section selected from the map, data table, or details panel).
  // Unlike the hover scroll, this is a persistent reveal — there's nothing to
  // restore — so it's kept separate from the hover save/restore bookkeeping.
  const prevSelectedSectionIdRef = useRef<SectionId | null>(null);
  useEffect(() => {
    const selectionChanged = prevSelectedSectionIdRef.current !== selectedSectionId;
    prevSelectedSectionIdRef.current = selectedSectionId;
    if (selectedSectionId === null) return;
    const idx = sections.findIndex((s) => s.id === selectedSectionId);
    if (idx < 0) return;
    optionRefs.current[idx]?.scrollIntoView({ block: 'nearest' });
    // A *new* selection becomes the panel's anchor. If it was made during an
    // active external hover (e.g. hover a shot on the map, then click to select
    // it), drop the pre-hover restore so un-hovering lands on the selection
    // rather than snapping back to where the list was before the hover.
    if (selectionChanged) {
      preHoverScrollTopRef.current = null;
    }
  }, [selectedSectionId, sections]);

  const handleSectionClick = useCallback((section: Section, e?: React.MouseEvent) => {
    // Only handle left mouse button for mouse events
    if (e && e.button !== 0) return;
    setSource('sections-panel');
    // Single click only selects — it must NOT move the map (reverts #64's
    // single-click-centers behaviour). Double-click enters focus mode, which is
    // what frames the section — see handleSectionDoubleClick.
    setSelection({
      type: 'section',
      sectionId: section.id,
    });
  }, [setSelection]);

  // Shared focus-entry: select the section and drop into focus mode. Used by
  // double-click and keyboard Enter so focus is reachable without a mouse.
  const enterFocusFor = useCallback((section: Section) => {
    const focusHeight = Math.round(
      Math.min(
        Math.max(window.innerHeight * SECTION_FOCUS_TABLE_FRACTION, DATA_TABLE_MIN_HEIGHT),
        DATA_TABLE_MAX_HEIGHT,
      ),
    );
    enterSectionFocus(section.id, focusHeight);
  }, [enterSectionFocus]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, currentIndex: number) => {
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
        // Enter = activate (keyboard equivalent of double-click): select + zoom
        // to the section. Focus mode is reserved for the dedicated focus button.
        e.preventDefault();
        e.stopPropagation();
        if (sections[currentIndex]) {
          handleSectionClick(sections[currentIndex]);
          triggerZoomToSection(sections[currentIndex].id);
        }
        break;
      case ' ':
        // Space = select only (the keyboard equivalent of single-click).
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
  }, [sections, handleSectionClick, triggerZoomToSection, clearSelection]);

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

  const handleSectionMouseEnter = useCallback((sectionId: SectionId) => {
    lastHoveredIdRef.current = sectionId;
    setHoveredSectionId(sectionId);
  }, [setHoveredSectionId]);

  const handleSectionMouseLeave = useCallback(() => {
    // Always clear hover on mouse leave - the mouse is no longer over the element
    // Keyboard focus is handled separately via the onFocus handler
    lastHoveredIdRef.current = null;
    setHoveredSectionId(null);
  }, [setHoveredSectionId]);

  const handleFocusButtonMouseDown = useCallback((e: React.MouseEvent) => {
    // Stop propagation so the row's own mouse-down handling doesn't double-fire.
    e.stopPropagation();
  }, []);

  const handleSectionDoubleClick = useCallback((section: Section, e: React.MouseEvent) => {
    // Only handle left mouse button
    if (e.button !== 0) return;
    // Don't trigger if double-clicking nested controls (like the focus button)
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('button')) return;
    // Select, then zoom/frame the section on the map — without entering focus
    // mode (that's what the dedicated per-row focus button is for).
    handleSectionClick(section, e);
    triggerZoomToSection(section.id);
  }, [handleSectionClick, triggerZoomToSection]);

  const handleFocusButtonDoubleClick = useCallback((e: React.MouseEvent) => {
    // The button enters focus on a single click; swallow the double-click so the
    // row's double-click handler doesn't run a second entry.
    e.stopPropagation();
  }, []);

  // Dedicated focus-mode entry button (replaces the old per-row delete control;
  // section deletion now lives in the right-click / long-press context menu).
  // Single click selects the section and enters focus mode — the same outcome as
  // double-clicking the row, but discoverable as an explicit affordance.
  const handleEnterFocusClick = useCallback((section: Section, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    handleSectionClick(section);
    enterFocusFor(section);
  }, [handleSectionClick, enterFocusFor]);

  const handleSectionFocus = useCallback((sectionId: SectionId, index: number) => {
    setFocusedIndex(index);
    lastHoveredIdRef.current = sectionId;
    setHoveredSectionId(sectionId);
  }, [setHoveredSectionId]);

  const handleAddSection = () => {
    if (geometryReadOnly) return;
    setSource('sections-panel');
    openDialog('import');
  };

  const openSectionContextMenu = useCallback((sectionId: number, x: number, y: number) => {
    setSource('sections-panel');
    openDialog('context-menu', {
      target: { type: 'section', sectionId },
      position: { x, y },
    });
  }, [openDialog]);

  const handleSectionContextMenu = useCallback((e: React.MouseEvent, sectionId: number) => {
    e.preventDefault();
    e.stopPropagation();
    openSectionContextMenu(sectionId, e.clientX, e.clientY);
  }, [openSectionContextMenu]);

  return (
    <div className="h-full flex flex-col bg-panel" data-testid="sections-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="font-medium">{t('sections.title')}</h2>
        <IconButton
          onClick={handleAddSection}
          icon={<PlusIcon size={14} />}
          size="sm"
          variant="ghost"
          tooltip={t('sections.actions.add')}
          aria-label={t('sections.actions.add')}
          data-testid="sections-add-button"
          disabled={geometryReadOnly}
        />
      </div>

      {/* Section list */}
      <div ref={listContainerRef} className="flex-1 overflow-auto" data-testid="sections-list">
        {sections.length === 0 ? (
          <div className="p-4 text-center text-text-secondary text-sm">
            {t('sections.empty.message')}
            <br />
            <button
              onClick={handleAddSection}
              disabled={geometryReadOnly}
              className="text-accent hover:underline mt-2 inline-block disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
              data-testid="sections-empty-add"
            >
              {t('sections.empty.action')}
            </button>
          </div>
        ) : (
          <ul
            role="listbox"
            aria-label={t('sections.ariaList')}
            className="py-1"
            onBlur={handleContainerBlur}
          >
            {sections.map((section, index) => (
              <SectionRow
                key={section.id}
                section={section}
                index={index}
                isSelected={selectedSectionId === section.id}
                isHovered={effectiveHoveredSectionId === section.id}
                isFocused={focusedIndex === index}
                isDefaultFocus={focusedIndex === -1 && index === 0}
                precision={precision.length}
                onMouseDown={handleSectionClick}
                onDoubleClick={handleSectionDoubleClick}
                onContextMenu={handleSectionContextMenu}
                onMouseEnter={handleSectionMouseEnter}
                onMouseLeave={handleSectionMouseLeave}
                onFocus={handleSectionFocus}
                onKeyDown={handleKeyDown}
                onEnterFocus={handleEnterFocusClick}
                onEnterFocusMouseDown={handleFocusButtonMouseDown}
                onEnterFocusDoubleClick={handleFocusButtonDoubleClick}
                onLongPress={openSectionContextMenu}
                optionRefs={optionRefs}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Compute total length + reference-shot count for the section row.
 * Called once per visible section row by `SectionRow`. With 14k sections
 * this used to iterate `section.shots` 14k times — triggering the lazy
 * Shot materialization for every section on first render, defeating the
 * Phase-A.5 memory optimization.
 *
 * Reads from `surveyData.shotLength` / `shotFlags` typed arrays directly
 * when available (the common path post Phase A.5). Falls back to the
 * legacy `section.shots` walk on the unusual path where surveyData
 * isn't populated yet (e.g. legacy JSON refresh in-flight).
 */
function calculateSectionStats(section: Section): {
  shotCount: number;
  length: number;
  referenceCount: number;
} {
  const surveyData = useProjectStore.getState().surveyData;
  if (surveyData) {
    const meta = surveyData.sections.find((s) => s.id === section.id);
    if (meta) {
      let length = 0;
      let referenceCount = 0;
      const end = meta.shotOffset + meta.shotCount;
      for (let g = meta.shotOffset; g < end; g++) {
        length += surveyData.shotLength[g]!;
        if ((surveyData.shotFlags[g]! & SHOT_FLAG_IS_REFERENCE) !== 0) {
          referenceCount++;
        }
      }
      return { shotCount: meta.shotCount, length, referenceCount };
    }
  }
  // Legacy fallback — only hit during the JSON refresh window where
  // `surveyData` may briefly be a stale legacy-converted copy. Same
  // behavior as before, just kept for safety.
  let length = 0;
  let referenceCount = 0;
  for (const shot of section.shots) {
    length += shot.length;
    if (shot.is_reference) referenceCount++;
  }
  return {
    shotCount: section.shots.length,
    length,
    referenceCount,
  };
}

interface SectionRowProps {
  section: Section;
  index: number;
  isSelected: boolean;
  isHovered: boolean;
  isFocused: boolean;
  isDefaultFocus: boolean;
  precision: number;
  onMouseDown: (section: Section, e?: React.MouseEvent) => void;
  onDoubleClick: (section: Section, e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, sectionId: number) => void;
  onMouseEnter: (sectionId: SectionId) => void;
  onMouseLeave: () => void;
  onFocus: (sectionId: SectionId, index: number) => void;
  onKeyDown: (e: React.KeyboardEvent, index: number) => void;
  onEnterFocus: (section: Section, e: React.MouseEvent) => void;
  onEnterFocusMouseDown: (e: React.MouseEvent) => void;
  onEnterFocusDoubleClick: (e: React.MouseEvent) => void;
  onLongPress: (sectionId: number, x: number, y: number) => void;
  optionRefs: React.MutableRefObject<(HTMLLIElement | null)[]>;
}

const SectionRow = memo(function SectionRow({
  section,
  index,
  isSelected,
  isHovered,
  isFocused,
  isDefaultFocus,
  precision,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onKeyDown,
  onEnterFocus,
  onEnterFocusMouseDown,
  onEnterFocusDoubleClick,
  onLongPress,
  optionRefs,
}: SectionRowProps) {
  const { t } = useTranslation();
  const stats = calculateSectionStats(section);

  const handleLongPress = useCallback(
    (pos: { x: number; y: number }) => {
      onLongPress(section.id, pos.x, pos.y);
    },
    [onLongPress, section.id],
  );

  const longPressHandlers = useLongPress(handleLongPress);

  const refCallback = useCallback((el: HTMLLIElement | null) => {
    optionRefs.current[index] = el;
  }, [optionRefs, index]);

  return (
    <li
      ref={refCallback}
      role="option"
      aria-selected={isSelected}
      tabIndex={isFocused ? 0 : (isDefaultFocus ? 0 : -1)}
      data-testid={`section-row-${section.id}`}
      title={t('sections.actions.zoom')}
      className={`px-3 py-2 border-l-2 border-transparent cursor-pointer group transition-colors outline-none focus:ring-2 focus:ring-accent focus:ring-inset ${
        isSelected
          ? 'bg-accent-20 ring-2 ring-accent ring-inset'
          : (isHovered ? 'bg-accent-10 border-accent' : 'hover:bg-accent-10')
      }`}
      onMouseDown={(e) => onMouseDown(section, e)}
      onDoubleClick={(e) => onDoubleClick(section, e)}
      onContextMenu={(e) => onContextMenu(e, section.id)}
      {...longPressHandlers}
      onMouseEnter={() => onMouseEnter(section.id)}
      onMouseLeave={onMouseLeave}
      onFocus={() => onFocus(section.id, index)}
      onKeyDown={(e) => onKeyDown(e, index)}
    >
      <div
        className="flex items-center gap-2"
        data-testid={`section-item-${section.id}`}
      >
        <span
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: section.color }}
        />
        <span className="flex-1 truncate">
          {section.name ?? t('sections.defaultName', { id: section.id })}
        </span>
        <IconButton
          onClick={(e) => onEnterFocus(section, e)}
          onMouseDown={onEnterFocusMouseDown}
          onDoubleClick={onEnterFocusDoubleClick}
          icon={<ExternalLinkIcon size={12} />}
          size="sm"
          variant="ghost"
          tooltip={t('sections.actions.focus')}
          aria-label={t('sections.actions.focus')}
          className="opacity-0 group-hover:opacity-100 text-text-secondary hover:text-accent"
          tabIndex={-1}
          data-testid={`section-focus-${section.id}`}
        />
      </div>
      <div className="text-xs text-text-secondary mt-1 ml-5">
        {t('sections.stats', {
          shots: formatNumber(stats.shotCount),
          length: `${formatFixed(stats.length, undefined, precision)}${t('common.units.meters')}`,
        })}
      </div>
    </li>
  );
});
