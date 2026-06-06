/**
 * Duotone tool icons for the toolbar — a soft accent-fill silhouette plus a
 * solid accent line, where the object color encodes WHAT the tool acts on and
 * a shared modifier (slate move-compass) encodes the move action. Ported from
 * the Cave Survey icon spec (`~/Downloads/Cave Survey Icons.html`).
 *
 * Each glyph is rendered inside a `.duotone` SVG whose `--o` custom property is
 * set to the tool's role color (`var(--sh-<role>)`). The duotone CSS classes
 * (`.s/.f/.d/.ink/.mvf/.mvc`) live in `src/index.css`. When the highlighting
 * level is "off", `--sh-*` resolve to a neutral so these render monochrome.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { ToolType } from '../../store/uiStore';
import { TOOL_ROLE_MAP, syntacticVarName } from '../../theme/syntacticPalette';

/** Survey station glyph: accent ring + filled centre dot. */
function Station({ cx, cy, r = 3 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle className="f" cx={cx} cy={cy} r={r} />
      <circle className="s" cx={cx} cy={cy} r={r} />
      <circle className="d" cx={cx} cy={cy} r={Math.max(0.9, r * 0.34)} />
    </g>
  );
}

/** Four-way move compass (slate, via --sh-move) + faint cross. */
function MoveDeco() {
  return (
    <g>
      <path className="mvf" d="M12 2 L14 5 H10 Z" />
      <path className="mvf" d="M12 22 L10 19 H14 Z" />
      <path className="mvf" d="M2 12 L5 10 V14 Z" />
      <path className="mvf" d="M22 12 L19 14 V10 Z" />
      <rect className="mvc" x="11.3" y="5" width="1.4" height="14" rx="0.7" />
      <rect className="mvc" x="5" y="11.3" width="14" height="1.4" rx="0.7" />
    </g>
  );
}

