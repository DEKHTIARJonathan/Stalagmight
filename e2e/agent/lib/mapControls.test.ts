import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalInAppMock = vi.hoisted(() => vi.fn());
vi.mock('./page', () => ({ evalInApp: evalInAppMock }));

import { mapFeatureClick } from './mapControls';
import type { Browser } from 'webdriverio';

function pointerBrowser() {
  return {} as Browser;
}

beforeEach(() => vi.clearAllMocks());

describe('mapFeatureClick', () => {
  it('resolves a semantic shot, clicks the fresh point, and verifies selection', async () => {
    const browser = pointerBrowser();
    evalInAppMock
      .mockResolvedValueOnce({
        featureType: 'shot',
        sectionId: 7,
        shotId: 42,
        lngLat: [1, 2],
        canvasPoint: { x: 20, y: 30 },
        canvasSize: { width: 200, height: 100 },
        point: { x: 120, y: 230 },
        clearancePx: 9.5,
      })
      .mockResolvedValueOnce({ type: 'shot', sectionId: 7, shotId: 42 });

    await expect(mapFeatureClick(browser, { featureType: 'shot', sectionId: 7, shotId: 42 })).resolves.toMatchObject({
      point: { x: 120, y: 230 },
      selectionVerified: true,
    });
    expect(evalInAppMock.mock.calls[0]?.[1]).toContain('__stalagmight_geometry__');
    expect(evalInAppMock.mock.calls[0]?.[1]).toContain('map.fire');
  });

  it('fails when overlapping geometry selects a different feature', async () => {
    const browser = pointerBrowser();
    evalInAppMock
      .mockResolvedValueOnce({
        featureType: 'station',
        sectionId: 3,
        stationIndex: 8,
        lngLat: [1, 2],
        canvasPoint: { x: 20, y: 30 },
        canvasSize: { width: 200, height: 100 },
        point: { x: 120, y: 230 },
        clearancePx: 0,
      })
      .mockResolvedValueOnce({ type: 'station', stationRef: { section_id: 3, station_index: 9 } });

    await expect(
      mapFeatureClick(browser, { featureType: 'station', sectionId: 3, stationIndex: 8 }),
    ).rejects.toThrow('instead of station 3:8');
  });

  it('allows non-selection map tools to skip selection verification', async () => {
    const browser = pointerBrowser();
    evalInAppMock.mockResolvedValueOnce({
      featureType: 'station',
      sectionId: 3,
      stationIndex: 8,
      lngLat: [1, 2],
      canvasPoint: { x: 20, y: 30 },
      canvasSize: { width: 200, height: 100 },
      point: { x: 120, y: 230 },
      clearancePx: 0,
    });

    await expect(
      mapFeatureClick(browser, {
        featureType: 'station',
        sectionId: 3,
        stationIndex: 8,
        button: 'right',
        verifySelection: false,
      }),
    ).resolves.toMatchObject({ selectionVerified: false });
    expect(evalInAppMock).toHaveBeenCalledOnce();
  });
});
