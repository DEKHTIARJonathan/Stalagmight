/**
 * Per-string text shaping + em-based anchor/offset layout (#customRender labels,
 * Phase 1).
 *
 * PURE (no GL, no DOM beyond the injected {@link GlyphAtlas}): turns one label
 * string into a set of per-glyph quads whose corner offsets are expressed in EM
 * relative to the label's geographic anchor. The GL layer later multiplies these
 * em offsets by the per-kind rendered text size to get screen px (so one shaping
 * pass at 1 em is correct across all zooms — max-width, anchoring and offsets are
 * all size-independent em constants, matching MapLibre semantics, §2 of design).
 *
 * SHAPING: left-to-right, per-character advance summation (no kerning, no
 * contextual shaping) — exactly how MapLibre lays out its own glyph runs, so
 * matching it is both simpler and closer to current behavior than a real shaper.
 * Advances/bearings come from the atlas glyph metrics (24 px raster space),
 * divided by the raster em to get em.
 *
 * WRAP: comments (the two kinds with `text-max-width: 12`) greedily break on
 * whitespace at 12 em; a single word longer than the max gets its own line (no
 * mid-word break — a close-enough approximation of MapLibre's ideal-break, §2).
 * All other kinds are single-line.
 *
 * ANCHOR / OFFSET: each kind has a MapLibre `text-anchor` + `text-offset` (em).
 * We reproduce them in an em coordinate frame with +x RIGHT, +y DOWN (MapLibre's
 * text convention), then negate y when emitting so the shader sees +y UP (its
 * screen-offset convention). The block's top-left is placed from the anchor's
 * horizontal/vertical alignment + the offset; each line is aligned within the
 * block per the horizontal anchor.
 */
import { LABEL_KIND, type LabelKind } from './labelShaders';
import { SDF_FONT_SIZE, type GlyphAtlas } from './glyphAtlas';

/** MapLibre default text line height, in em. */
export const LINE_HEIGHT_EM = 1.2;
/** Baseline position within a line box, in em from the line top. ~0.9 places the
 *  baseline near the bottom of the 1.2 em box (leaving room for descenders), so
 *  cap/digit ink tops sit near the block top. An approximation (the design
 *  reserves pixel-exact vertical placement for visual QA), tuned to read right
 *  for the digit/caps-heavy label charset. */
export const ASCENT_EM = 0.9;
/** Comment wrap width, in em (`text-max-width: 12`). */
export const COMMENT_MAX_WIDTH_EM = 12;

/** Horizontal / vertical anchor alignment (the two axes of MapLibre `text-anchor`). */
type HAlign = 'left' | 'center' | 'right';
type VAlign = 'top' | 'center' | 'bottom';

/** Per-kind layout: MapLibre `text-anchor` (split into the two axes),
 *  `text-offset` (em, +x right / +y down), and wrap width (Infinity = no wrap). */
export interface KindLayout {
  h: HAlign;
  v: VAlign;
  offsetEm: readonly [number, number];
  maxWidthEm: number;
}

/**
 * Per-kind anchor + offset + wrap, mirroring the 5 stock symbol layers exactly
 * (see the parity inventory):
 *   - shot label:     anchor 'top',         offset [0, 0.5]
 *   - station label:  anchor 'bottom-left',  offset [0.8, -0.8]
 *   - section name:   anchor 'bottom',       offset [0, -1.2]
 *   - comments:       anchor 'top',          offset [0, 1.5], max-width 12
 */
export const LABEL_KIND_LAYOUT: Record<LabelKind, KindLayout> = {
  [LABEL_KIND.SHOT_LABEL]: { h: 'center', v: 'top', offsetEm: [0, 0.5], maxWidthEm: Infinity },
  [LABEL_KIND.STATION_LABEL]: { h: 'left', v: 'bottom', offsetEm: [0.8, -0.8], maxWidthEm: Infinity },
  [LABEL_KIND.SECTION_NAME]: { h: 'center', v: 'bottom', offsetEm: [0, -1.2], maxWidthEm: Infinity },
  [LABEL_KIND.STATION_COMMENT]: { h: 'center', v: 'top', offsetEm: [0, 1.5], maxWidthEm: COMMENT_MAX_WIDTH_EM },
  [LABEL_KIND.SHOT_COMMENT]: { h: 'center', v: 'top', offsetEm: [0, 1.5], maxWidthEm: COMMENT_MAX_WIDTH_EM },
};

/**
 * One shaped glyph quad. Corner offsets are in EM relative to the label anchor,
 * with +x right and +y UP (the shader convention). `xL < xR`, `yTop > yBot`.
 * `ax,ay,aw,ah` are the glyph's atlas PIXEL rect; whitespace produces no
 * {@link ShapedGlyph} at all (it only advances the pen).
 */
