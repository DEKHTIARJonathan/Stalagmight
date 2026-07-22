/**
 * MapLibre `CustomLayerInterface` for the drag-GHOST (#mem drag latency). A small
 * sibling of `surveyCustomLayer.ts` that draws the moving-geometry preview of a
 * move drag directly from typed-array buffers, with the live drag delta carried
 * as ONE screen-pixel uniform (`u_offset_px`) applied in the vertex shader. A
 * pointermove updates that single uniform + `triggerRepaint` — no worker, no
 * `setData`, no per-frame rebuild — which removes the async re-bake overshoot the
 * stock GeoJSON ghost + `line-translate` state machine suffered.
 *
 * Same GL discipline as the bulk layer (WebGL2 / GLSL ES 3.00, premultiplied
 * blend, first-frames `getError()` self-disable). It fails on its own: a
 * compile/link failure at add, or a GL error mid-drag, self-disables JUST the
 * ghost via `onSelfDisable`, and the controller falls back to the stock GeoJSON
 * ghost so the user is never left without a preview.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from 'maplibre-gl';
import type { GhostLineBuffers, GhostCircleBuffers } from './ghostTessellate';
import { composeAnchorMatrix } from './mercator';
import {
  GHOST_LINE_VERTEX_SRC,
  GHOST_LINE_FRAGMENT_SRC,
  GHOST_CIRCLE_VERTEX_SRC,
  GHOST_CIRCLE_FRAGMENT_SRC,
} from './ghostShaders';

/** See {@link import('./surveyCustomLayer').SelfDisableCallback}. */
export type GhostSelfDisableCallback = (reason: string) => void;

/** How many clean frames to validate with `gl.getError()` before trusting the
 *  layer (a `getError()` is a pipeline stall). */
const MAX_CHECKED_FRAMES = 5;

/** Everything the ghost layer draws for a drag; set once at begin. */
export interface GhostRenderData {
  anchorX: number;
  anchorY: number;
  line: GhostLineBuffers;
  circle: GhostCircleBuffers;
  /** DEVICE-pixel style sizes (css * dpr). */
  lineHalfWidthPx: number;
  circleRadiusPx: number;
  circleStrokePx: number;
  aaPx: number;
}

interface LineGpu {
  posA: WebGLBuffer;
  posB: WebGLBuffer;
  endpoint: WebGLBuffer;
  side: WebGLBuffer;
  moveA: WebGLBuffer;
  moveB: WebGLBuffer;
  color: WebGLBuffer;
  widthMul: WebGLBuffer;
  index: WebGLBuffer;
  count: number;
}

interface CircleGpu {
  center: WebGLBuffer;
  corner: WebGLBuffer;
  move: WebGLBuffer;
  fill: WebGLBuffer;
  stroke: WebGLBuffer;
  index: WebGLBuffer;
  count: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[dragGhost] shader compile failed:', gl.getShaderInfoLog(sh));
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
    console.warn('[dragGhost] program link failed:', gl.getProgramInfoLog(prog));
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

export class SurveyGhostLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private gl: WebGL2RenderingContext | null = null;
  private lineProgram: WebGLProgram | null = null;
  private circleProgram: WebGLProgram | null = null;
  private lineGpu: LineGpu | null = null;
  private circleGpu: CircleGpu | null = null;
  private disabled = false;
  private disabledReason: string | null = null;
  private readonly onSelfDisable: GhostSelfDisableCallback | null;
  private checkedFrames = 0;

  private data: GhostRenderData | null = null;
  /** Live drag delta in DEVICE px (css delta * dpr), screen space (+y down). */
  private offsetX = 0;
  private offsetY = 0;

  constructor(id: string, initial: GhostRenderData | null, onSelfDisable: GhostSelfDisableCallback | null = null) {
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

  /** Set the live drag delta (DEVICE px). Cheap: one uniform each frame, no
   *  buffer touch. The caller triggers the repaint. */
  setOffset(dxDevicePx: number, dyDevicePx: number): void {
    this.offsetX = dxDevicePx;
    this.offsetY = dyDevicePx;
  }

  onAdd(_map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      console.warn('[dragGhost] WebGL2 unavailable; disabling ghost layer');
      this.disabled = true;
      this.disabledReason = 'webgl2-unavailable';
      return;
    }
    this.gl = gl;
    this.disabled = false;
    this.disabledReason = null;
    this.lineProgram = link(gl, GHOST_LINE_VERTEX_SRC, GHOST_LINE_FRAGMENT_SRC);
    this.circleProgram = link(gl, GHOST_CIRCLE_VERTEX_SRC, GHOST_CIRCLE_FRAGMENT_SRC);
    if (!this.lineProgram || !this.circleProgram) {
      console.warn('[dragGhost] shader program link failed; disabling ghost layer');
      this.disabled = true;
      this.disabledReason = 'program-link-failed';
      return;
    }
    if (this.data) this.uploadBuffers(this.data);
  }

