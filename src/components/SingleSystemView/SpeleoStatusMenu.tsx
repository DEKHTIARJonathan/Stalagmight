/**
 * The right-click menu on the toolbar's SpeleoDB status button: the hamburger's
 * SpeleoDB submenu (`useSpeleoMenuItems`) rendered as a portaled menu of its own,
 * so the hand-off verbs are one gesture from the indicator that reports the state
 * they change - instead of hamburger -> SpeleoDB -> row.
 *
 * Anchored to the BUTTON, not to the cursor. `useAnchoredFixedMenu` flips, clamps
 * and caps the height against `--toolbar-h`, which is exactly what a menu hanging
 * off a toolbar control needs; a raw cursor-positioned `left/top` (the GlobalView
 * project context menu) would happily open behind the toolbar or off the edge.
 *
 * Rows carry `item.id` as their `data-testid`, the same convention `AppMenu`'s
 * `renderRow` uses, so one selector reaches this surface or the hamburger's.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useAnchoredFixedMenu } from '../../hooks/useAnchoredFixedMenu';
import { useDismissableLayer } from '../../hooks/useDismissableLayer';
import { syntacticLevelAtLeast } from '../../theme/syntacticPalette';
import { MenuRow, MenuSeparator } from '../common/MenuRow';
import { focusableIds, stepId, type AppMenuItem } from '../common/AppMenu';

interface SpeleoStatusMenuProps {
  items: AppMenuItem[];
  /** The status button: the menu's anchor, and where focus returns on Escape. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function SpeleoStatusMenu({ items, triggerRef, onClose }: SpeleoStatusMenuProps) {
  const { t } = useTranslation();
  const syntacticLevel = useUIStore((s) => s.syntacticLevel);
  const showIcons = syntacticLevelAtLeast(syntacticLevel, 'icons');

  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const ids = focusableIds(items);
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);

  // Mounted only while open, so the hook's `open` is constant: the first pass
  // renders hidden at natural size, the layout effect measures it and places it.
  const menuStyle = useAnchoredFixedMenu(true, triggerRef, menuRef, {
    align: 'center',
    gap: 4,
    width: 248,
    maxHeightCap: 320,
  });
  const placed = menuStyle.visibility !== 'hidden';

  const close = useCallback(
    (focusTrigger: boolean) => {
      // Focus BEFORE unmounting: once the portal is gone the row that had focus
      // takes <body> with it, stranding a keyboard user outside the toolbar.
      if (focusTrigger) triggerRef.current?.focus();
      onClose();
    },
    [onClose, triggerRef],
  );

  useDismissableLayer({
    open: true,
    onDismiss: () => close(false),
    contains: [triggerRef, menuRef],
    scrollSafe: [menuRef],
  });

  // Wait for the placement pass: the hidden first render is `visibility: hidden`,
  // and a hidden element cannot take focus - focusing there would silently drop it.
  useEffect(() => {
    if (!placed || !activeId) return;
    itemRefs.current[activeId]?.focus();
  }, [placed, activeId]);

  const activate = (item: AppMenuItem) => {
    if (item.disabled) return;
    // Close first (AppMenu's order): an `onClick` that opens a dialog then moves
    // focus into it, over the trigger focus we just restored.
    close(true);
    item.onClick?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveId((cur) => stepId(ids, cur, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveId((cur) => stepId(ids, cur, -1));
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = items.find((i) => i.id === activeId);
        if (item) activate(item);
        break;
      }
      case 'Escape':
      case 'Tab':
        // Tab would otherwise walk out of the portal while the menu stayed open at
        // a captured rect - close it and hand focus back to the button.
        e.preventDefault();
        close(true);
        break;
    }
  };

  const renderRow = (item: AppMenuItem): ReactNode => {
    if (item.separator) return <MenuSeparator key={item.id} role="separator" />;
    const isActive = activeId === item.id;
    const variantClass = item.disabled
      ? 'text-text-secondary cursor-not-allowed'
      : `hover:bg-accent-10 ${isActive ? 'bg-accent-10' : ''}`;
    return (
      <MenuRow
        key={item.id}
        ref={(el) => {
          itemRefs.current[item.id] = el;
        }}
        type="button"
        role="menuitem"
        tabIndex={isActive ? 0 : -1}
        data-testid={item.id}
        disabled={item.disabled}
        aria-disabled={item.disabled || undefined}
        onClick={() => activate(item)}
        onMouseEnter={() => {
          if (!item.disabled) setActiveId(item.id);
        }}
        label={item.label}
        icon={item.icon}
        showIcons={showIcons}
        iconStyle={item.iconColor ? { color: item.iconColor } : undefined}
        className={variantClass}
      />
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('speleodb.menu.title')}
      data-testid="speleodb-status-menu"
      className="bg-panel border border-border rounded-lg shadow-[0_16px_40px_rgba(0,0,0,0.6)] py-1 overflow-y-auto"
      style={menuStyle}
      onKeyDown={onKeyDown}
    >
      {items.map(renderRow)}
    </div>,
    document.body,
  );
}
