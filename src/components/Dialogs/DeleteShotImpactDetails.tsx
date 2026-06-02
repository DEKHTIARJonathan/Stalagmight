import type { DeleteShotImpact } from '../../types/commands';
import type { StationRef } from '../../types/project';

function formatStationRef(station: StationRef): string {
  return `${station.section_id}:${station.station_index}`;
}

function formatPair(a: StationRef, b: StationRef): string {
  return `${formatStationRef(a)} <-> ${formatStationRef(b)}`;
}

export default function DeleteShotImpactDetails({
  impact,
  title = 'This deletion will update station relationships:',
}: {
  impact: DeleteShotImpact | null;
  title?: string;
}) {
  if (!impact) return null;

  const hasDetails =
    impact.removed_merges.length > 0 ||
    impact.removed_closures.length > 0 ||
    impact.replacement_merges.length > 0 ||
    impact.replacement_closure_updates.length > 0 ||
    impact.closure_to_merge.length > 0 ||
    impact.merge_rewire_skipped ||
    impact.closure_rewire_skipped;

  if (!hasDetails) return null;

  return (
    <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm space-y-2">
      <p className="font-medium text-warning">{title}</p>
      <div className="space-y-2 text-text-secondary">
        {impact.removed_merges.length > 0 && (
          <div>
            <p className="font-medium">Removed merges</p>
            <ul className="list-disc list-inside">
              {impact.removed_merges.map((pair, index) => (
                <li key={`removed-merge-${index}`}>{formatPair(pair.station_a, pair.station_b)}</li>
              ))}
            </ul>
          </div>
        )}

        {impact.removed_closures.length > 0 && (
          <div>
            <p className="font-medium">Removed closures</p>
            <ul className="list-disc list-inside">
              {impact.removed_closures.map((closure) => {
                const closureId = closure.closure_id.toString();
                return (
                  <li key={`removed-closure-${closureId}`}>
                    #{closureId}: {formatPair(closure.station_a, closure.station_b)}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {impact.replacement_merges.length > 0 && (
          <div>
            <p className="font-medium">Replacement merges</p>
            <ul className="list-disc list-inside">
              {impact.replacement_merges.map((pair, index) => (
                <li key={`replacement-merge-${index}`}>{formatPair(pair.station_a, pair.station_b)}</li>
              ))}
            </ul>
          </div>
        )}

        {impact.replacement_closure_updates.length > 0 && (
          <div>
            <p className="font-medium">Replacement closures</p>
            <ul className="list-disc list-inside">
              {impact.replacement_closure_updates.map((update) => {
                const closureId = update.closure_id.toString();
                return (
                  <li key={`replacement-closure-${closureId}`}>
                    #{closureId}: {formatStationRef(update.old_station)} {'->'} {formatStationRef(update.new_station)}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {impact.closure_to_merge.length > 0 && (
          <div>
            <p className="font-medium">Closures becoming merges</p>
            <ul className="list-disc list-inside">
              {impact.closure_to_merge.map((pair, index) => (
                <li key={`closure-to-merge-${index}`}>{formatPair(pair.station_a, pair.station_b)}</li>
              ))}
            </ul>
          </div>
        )}

        {(impact.merge_rewire_skipped || impact.closure_rewire_skipped) && (
          <div className="text-warning">
            {impact.merge_rewire_skipped && (
              <p>Some merge connectivity could not be preserved (only same-section candidates).</p>
            )}
            {impact.closure_rewire_skipped && (
              <p>Some closures could not be replaced (no valid replacement or duplicate).</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
