/**
 * MapLibre `CustomLayerInterface` for the custom-render LABEL pass (#customRender
 * labels, Phase 2). Draws SDF glyph quads from typed-array buffers + a growing R8
 * glyph-atlas texture — the first sampler in this renderer. Sibling of
 * `surveyCustomLayer.ts` (geometry); same GL discipline (WebGL2 / GLSL ES 3.00,
 * premultiplied-alpha blend, first-frames `getError()` self-disable) and the same
 * anchor-relative-mercator + screen-px-offset primitive via `composeAnchorMatrix`.
 *
 * INDEPENDENCE: this layer fails on its own. A compile/link failure or a GL error
 * self-disables JUST the labels (the controller restores the stock label layer),
 * leaving the geometry custom layer untouched — the design's "the two custom
 * layers can fail independently" (§8).
 *
 * PER-FRAME UNIFORMS: the layer holds no zoom-dependent state. Each frame it reads
 * the LIVE zoom (`map.getZoom()`) and calls {@link computeLabelUniforms} with the
 * controller's style inputs, so `text-size` / `text-opacity` interpolate
 * continuously and decimation / minzoom gating track zoom with zero buffer
 * rebuild (§0/§3 of the design).
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from 'maplibre-gl';
import { composeAnchorMatrix } from './mercator';
import { LABEL_VERTEX_SRC, LABEL_FRAGMENT_SRC } from './labelShaders';
import { SDF_FONT_SIZE, SDF_RADIUS, type GlyphAtlas } from './glyphAtlas';
import { computeLabelUniforms, type LabelStyleInputs } from './labelStyle';
import type { LabelBuffers } from './labelTessellate';

/** See {@link import('./surveyCustomLayer').SelfDisableCallback}. */
export type LabelSelfDisableCallback = (reason: string) => void;

/** How many consecutive clean frames to validate with `gl.getError()` before
 *  trusting the layer (a `getError()` is a pipeline stall). */
const MAX_CHECKED_FRAMES = 5;

/** Everything the layer needs to draw one frame; swapped wholesale by update(). */
export interface LabelRenderData {
  anchorX: number;
  anchorY: number;
  buffers: LabelBuffers;
  /** The glyph atlas backing `a_uv` — the layer drains its pending texture
   *  uploads (grow → full re-upload; else per-rect `texSubImage2D`). */
  atlas: GlyphAtlas;
}

interface LabelGpu {
  anchor: WebGLBuffer;
  offsetEm: WebGLBuffer;
  uv: WebGLBuffer;
  color: WebGLBuffer;
  kind: WebGLBuffer;
  ordinal: WebGLBuffer;
  flags: WebGLBuffer;
  index: WebGLBuffer;
  count: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[customRender] label shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[customRender] label program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function makeBuffer(gl: WebGL2RenderingContext, target: number, data: ArrayBufferView): WebGLBuffer {
  const buf = gl.createBuffer()!;
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return buf;
}

/** A neutral style default so a frame before the controller pushes inputs never
 *  reads undefined (everything hidden, opaque-black halo — draws nothing since
 *  kindVisible is 0). */
const DEFAULT_STYLE: LabelStyleInputs = {
  dpr: 1,
  kindEnabled: [false, false, false, false, false],
  haloColors: [],
  hideReference: false,
};

export class SurveyCustomLabelLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private gpu: LabelGpu | null = null;
  private tex: WebGLTexture | null = null;
  /** Atlas dims currently allocated in `tex` (0 = not yet uploaded). */
  private texWidth = 0;
  private texHeight = 0;

  private disabled = false;
  private disabledReason: string | null = null;
  private readonly onSelfDisable: LabelSelfDisableCallback | null;
  private checkedFrames = 0;
  private firstFrameLogged = false;

  private data: LabelRenderData | null = null;
  private style: LabelStyleInputs = DEFAULT_STYLE;

