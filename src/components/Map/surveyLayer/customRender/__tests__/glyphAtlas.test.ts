import { describe, expect, it } from 'vitest';
import {
  GlyphAtlas,
  SDF_BUFFER,
  type GlyphInfo,
  type GlyphRasterizer,
  type RasterizedGlyph,
} from '../glyphAtlas';

/**
 * Glyph-atlas packing / growth / metrics (#customRender labels, Phase 0). The
 * atlas owns only CPU data + an injectable rasterizer, so these run in the
 * `node` env with a deterministic FAKE rasterizer (no canvas / no font): every
 * assertion is about the shelf packer, the height-doubling growth, the
 * MAX_TEXTURE_SIZE cap, and the raster-px -> layout-metric conversion.
 */

/** A fake rasterized glyph of a given bitmap size. `glyphWidth/Height` are the
 *  ink box (bitmap minus the 2*buffer padding), clamped at 0. */
function fakeGlyph(
  w: number,
  h: number,
  opts: { advance?: number; glyphLeft?: number; glyphTop?: number; fill?: number } = {},
): RasterizedGlyph {
  const data = new Uint8Array(Math.max(0, w * h)).fill(opts.fill ?? 200);
  return {
    data,
    width: w,
    height: h,
    glyphWidth: Math.max(0, w - 2 * SDF_BUFFER),
    glyphHeight: Math.max(0, h - 2 * SDF_BUFFER),
    glyphTop: opts.glyphTop ?? Math.max(0, h - 2 * SDF_BUFFER),
    glyphLeft: opts.glyphLeft ?? 0,
    glyphAdvance: opts.advance ?? Math.max(0, w - 2 * SDF_BUFFER),
  };
}

/** Rasterizer that returns a fixed-size glyph for every char. */
function fixedRasterizer(w: number, h: number): GlyphRasterizer {
  return () => fakeGlyph(w, h);
}

/** Do two atlas rects overlap? */
function overlaps(a: GlyphInfo, b: GlyphInfo): boolean {
  return a.ax < b.ax + b.aw && b.ax < a.ax + a.aw && a.ay < b.ay + b.ah && b.ay < a.ay + a.ah;
}

describe('GlyphAtlas packing', () => {
  it('caches per glyph (one raster per distinct char)', () => {
    let rasters = 0;
    const atlas = new GlyphAtlas({
      rasterizer: (c) => {
        rasters++;
        return fakeGlyph(10, 10, { advance: c.charCodeAt(0) });
      },
    });
    const a1 = atlas.getGlyph('A');
    const a2 = atlas.getGlyph('A');
    expect(a1).toBe(a2); // same cached object
    expect(rasters).toBe(1);
    atlas.getGlyph('B');
    expect(rasters).toBe(2);
    expect(atlas.glyphCount).toBe(2);
  });

  it('places glyphs left-to-right with no overlaps and inside the page width', () => {
    const atlas = new GlyphAtlas({ rasterizer: fixedRasterizer(20, 20) });
    const placed: GlyphInfo[] = [];
    for (let i = 0; i < 200; i++) placed.push(atlas.getGlyph(String.fromCharCode(0x100 + i)));
    for (const g of placed) {
      expect(g.ax).toBeGreaterThanOrEqual(0);
      expect(g.ax + g.aw).toBeLessThanOrEqual(atlas.width);
      expect(g.ay + g.ah).toBeLessThanOrEqual(atlas.height);
    }
    // No two placed rects overlap.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i]!, placed[j]!)).toBe(false);
      }
    }
  });

  it('wraps to a new shelf when a glyph would overflow the width', () => {
    const atlas = new GlyphAtlas({ rasterizer: fixedRasterizer(20, 20) });
    const first = atlas.getGlyph('a');
    let wrapped: GlyphInfo | null = null;
    // Enough 20px glyphs (+1 gutter) to exceed 1024 width -> a later glyph lands
    // on a new shelf below the first row.
    for (let i = 0; i < 100; i++) {
      const g = atlas.getGlyph(String.fromCharCode(0x200 + i));
      if (g.ay > first.ay) {
        wrapped = g;
        break;
      }
    }
    expect(wrapped).not.toBeNull();
    expect(wrapped!.ay).toBeGreaterThanOrEqual(first.ay + first.ah);
    expect(wrapped!.ax).toBeLessThan(first.ax + 40); // back near the left edge
  });

  it('derives layout metrics from the raster metrics (left/top include the buffer)', () => {
    const atlas = new GlyphAtlas({
      rasterizer: () => fakeGlyph(16, 22, { advance: 12, glyphLeft: -2, glyphTop: 15 }),
    });
    const g = atlas.getGlyph('x');
    expect(g.advance).toBe(12);
    expect(g.left).toBe(-2 - SDF_BUFFER); // glyphLeft - buffer
    expect(g.top).toBe(15 + SDF_BUFFER); // glyphTop + buffer
    expect(g.width).toBe(16);
    expect(g.height).toBe(22);
    expect(g.aw).toBe(16);
    expect(g.ah).toBe(22);
  });

  it('emits an advance-only (no-quad) glyph for whitespace', () => {
    // A space has zero ink -> width/height 0 from TinySDF; the pen still advances.
    const atlas = new GlyphAtlas({ rasterizer: () => fakeGlyph(0, 0, { advance: 7 }) });
    const g = atlas.getGlyph(' ');
    expect(g.width).toBe(0);
    expect(g.height).toBe(0);
    expect(g.aw).toBe(0);
    expect(g.advance).toBe(7);
    // No bitmap -> nothing to upload.
    expect(atlas.takeUploads().rects).toHaveLength(0);
  });
});