export interface ShapedGlyph {
  xL: number;
  xR: number;
  yTop: number;
  yBot: number;
  ax: number;
  ay: number;
  aw: number;
  ah: number;
}

/** A fully shaped label: its glyph quads (possibly across several wrapped lines)
 *  in anchored em. `glyphCount === glyphs.length` (a convenience for buffer
 *  sizing). Empty text -> zero glyphs. */
export interface ShapedLabel {
  glyphCount: number;
  glyphs: ShapedGlyph[];
}

/** Split text into wrapped lines. Non-wrapping kinds return a single line; the
 *  wrapping (comment) kinds greedily break on whitespace runs at `maxWidthEm`,
 *  measuring each word by its glyph-advance sum. A word wider than the max gets
 *  its own line (no mid-word break). */
function wrapIntoLines(text: string, maxWidthEm: number, atlas: GlyphAtlas): string[] {
  if (!Number.isFinite(maxWidthEm)) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const spaceEm = advanceEm(' ', atlas);
  const lines: string[] = [];
  let current = words[0]!;
  let currentWidth = lineWidthEm(current, atlas);
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const wordWidth = lineWidthEm(word, atlas);
    if (currentWidth + spaceEm + wordWidth <= maxWidthEm) {
      current += ' ' + word;
      currentWidth += spaceEm + wordWidth;
    } else {
      lines.push(current);
      current = word;
      currentWidth = wordWidth;
    }
  }
  lines.push(current);
  return lines;
}

/** Em advance of a single character (its glyph advance / raster em). */
function advanceEm(char: string, atlas: GlyphAtlas): number {
  return atlas.getGlyph(char).advance / SDF_FONT_SIZE;
}

/** Total em width of a line = sum of its glyph advances. */
export function lineWidthEm(line: string, atlas: GlyphAtlas): number {
  let w = 0;
  for (const ch of line) w += advanceEm(ch, atlas);
  return w;
}

/** Left edge (em) of a line given its width + the block's horizontal anchor +
 *  the x offset. Independent of the block width: for center/right the line is
 *  aligned on the offset x directly. */
function lineLeftEm(h: HAlign, lineWidth: number, offsetX: number): number {
  if (h === 'left') return offsetX;
  if (h === 'center') return offsetX - lineWidth / 2;
  return offsetX - lineWidth; // right
}

/** Top edge (em, +down) of the whole text block given its height + the block's
 *  vertical anchor + the y offset. */
function blockTopEm(v: VAlign, blockHeight: number, offsetY: number): number {
  if (v === 'top') return offsetY;
  if (v === 'center') return offsetY - blockHeight / 2;
  return offsetY - blockHeight; // bottom
}

/**
 * Shape one label string of a given kind into per-glyph quads. Reads glyph
 * metrics from `atlas` (rasterizing + caching lazily). Empty / whitespace-only
 * text yields an empty {@link ShapedLabel}.
 */
export function shapeLabel(text: string, kind: LabelKind, atlas: GlyphAtlas): ShapedLabel {
  const layout = LABEL_KIND_LAYOUT[kind];
  const lines = wrapIntoLines(text, layout.maxWidthEm, atlas);
  const glyphs: ShapedGlyph[] = [];
  if (lines.length === 0) return { glyphCount: 0, glyphs };

  const [offsetX, offsetY] = layout.offsetEm;
  const blockHeight = lines.length * LINE_HEIGHT_EM;
  const top = blockTopEm(layout.v, blockHeight, offsetY);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineW = lineWidthEm(line, atlas);
    const left = lineLeftEm(layout.h, lineW, offsetX);
    // Baseline of this line, in em (+down from the anchor).
    const baseY = top + ASCENT_EM + li * LINE_HEIGHT_EM;
    let penEm = left;
    for (const ch of line) {
      const g = atlas.getGlyph(ch);
      if (g.width > 0 && g.height > 0) {
        const xL = penEm + g.left / SDF_FONT_SIZE;
        const xR = xL + g.width / SDF_FONT_SIZE;
        // Bitmap top is `g.top` em ABOVE the baseline; convert +down -> +up (negate).
        const yTopDown = baseY - g.top / SDF_FONT_SIZE;
        const yBotDown = yTopDown + g.height / SDF_FONT_SIZE;
        glyphs.push({
          xL,
          xR,
          yTop: -yTopDown,
          yBot: -yBotDown,
          ax: g.ax,
          ay: g.ay,
          aw: g.aw,
          ah: g.ah,
        });
      }
      penEm += g.advance / SDF_FONT_SIZE;
    }
  }
  return { glyphCount: glyphs.length, glyphs };
}