  constructor(id: string, initial: LabelRenderData | null, onSelfDisable: LabelSelfDisableCallback | null = null) {
    this.id = id;
    this.data = initial;
    this.onSelfDisable = onSelfDisable;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  getDisabledReason(): string | null {
    return this.disabledReason;
  }

  /** Replace the controller-owned NON-zoom style inputs (theme halo, per-kind
   *  toggles, DPR, reference-hide). Cheap: no buffer touch, just a repaint by the
   *  caller. The layer folds these with the live zoom each frame. */
  setStyleInputs(style: LabelStyleInputs): void {
    this.style = style;
  }

  onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      console.warn('[customRender] WebGL2 unavailable; disabling custom label layer');
      this.disabled = true;
      this.disabledReason = 'webgl2-unavailable';
      return;
    }
    this.map = map;
    this.gl = gl;
    this.disabled = false;
    this.disabledReason = null;
    this.program = link(gl, LABEL_VERTEX_SRC, LABEL_FRAGMENT_SRC);
    if (!this.program) {
      console.warn('[customRender] label program link failed; disabling custom label layer');
      this.disabled = true;
      this.disabledReason = 'program-link-failed';
      return;
    }
    if (this.data) {
      this.uploadBuffers(this.data.buffers);
      this.uploadAtlas(this.data.atlas);
    }
  }

  /** Replace the glyph buffers + atlas; re-uploads if the context is live. */
  update(data: LabelRenderData): void {
    this.data = data;
    if (this.gl && !this.disabled) {
      this.uploadBuffers(data.buffers);
      this.uploadAtlas(data.atlas);
    }
  }

  private uploadBuffers(b: LabelBuffers): void {
    const gl = this.gl;
    if (!gl) return;
    this.freeGpu();
    if (b.glyphCount === 0) {
      this.gpu = null;
      return;
    }
    this.gpu = {
      anchor: makeBuffer(gl, gl.ARRAY_BUFFER, b.anchor),
      offsetEm: makeBuffer(gl, gl.ARRAY_BUFFER, b.offsetEm),
      uv: makeBuffer(gl, gl.ARRAY_BUFFER, b.uv),
      color: makeBuffer(gl, gl.ARRAY_BUFFER, b.color),
      kind: makeBuffer(gl, gl.ARRAY_BUFFER, b.kind),
      ordinal: makeBuffer(gl, gl.ARRAY_BUFFER, b.ordinal),
      flags: makeBuffer(gl, gl.ARRAY_BUFFER, b.flags),
      index: makeBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, b.indices),
      count: b.indices.length,
    };
  }

  /**
   * Upload the atlas' pending texture changes. First time (or after a height
   * doubling) does a full `texImage2D` of the R8 grid; otherwise `texSubImage2D`s
   * only the per-glyph dirty rects the atlas recorded. R8 / RED / UNSIGNED_BYTE
   * with UNPACK_ALIGNMENT 1 (single-channel rows are not 4-aligned). No
   * UNPACK_FLIP_Y: `a_uv` pairs the screen-top glyph corner with atlas row `ay`
   * (the glyph's top), so data-row order matches sample order.
   */
  private uploadAtlas(atlas: GlyphAtlas): void {
    const gl = this.gl;
    if (!gl) return;
    if (!this.tex) {
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.texWidth = 0;
      this.texHeight = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const uploads = atlas.takeUploads();
    const sizeChanged = atlas.width !== this.texWidth || atlas.height !== this.texHeight;
    if (this.texWidth === 0 || uploads.grew || sizeChanged) {
      // Full (re)allocation + upload.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, atlas.data,
      );
      this.texWidth = atlas.width;
      this.texHeight = atlas.height;
      return;
    }
    for (const r of uploads.rects) {
      const sub = subImage(atlas.data, atlas.width, r.x, r.y, r.w, r.h);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RED, gl.UNSIGNED_BYTE, sub);
    }
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (this.disabled || !(gl instanceof WebGL2RenderingContext)) return;
    const data = this.data;
    if (!data || !this.program || !this.gpu || !this.tex) return;
    const mainMatrix = options.defaultProjectionData.mainMatrix as ArrayLike<number> | undefined;
    if (!mainMatrix) return;
    const matrix = composeAnchorMatrix(mainMatrix, data.anchorX, data.anchorY);
    const zoom = this.map?.getZoom?.() ?? 0;
    const u = computeLabelUniforms(zoom, this.style);
    const prog = this.program;
    const g = this.gpu;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(prog);

    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_matrix'), false, matrix);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_viewport'), gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_atlas_size'), this.texWidth, this.texHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_font_size'), SDF_FONT_SIZE);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_sdf_radius'), SDF_RADIUS);
    gl.uniform1fv(gl.getUniformLocation(prog, 'u_text_size_px'), u.textSizePx);
    gl.uniform1fv(gl.getUniformLocation(prog, 'u_opacity'), u.opacity);
    gl.uniform1fv(gl.getUniformLocation(prog, 'u_decim_mod'), u.decimMod);
    gl.uniform1fv(gl.getUniformLocation(prog, 'u_kind_visible'), u.kindVisible);
    gl.uniform4fv(gl.getUniformLocation(prog, 'u_halo_color'), u.haloColor);
    gl.uniform1fv(gl.getUniformLocation(prog, 'u_halo_width_px'), u.haloWidthPx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_hide_reference'), u.hideReference);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_atlas'), 0);

    this.bindVec2(gl, prog, 'a_anchor', g.anchor);
    this.bindVec2(gl, prog, 'a_offset_em', g.offsetEm);
    this.bindVec2(gl, prog, 'a_uv', g.uv);
    this.bindColor(gl, prog, 'a_color', g.color);
    this.bindIntU8(gl, prog, 'a_kind', g.kind);
    this.bindFloat(gl, prog, 'a_ordinal', g.ordinal);
    this.bindIntU8(gl, prog, 'a_flags', g.flags);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.index);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);

    this.checkFrameError(gl, data);
  }

  private checkFrameError(gl: WebGL2RenderingContext, data: LabelRenderData): void {
    if (this.checkedFrames >= MAX_CHECKED_FRAMES) return;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      const code = `0x${err.toString(16)}`;
      const reason = `gl-error-${code}`;
      this.disabled = true;
      this.disabledReason = reason;
      console.warn(`[customRender] label GL error ${code} after draw; self-disabling custom label layer`);
      this.onSelfDisable?.(reason);
      return;
    }
    this.checkedFrames += 1;
    if (!this.firstFrameLogged) {
      this.firstFrameLogged = true;
      console.info('[customRender] label first frame drawn OK', {
        glyphs: data.buffers.glyphCount,
        bytes: data.buffers.byteLength,
      });
    }
  }

  private bindVec2(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, buf: WebGLBuffer): void {
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private bindFloat(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, buf: WebGLBuffer): void {
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, 0);
  }

  private bindColor(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, buf: WebGLBuffer): void {
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.UNSIGNED_BYTE, true, 0, 0);
  }

  /** Bind a UNSIGNED_BYTE INTEGER attribute (`in uint`) with `vertexAttribIPointer`. */
  private bindIntU8(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, buf: WebGLBuffer): void {
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribIPointer(loc, 1, gl.UNSIGNED_BYTE, 0, 0);
  }

  private freeGpu(): void {
    const gl = this.gl;
    if (!gl || !this.gpu) return;
    for (const key of Object.keys(this.gpu) as (keyof LabelGpu)[]) {
      const v = this.gpu[key];
      if (v instanceof WebGLBuffer) gl.deleteBuffer(v);
    }
    this.gpu = null;
  }

  onRemove(_map: MaplibreMap, _gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl = this.gl;
    this.freeGpu();
    if (gl) {
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.tex = null;
    this.texWidth = 0;
    this.texHeight = 0;
    this.program = null;
    this.gl = null;
    this.map = null;
  }
}

/** Copy an `w×h` sub-rect out of a row-major R8 grid into a tight buffer for
 *  `texSubImage2D` (rows in the source are `srcWidth` apart). */
function subImage(src: Uint8Array, srcWidth: number, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    const srcOff = (y + row) * srcWidth + x;
    out.set(src.subarray(srcOff, srcOff + w), row * w);
  }
  return out;
}
