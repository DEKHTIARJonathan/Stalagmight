/**
 * Global View map: what the arrow-key navigation and the marker tooltips read.
 *
 * - #576 NF-W3UI-4: `getSystemCentroids` (the arrow keys' system positions)
 *   indexed every shot endpoint unguarded. The geometry is IPC data typed as
 *   `Array<number>` and the default props were untyped Maps, so nothing checked
 *   it: one endpoint without two finite numbers turned the system's centroid into
 *   NaN, and arrow-key navigation could never reach that system.
 *
 * Component tier: the real GlobalViewMap, with maplibre-gl and the WebGL survey
 * layer replaced by fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';

const h = vi.hoisted(() => {
  type Handler = (e?: unknown) => void;
  const state = { map: null as FakeMap | null };
  class FakeMap {
    private handlers = new Map<string, Set<Handler>>();
    private container: HTMLElement;
    dragRotate = { disable() {} };
    touchPitch = { disable() {} };
    touchZoomRotate = { disableRotation() {} };
    keyboard = { disable() {} };
    doubleClickZoom = { disable() {} };
    constructor(opts: { container: HTMLElement }) {
      this.container = opts.container;
      state.map = this;
    }
    addControl() {}
    on(ev: string, fn: Handler) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(fn);
    }
    off(ev: string, fn: Handler) {
      this.handlers.get(ev)?.delete(fn);
    }
    once() {}
    fire(ev: string) {
      for (const fn of [...(this.handlers.get(ev) ?? [])]) fn({});
    }
    getBounds() {
      return { contains: () => true, getCenter: () => ({ lng: 0, lat: 0 }) };
    }
    getCenter() {
      return { lng: 0, lat: 0 };
    }
    getZoom() {
      return 10;
    }
    getContainer() {
      return this.container;
    }
    getCanvas() {
      return document.createElement('canvas');
    }
    getSource() {
      return undefined;
    }
    fitBounds() {}
    easeTo() {}
    flyTo() {}
    setMaxBounds() {}
    setMinZoom() {}
    triggerRepaint() {}
    remove() {}
  }
  class FakeMarker {
    private el: HTMLElement;
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element;
    }
    setLngLat() {
      return this;
    }
    addTo() {
      document.body.appendChild(this.el);
      return this;
    }
    remove() {
      this.el.remove();
    }
    getElement() {
      return this.el;
    }
  }
  class FakePopup {
    setLngLat() {
      return this;
    }
    setDOMContent() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  class FakeBounds {
    constructor(
      private sw: [number, number],
      private ne: [number, number]
    ) {}
    getSouthWest() {
      return { lng: this.sw[0], lat: this.sw[1] };
    }
    getNorthEast() {
      return { lng: this.ne[0], lat: this.ne[1] };
    }
    getCenter() {
      return { lng: (this.sw[0] + this.ne[0]) / 2, lat: (this.sw[1] + this.ne[1]) / 2 };
    }
  }
  class Noop {}
  return { state, FakeMap, FakeMarker, FakePopup, FakeBounds, Noop };
});

vi.mock('maplibre-gl', () => ({
  default: {
    Map: h.FakeMap,
    Marker: h.FakeMarker,
    Popup: h.FakePopup,
    LngLatBounds: h.FakeBounds,
    NavigationControl: h.Noop,
    ScaleControl: h.Noop,
  },
}));
vi.mock('../GlobalSurveyLayer', () => ({
  default: class {
    update() {}
    setVisible() {}
    setSelectedSystems() {}
    applyThemeColors() {}
    setPrecision() {}
    setSearchFilter() {}
    destroy() {}
  },
  generateSystemColor: () => '#336699',
}));
vi.mock('../../../utils/ipc', () => ({ invokeIpc: vi.fn(async () => undefined) }));

import GlobalViewMap, { type GlobalViewMapHandle } from '../GlobalViewMap';
import type { ProjectMetadata } from '../../../types/project';
import type { SurveyGeometry } from '../../../types/survey';

const project = (file_path: string, gps_center: [number, number]): ProjectMetadata =>
  ({
    file_path,
    name: file_path.slice(7, -6),
    gps_center,
    total_length: 1234.5678,
    station_count: 10,
  }) as unknown as ProjectMetadata;

const shot = (from: number[], to: number[]) => ({ from, to, kind: 'Normal', section_id: 1 });

beforeEach(() => {
  h.state.map = null;
  try {
    localStorage.clear();
  } catch {
    // jsdom storage may be unavailable; the view mode then defaults to survey.
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Global View system centroids (#576 NF-W3UI-4)', () => {
  it('skips endpoints without two finite coordinates instead of turning the centroid into NaN', () => {
    const A = '/caves/CaveA.stalx';
    const B = '/caves/CaveB.stalx';
    const geometry = new Map<string, SurveyGeometry>([
      // Two good endpoints, one empty and one NaN endpoint.
      [A, { origin: [10, 20], shots: [shot([10, 20], [11, 21]), shot([], [Number.NaN, 5])] } as unknown as SurveyGeometry],
      // Nothing usable at all: fall back to the system's GPS center.
      [B, { origin: [30, 40], shots: [shot([1], [Number.POSITIVE_INFINITY, 2])] } as unknown as SurveyGeometry],
    ]);
    const ref = createRef<GlobalViewMapHandle>();
    render(
      <GlobalViewMap
        ref={ref}
        projects={[project(A, [10.4, 20.4]), project(B, [30, 40])]}
        selectedProjectId={null}
        onProjectSelect={() => {}}
        onProjectOpen={() => {}}
        geometryData={geometry}
      />
    );
    act(() => h.state.map?.fire('load'));
    const centroids = ref.current!.getSystemCentroids();
    expect(centroids.get(A)).toEqual([10.5, 20.5]);
    expect(centroids.get(B)).toEqual([30, 40]);
  });
});
