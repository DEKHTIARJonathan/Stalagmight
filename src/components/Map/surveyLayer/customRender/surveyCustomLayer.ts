/**
 * MapLibre `CustomLayerInterface` for the bulk survey geometry prototype
 * (#customRender). Draws shots (screen-space AA lines) and stations (fragment
 * circles) directly from typed-array vertex buffers — no vector tiles, no
 * publication machinery. An edit becomes a buffer re-upload + `triggerRepaint`.
 *
 * GL discipline (per the CustomLayerInterface contract):
 *  - onAdd(map, gl): compile programs, create + upload buffers. Called again by
 *    MapLibre on context restore, so it fully rebuilds.
 *  - render(gl, opts): binds its OWN program / buffers / attributes / uniforms
 *    every frame, assumes nothing about incoming GL state, and sets the
 *    premultiplied-alpha blend MapLibre expects (ONE, ONE_MINUS_SRC_ALPHA).
 *  - onRemove(map, gl): frees all GL resources.
 *  - render() early-returns if buffers/programs are gone (context loss guard).
 *
 * WebGL2 only (GLSL ES 3.00 + UNSIGNED_INT indices). MapLibre 5.16 provides a
 * WebGL2 context; if a WebGL1 context is ever passed the programs fail to
 * compile and the layer disables itself with a console warning (prototype).
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from 'maplibre-gl';
import type { LineBuffers, CircleBuffers } from './tessellate';
import { composeAnchorMatrix } from './mercator';
import {
  LINE_VERTEX_SRC,
  LINE_FRAGMENT_SRC,
  CIRCLE_VERTEX_SRC,
  CIRCLE_FRAGMENT_SRC,
} from './shaders';

/** Everything the layer needs to draw one frame; swapped wholesale by update(). */
export interface CustomRenderData {
  anchorX: number;
  anchorY: number;
  line: LineBuffers;
  circle: CircleBuffers;
  /** DEVICE-pixel style sizes. */
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
  color: WebGLBuffer;
  index: WebGLBuffer;
  count: number;
}

interface CircleGpu {
  center: WebGLBuffer;
  corner: WebGLBuffer;
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
    console.warn('[customRender] shader compile failed:', gl.getShaderInfoLog(sh));
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
    console.warn('[customRender] program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function makeBuffer(
  gl: WebGL2RenderingContext,
  target: number,
  data: ArrayBufferView<ArrayBufferLike>,
): WebGLBuffer {
  const buf = gl.createBuffer()!;
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return buf;
}

export class SurveyCustomLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private gl: WebGL2RenderingContext | null = null;
  private lineProgram: WebGLProgram | null = null;
  private circleProgram: WebGLProgram | null = null;
  private lineGpu: LineGpu | null = null;
  private circleGpu: CircleGpu | null = null;
  private disabled = false;

  private data: CustomRenderData | null = null;
  /** Set before addLayer so onAdd uploads immediately. */
  constructor(id: string, initial: CustomRenderData | null) {
    this.id = id;
    this.data = initial;
  }

  onAdd(_map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      console.warn('[customRender] WebGL2 required; disabling custom layer');
      this.disabled = true;
      return;
    }
    this.gl = gl;
    this.disabled = false;
    this.lineProgram = link(gl, LINE_VERTEX_SRC, LINE_FRAGMENT_SRC);
    this.circleProgram = link(gl, CIRCLE_VERTEX_SRC, CIRCLE_FRAGMENT_SRC);
    if (!this.lineProgram || !this.circleProgram) {
      this.disabled = true;
      return;
    }
    if (this.data) this.uploadBuffers(this.data);
  }

  /** Replace the geometry/style; re-uploads GPU buffers if the context is live. */
  update(data: CustomRenderData): void {
    this.data = data;
    if (this.gl && !this.disabled) this.uploadBuffers(data);
  }

  private uploadBuffers(data: CustomRenderData): void {
    const gl = this.gl;
    if (!gl) return;
    this.freeGpu();
    const l = data.line;
    this.lineGpu = {
      posA: makeBuffer(gl, gl.ARRAY_BUFFER, l.posA),
      posB: makeBuffer(gl, gl.ARRAY_BUFFER, l.posB),
      endpoint: makeBuffer(gl, gl.ARRAY_BUFFER, l.endpoint),
      side: makeBuffer(gl, gl.ARRAY_BUFFER, l.side),
      color: makeBuffer(gl, gl.ARRAY_BUFFER, l.color),
      index: makeBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, l.indices),
      count: l.indices.length,
    };
    const c = data.circle;
    this.circleGpu = {
      center: makeBuffer(gl, gl.ARRAY_BUFFER, c.center),
      corner: makeBuffer(gl, gl.ARRAY_BUFFER, c.corner),
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

    const matrix = composeAnchorMatrix(
      options.modelViewProjectionMatrix as unknown as ArrayLike<number>,
      data.anchorX,
      data.anchorY,
    );
    const viewport: [number, number] = [gl.drawingBufferWidth, gl.drawingBufferHeight];

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this.drawLines(gl, matrix, viewport, data);
    this.drawCircles(gl, matrix, viewport, data);
  }

  private drawLines(
    gl: WebGL2RenderingContext,
    matrix: Float32Array,
    viewport: [number, number],
    data: CustomRenderData,
  ): void {
    const prog = this.lineProgram!;
    const g = this.lineGpu!;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_matrix'), false, matrix);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_viewport'), viewport[0], viewport[1]);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_half_width'), data.lineHalfWidthPx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_aa'), data.aaPx);
    this.bindVec2(gl, prog, 'a_pos_a', g.posA);
    this.bindVec2(gl, prog, 'a_pos_b', g.posB);
    this.bindFloat(gl, prog, 'a_endpoint', g.endpoint);
    this.bindFloat(gl, prog, 'a_side', g.side);
    this.bindColor(gl, prog, 'a_color', g.color);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.index);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
  }

  private drawCircles(
    gl: WebGL2RenderingContext,
    matrix: Float32Array,
    viewport: [number, number],
    data: CustomRenderData,
  ): void {
    const prog = this.circleProgram!;
    const g = this.circleGpu!;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'u_matrix'), false, matrix);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_viewport'), viewport[0], viewport[1]);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_radius'), data.circleRadiusPx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_stroke_width'), data.circleStrokePx);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_aa'), data.aaPx);
    this.bindVec2(gl, prog, 'a_center', g.center);
    this.bindVec2(gl, prog, 'a_corner', g.corner);
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
