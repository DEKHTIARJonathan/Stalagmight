import { useState, useMemo, useCallback } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { getErrorMessage } from '../../utils/ipc';
import { completeImportToSingleView, deferredSaveWarnings, surfaceImportWarnings } from '../../utils/saveFeedback';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { GpxFile, GpxSectionPlacement } from '../../types/commands';
import { SECTION_COLORS } from '../../utils/colors';
import { setSource } from '../../utils/telemetry';

/**
 * Step 2 dialog for GPX import.
 *
 * Shows track/route sections that need placement configuration.
 * Each section can be configured with a zero datum station.
 * Waypoints are always auto-placed as zero datums and don't appear here.
 */
export default function GpxPlacementDialog() {
  const { executeGpxImport } = useProjectStore();
  const { closeDialog, openDialog, dialogData, setView, triggerFitToBounds } = useUIStore();

  const gpxFile = dialogData.gpxFile as GpxFile;
  const filePath = dialogData.filePath as string;
  const fileHash = dialogData.fileHash as string | null;
  const importWaypoints = dialogData.importWaypoints as boolean;
  const importTracks = dialogData.importTracks as boolean;
  const importRoutes = dialogData.importRoutes as boolean;
  const depthInverted = (dialogData.depthInverted as boolean) ?? false;

  const [isImporting, setIsImporting] = useState(false);

  // Number of waypoint sections that come before track/route sections in the backend index
  const waypointSectionOffset = importWaypoints ? gpxFile.waypoints.length : 0;

  // Build list of sections that need placement config, with GPS point data for building placements
  const sections = useMemo(() => {
    const result: Array<{
      type: 'track' | 'route';
      name: string;
      pointCount: number;
      /** Backend section index (accounts for waypoint sections) */
      backendIndex: number;
      /** GPS coordinates per point for building zero datum placements */
      points: Array<{ latitude: number; longitude: number }>;
    }> = [];

    let idx = waypointSectionOffset;

    if (importTracks) {
      gpxFile.tracks.forEach((trk, ti) => {
        trk.segments.forEach((seg, si) => {
          const name = trk.name
            ? trk.segments.length > 1
              ? `${trk.name} - Seg ${si + 1}`
              : trk.name
            : `Track ${ti + 1}${trk.segments.length > 1 ? ` Seg ${si + 1}` : ''}`;
          result.push({
            type: 'track',
            name,
            pointCount: seg.points.length,
            backendIndex: idx,
            points: seg.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
          });
          idx++;
        });
      });
    }

    if (importRoutes) {
      gpxFile.routes.forEach((rte, ri) => {
        result.push({
          type: 'route',
          name: rte.name ?? `Route ${ri + 1}`,
          pointCount: rte.points.length,
          backendIndex: idx,
          points: rte.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
        });
        idx++;
      });
    }

    return result;
  }, [gpxFile, importTracks, importRoutes, waypointSectionOffset]);

  // Per-section zero datum station index (0 = first station)
  const [zeroDatumIndices, setZeroDatumIndices] = useState<Record<number, number>>(() => {
    const initial: Record<number, number> = {};
    sections.forEach((_, i) => {
      initial[i] = 0;
    });
    return initial;
  });

  const handleZeroDatumChange = useCallback((sectionIdx: number, stationIdx: number) => {
    setZeroDatumIndices((prev) => ({ ...prev, [sectionIdx]: stationIdx }));
  }, []);

  const handleBack = () => {
    setSource('dialog');
    openDialog('gpx-selection', {
      gpxFile,
      filePath,
    });
  };

  const handleImport = async () => {
    setIsImporting(true);

    // Build GpxSectionPlacement objects with proper ImportPlacement zero_datum
    const placements: GpxSectionPlacement[] = sections.map((sec, i) => {
      const stationIdx = zeroDatumIndices[i] ?? 0;
      const point = sec.points[stationIdx] ?? sec.points[0];
      const coords = point
        ? { latitude: point.latitude, longitude: point.longitude, depth_reference: 0 }
        : { latitude: 0, longitude: 0, depth_reference: 0 };

      return {
        section_index: sec.backendIndex,
        placement: {
          type: 'zero_datum' as const,
          coordinates: coords,
          station_index: stationIdx,
        },
        name: null,
        color: SECTION_COLORS[i % SECTION_COLORS.length] ?? '#4A90D9',
      };
    });

    try {
      const result = await executeGpxImport(
        filePath,
        fileHash,
        importWaypoints,
        importTracks,
        importRoutes,
        placements,
        depthInverted
      );

      completeImportToSingleView('gpx-placement', { closeDialog, setView, triggerFitToBounds, openDialog });

      if (!result.success) {
        openDialog('error', {
          title: 'Import Errors',
          message: result.error ?? 'Unknown error during import',
        });
      } else {
        // Partial-success import (deferred save failed) - surface ONLY the
        // "SYSTEM" save-failure warning so the user knows their import is unsaved;
        // routine validation warnings are surfaced elsewhere (#110).
        surfaceImportWarnings(deferredSaveWarnings(result.warnings), openDialog);
      }
    } catch (e) {
      setIsImporting(false);
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to import GPX file'),
      });
    }
  };

  return (
    <DialogWrapper title="GPX Import - Placement" onClose={closeDialog} size="lg" data-testid="gpx-placement-dialog">
      <div className="space-y-4">
        <div className="text-sm text-text-secondary">
          Configure zero datum placement for each track/route section.
          The selected station will be geo-referenced using its GPS coordinates.
        </div>

        {/* Section list */}
        <div className="max-h-80 overflow-y-auto border border-border rounded">
          <table className="w-full text-sm">
            <thead className="bg-surface-alt sticky top-0">
              <tr className="text-left text-text-tertiary text-xs">
                <th className="px-3 py-1.5">Section</th>
                <th className="px-3 py-1.5">Type</th>
                <th className="px-3 py-1.5">Points</th>
                <th className="px-3 py-1.5">Zero Datum Station</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((sec, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-1.5">{sec.name}</td>
                  <td className="px-3 py-1.5 capitalize text-text-secondary">{sec.type}</td>
                  <td className="px-3 py-1.5">{sec.pointCount}</td>
                  <td className="px-3 py-1.5">
                    <select
                      className="text-sm bg-surface border border-border rounded px-1 py-0.5"
                      value={zeroDatumIndices[i] ?? 0}
                      onChange={(e) => handleZeroDatumChange(i, parseInt(e.target.value, 10))}
                    >
                      {Array.from({ length: sec.pointCount }, (_, si) => (
                        <option key={si} value={si}>
                          Station {si}{si === 0 ? ' (first)' : si === sec.pointCount - 1 ? ' (last)' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sections.length === 0 && (
          <div className="text-sm text-text-secondary text-center py-4">
            No track or route sections to configure.
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between pt-4 border-t border-border">
          <Button onClick={handleBack} disabled={isImporting}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button onClick={closeDialog} disabled={isImporting}>
              Cancel
            </Button>
            <Button
              data-primary-action=""
              data-testid="gpx-import-confirm"
              onClick={handleImport}
              disabled={isImporting}
            >
              {isImporting ? 'Importing...' : 'Import'}
            </Button>
          </div>
        </div>
      </div>
    </DialogWrapper>
  );
}