  private uploadBuffers(data: GhostRenderData): void {
    const gl = this.gl;
    if (!gl) return;
    this.freeGpu();
    const l = data.line;
    this.lineGpu = {
      posA: makeBuffer(gl, gl.ARRAY_BUFFER, l.posA),
      posB: makeBuffer(gl, gl.ARRAY_BUFFER, l.posB),
      endpoint: makeBuffer(gl, gl.ARRAY_BUFFER, l.endpoint),
      side: makeBuffer(gl, gl.ARRAY_BUFFER, l.side),
      moveA: makeBuffer(gl, gl.ARRAY_BUFFER, l.moveA),
      moveB: makeBuffer(gl, gl.ARRAY_BUFFER, l.moveB),
      color: makeBuffer(gl, gl.ARRAY_BUFFER, l.color),
      widthMul: makeBuffer(gl, gl.ARRAY_BUFFER, l.widthMul),
      index: makeBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, l.indices),
      count: l.indices.length,
    };
    const c = data.circle;
    this.circleGpu = {
      center: makeBuffer(gl, gl.ARRAY_BUFFER, c.center),
      corner: makeBuffer(gl, gl.ARRAY_BUFFER, c.corner),
      move: makeBuffer(gl, gl.ARRAY_BUFFER, c.move),
      fill: makeBuffer(gl, gl.ARRAY_BUFFER, c.fill),
      stroke: makeBuffer(gl, gl.ARRAY_BUFFER, c.stroke),
      index: makeBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, c.indices),
      count: c.indices.length,
    };
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (this.disabled || !(gl instanceof WebGL2RenderingContext)) return;
    const data = this.data;
    if (!data || !this.lineProgram || !this.circleProgram || !this.lineGpu || !this.circleGpu) return;
    const mainMatrix = options.defaultProjectionData.mainMatrix as ArrayLike<number> | undefined;
    if (!mainMatrix) return;
    const matrix = composeAnchorMatrix(mainMatrix, data.anchorX, data.anchorY);
    const viewport: [number, number] = [gl.drawingBufferWidth, gl.drawingBufferHeight];

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this.drawLines(gl, matrix, viewport, data);
    this.drawCircles(gl, matrix, viewport, data);
    this.checkFrameError(gl);
  }

  private checkFrameError(gl: WebGL2RenderingContext): void {
    if (this.checkedFrames >= MAX_CHECKED_FRAMES) return;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      const reason = `gl-error-0x${err.toString(16)}`;
      this.disabled = true;
      this.disabledReason = reason;
      console.warn(`[dragGhost] GL error 0x${err.toString(16)} after draw; self-disabling ghost layer`);
      this.onSelfDisable?.(reason);
      return;
    }
    this.checkedFrames += 1;
  }

  private drawLines(
    gl: WebGL2RenderingContext,
    matrix: Float32Array,
    viewport: [number, number],
    data: GhostRenderData,
  ): void {
    const prog = this.lineProgram!;
    const g = this.lineGpu!;
    if (g.count === 0) return;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_matrix'), false, matrix);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_viewport'), viewport[0], viewport[1]);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_half_width'), data.lineHalfWidthPx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_aa'), data.aaPx);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_offset_px'), this.offsetX, this.offsetY);
    this.bindVec2(gl, prog, 'a_pos_a', g.posA);
    this.bindVec2(gl, prog, 'a_pos_b', g.posB);
    this.bindFloat(gl, prog, 'a_endpoint', g.endpoint);
    this.bindFloat(gl, prog, 'a_side', g.side);
    this.bindFloat(gl, prog, 'a_move_a', g.moveA);
    this.bindFloat(gl, prog, 'a_move_b', g.moveB);
    this.bindColor(gl, prog, 'a_color', g.color);
    this.bindFloat(gl, prog, 'a_width_mul', g.widthMul);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.index);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
  }

  private drawCircles(
    gl: WebGL2RenderingContext,
    matrix: Float32Array,
    viewport: [number, number],
    data: GhostRenderData,
  ): void {
    const prog = this.circleProgram!;
    const g = this.circleGpu!;
    if (g.count === 0) return;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_matrix'), false, matrix);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_viewport'), viewport[0], viewport[1]);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_radius'), data.circleRadiusPx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_stroke_width'), data.circleStrokePx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_aa'), data.aaPx);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_offset_px'), this.offsetX, this.offsetY);
    this.bindVec2(gl, prog, 'a_center', g.center);
    this.bindVec2(gl, prog, 'a_corner', g.corner);
    this.bindFloat(gl, prog, 'a_move', g.move);
    this.bindColor(gl, prog, 'a_fill', g.fill);
    this.bindColor(gl, prog, 'a_stroke', g.stroke);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.index);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
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

  private freeGpu(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const g of [this.lineGpu, this.circleGpu]) {
      if (!g) continue;
      for (const key of Object.keys(g) as (keyof typeof g)[]) {
        const v = g[key];
        if (v instanceof WebGLBuffer) gl.deleteBuffer(v);
      }
    }
    this.lineGpu = null;
    this.circleGpu = null;
  }

  onRemove(_map: MaplibreMap, _gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl = this.gl;
    this.freeGpu();
    if (gl) {
      if (this.lineProgram) gl.deleteProgram(this.lineProgram);
      if (this.circleProgram) gl.deleteProgram(this.circleProgram);
    }
    this.lineProgram = null;
    this.circleProgram = null;
    this.gl = null;
  }
}
