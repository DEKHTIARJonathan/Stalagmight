/**
 * MenuRow / MenuSeparator - the row body shared by AppMenu and ContextMenu.
 *
 * Both menus render visually-identical rows: the same button base classes
 * ('w-full px-3 py-2 text-left text-sm flex items-center gap-2'), the same
 * icon gating (an 18px wrapper span rendered only at syntactic level >=
 * 'icons'), and the same 'border-t border-border my-1' separator. This module
 * owns exactly those identical parts; each menu keeps its own concerns
 * (portal/positioning/keyboard nav in AppMenu; overlay/positioning in
 * ContextMenu) by passing variant classes, trailing content, and any extra
 * button attributes in.
 */
import { forwardRef, type ReactNode, type ButtonHTMLAttributes, type CSSProperties } from 'react';

/** The button base classes shared by every menu row. */
export const MENU_ROW_BASE_CLASS =
  'w-full px-3 py-2 text-left text-sm flex items-center gap-2';

interface MenuRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Row label (rendered in the flex-1 truncating text span). */
  label: string;
  /** Leading icon, rendered only when `showIcons` is true. */
  icon?: ReactNode;
  /** Whether to render the leading icon wrapper (syntactic level >= 'icons'). */
  showIcons: boolean;
  /** Inline style for the icon wrapper (e.g. a fixed icon tint). */
  iconStyle?: CSSProperties | undefined;
  /** Variant / state classes appended after the shared base classes. */
  className?: string;
  /** Trailing content rendered after the label (chevron, check, shortcut…). */
  children?: ReactNode;
}

/**
 * A menu row button: shared base classes + icon-gated 18px wrapper + truncating
 * label + an optional trailing slot. All other button attributes (ref, role,
 * onClick, disabled, data-testid, aria-*, onMouseEnter, …) pass straight through.
 */
export const MenuRow = forwardRef<HTMLButtonElement, MenuRowProps>(function MenuRow(
  { label, icon, showIcons, iconStyle, className, children, ...buttonProps },
  ref,
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      className={`${MENU_ROW_BASE_CLASS}${className ? ` ${className}` : ''}`}
    >
      {showIcons && (
        <span
          className="w-[18px] h-[18px] flex-shrink-0 inline-flex items-center justify-center"
          style={iconStyle}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {children}
    </button>
  );
});

/** The horizontal rule shared by both menus' separators. */
export function MenuSeparator(props: { role?: string }) {
  return <div role={props.role} className="border-t border-border my-1" />;
}