/** Glyph body for each toolbar tool, keyed by tool id. */
const GLYPHS: Partial<Record<ToolType, () => ReactNode>> = {
  select: () => (
    <g>
      <path className="f" d="M5 3 L13 17 L14.2 11.2 L19.5 9.8 Z" />
      <path className="s" d="M5 3 L13 17 L14.2 11.2 L19.5 9.8 Z" />
      <rect className="s dash" x="14.5" y="14.5" width="6.5" height="6.5" rx="1" />
    </g>
  ),
  pan: () => (
    <g>
      <path
        className="f"
        d="M8 13 V6.5 A1 1 0 0 1 10 6.5 V12 V4.5 A1 1 0 0 1 12 4.5 V12 V5.5 A1 1 0 0 1 14 5.5 V12 V7.5 A1 1 0 0 1 16 7.5 V16 A4 4 0 0 1 12 20 H10.5 A4 4 0 0 1 6.8 15.6 L6.5 15.5 Z"
      />
      <path className="s" d="M8 13 V6.5 A1 1 0 0 1 10 6.5 V12" />
      <path className="s" d="M10 12 V4.5 A1 1 0 0 1 12 4.5 V12" />
      <path className="s" d="M12 12 V5.5 A1 1 0 0 1 14 5.5 V12" />
      <path className="s" d="M14 12 V7.5 A1 1 0 0 1 16 7.5 V14" />
      <path className="s" d="M8 13 L6.5 15.5 A4 4 0 0 0 10 20 H14 A4 4 0 0 0 18 16 V14" />
    </g>
  ),
  zoom: () => (
    <g>
      <circle className="f" cx="10" cy="10" r="6" />
      <circle className="s" cx="10" cy="10" r="6" />
      <path className="s thick" d="M14.5 14.5 L20 20" />
      <path className="s" d="M10 7.5 V12.5" />
      <path className="s" d="M7.5 10 H12.5" />
    </g>
  ),
  measure: () => (
    <g>
      <rect className="f" x="2" y="8" width="20" height="8" rx="1.4" />
      <rect className="s" x="2" y="8" width="20" height="8" rx="1.4" />
      <path className="s" d="M6 8 V11" />
      <path className="s" d="M10 8 V12.5" />
      <path className="s" d="M14 8 V11" />
      <path className="s" d="M18 8 V12.5" />
    </g>
  ),
  merge: () => (
    <g>
      <path className="s" d="M6.5 8 L14 12" />
      <path className="s" d="M6.5 16 L14 12" />
      <Station cx={4} cy={8} r={2.4} />
      <Station cx={4} cy={16} r={2.4} />
      <Station cx={19} cy={12} r={2.6} />
      <path className="s arrow" d="M12.5 9.8 L15.5 12 L12.5 14.2" />
    </g>
  ),
  comment: () => (
    <g>
      <path
        className="f"
        d="M5 4 H19 A1 1 0 0 1 20 5 V15 A1 1 0 0 1 19 16 H10 L6 20 V16 H5 A1 1 0 0 1 4 15 V5 A1 1 0 0 1 5 4 Z"
      />
      <path
        className="s"
        d="M5 4 H19 A1 1 0 0 1 20 5 V15 A1 1 0 0 1 19 16 H10 L6 20 V16 H5 A1 1 0 0 1 4 15 V5 A1 1 0 0 1 5 4 Z"
      />
      <path className="s ink" d="M8 8 H16" />
      <path className="s ink" d="M8 12 H13" />
    </g>
  ),
  move_comment: () => (
    <g>
      <MoveDeco />
      <path
        className="f"
        d="M7.5 8 H16 A1 1 0 0 1 17 9 V13.5 A1 1 0 0 1 16 14.5 H11 L8.5 17 V14.5 H7.5 A1 1 0 0 1 6.5 13.5 V9 A1 1 0 0 1 7.5 8 Z"
      />
      <path
        className="s"
        d="M7.5 8 H16 A1 1 0 0 1 17 9 V13.5 A1 1 0 0 1 16 14.5 H11 L8.5 17 V14.5 H7.5 A1 1 0 0 1 6.5 13.5 V9 A1 1 0 0 1 7.5 8 Z"
      />
    </g>
  ),
  move_station: () => (
    <g>
      <MoveDeco />
      <Station cx={12} cy={12} r={3} />
    </g>
  ),
  move_shot: () => (
    <g>
      <MoveDeco />
      <path className="s" d="M8.5 15.5 L15.5 8.5" />
      <Station cx={8.5} cy={15.5} r={1.9} />
      <Station cx={15.5} cy={8.5} r={1.9} />
    </g>
  ),
  move_segment: () => (
    <g>
      <MoveDeco />
      <path className="s" d="M7.5 15.5 L11 11 L14 13.5 L16.5 9.5" />
      <circle className="d" cx="7.5" cy="15.5" r="1.3" />
      <circle className="d" cx="11" cy="11" r="1.3" />
      <circle className="d" cx="14" cy="13.5" r="1.3" />
      <circle className="d" cx="16.5" cy="9.5" r="1.3" />
    </g>
  ),
};

export interface ToolGlyphProps {
  tool: ToolType;
  size?: number;
}

/**
 * Render the duotone glyph for a tool, colored by its syntactic-highlighting
 * role via the `--o` custom property. Returns null for tools without a glyph
 * (e.g. the removed draw/delete tools).
 */
export function ToolGlyph({ tool, size = 20 }: ToolGlyphProps) {
  const render = GLYPHS[tool];
  if (!render) return null;
  const role = TOOL_ROLE_MAP[tool];
  const style = { '--o': `var(${syntacticVarName(role)})` } as CSSProperties;
  return (
    <svg
      className="duotone"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {render()}
    </svg>
  );
}

/** Whether a duotone glyph exists for a tool. */
export function hasToolGlyph(tool: ToolType): boolean {
  return GLYPHS[tool] !== undefined;
}

/** CSS `var(--sh-<role>)` reference for a tool's accent color (icon + button tint). */
export function toolAccentVar(tool: ToolType): string {
  return `var(${syntacticVarName(TOOL_ROLE_MAP[tool])})`;
}