describe('GlyphAtlas growth', () => {
  it('doubles height when a shelf overflows, preserving prior placements + bytes', () => {
    const atlas = new GlyphAtlas({ rasterizer: fixedRasterizer(60, 60), initialHeight: 128, maxHeight: 2048 });
    const before: GlyphInfo[] = [];
    for (let i = 0; i < 20; i++) before.push(atlas.getGlyph(String.fromCharCode(0x300 + i)));
    // Force growth past the initial 128px height with many 60px-tall shelves.
    let grewSeen = false;
    for (let i = 0; i < 200 && !grewSeen; i++) {
      atlas.getGlyph(String.fromCharCode(0x400 + i));
      if (atlas.height > 128) grewSeen = true;
    }
    expect(grewSeen).toBe(true);
    expect(atlas.height).toBeGreaterThan(128);
    // Height is a power-of-two doubling of the initial.
    expect(Number.isInteger(Math.log2(atlas.height / 128))).toBe(true);
    // The backing store is sized to the new height and prior placements are still
    // addressable (their ay/ah are within the grown page).
    expect(atlas.data.length).toBe(atlas.width * atlas.height);
    for (const g of before) expect(g.ay + g.ah).toBeLessThanOrEqual(atlas.height);
    // A grow marks a full re-upload.
    expect(atlas.takeUploads().grew).toBe(true);
  });

  it('caps at maxHeight and degrades an overflowing glyph to advance-only', () => {
    const atlas = new GlyphAtlas({ rasterizer: fixedRasterizer(60, 60), initialHeight: 128, maxHeight: 128 });
    let overflowed: GlyphInfo | null = null;
    for (let i = 0; i < 500; i++) {
      const g = atlas.getGlyph(String.fromCharCode(0x500 + i));
      if (g.aw === 0 && g.advance > 0) {
        overflowed = g;
        break;
      }
    }
    expect(atlas.height).toBe(128); // never grew past the cap
    expect(overflowed).not.toBeNull();
    expect(overflowed!.advance).toBeGreaterThan(0); // still spaced, just not drawn
  });

  it('drops the bitmap of a glyph wider than the whole page but keeps its advance', () => {
    const atlas = new GlyphAtlas({ rasterizer: () => fakeGlyph(2000, 20, { advance: 30 }) });
    const g = atlas.getGlyph('W');
    expect(g.aw).toBe(0);
    expect(g.advance).toBe(30);
  });
});

describe('GlyphAtlas uploads', () => {
  it('records one dirty rect per newly packed glyph and clears on take', () => {
    const atlas = new GlyphAtlas({ rasterizer: fixedRasterizer(10, 10) });
    atlas.getGlyph('a');
    atlas.getGlyph('b');
    const first = atlas.takeUploads();
    expect(first.grew).toBe(false);
    expect(first.rects).toHaveLength(2);
    // Second take is empty (dirty list reset).
    expect(atlas.takeUploads().rects).toHaveLength(0);
    // A cached re-fetch adds nothing.
    atlas.getGlyph('a');
    expect(atlas.takeUploads().rects).toHaveLength(0);
  });

  it('blits the glyph bytes into the R8 grid at the packed origin', () => {
    const atlas = new GlyphAtlas({ rasterizer: () => fakeGlyph(4, 3, { fill: 123 }) });
    const g = atlas.getGlyph('q');
    // Spot-check a couple of interior pixels landed at (ax, ay).
    expect(atlas.data[g.ay * atlas.width + g.ax]).toBe(123);
    expect(atlas.data[(g.ay + 2) * atlas.width + (g.ax + 3)]).toBe(123);
  });
});

describe('GlyphAtlas inert (no rasterizer)', () => {
  it('returns a zero-advance fallback glyph and never throws', () => {
    const atlas = new GlyphAtlas();
    const g = atlas.getGlyph('Z');
    expect(g.advance).toBe(0);
    expect(g.aw).toBe(0);
    expect(atlas.glyphCount).toBe(0); // nothing cached
  });
});
