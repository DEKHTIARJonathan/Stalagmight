import { useState, useCallback } from 'react';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { OrphanPlacementSuggestion } from '../../types/commands';

interface OrphanPlacementDialogProps {
  suggestions: OrphanPlacementSuggestion[];
}

export default function OrphanPlacementDialog({ suggestions }: OrphanPlacementDialogProps) {
  const { mergeStations, refreshProjectState } = useProjectStore();
  const { closeDialog, setView, triggerFitToBounds } = useUIStore();

  const [processing, setProcessing] = useState(false);
  // Track which suggestions have been accepted/skipped
  const [decided, setDecided] = useState<Set<number>>(new Set());
  const [acceptedOrphans, setAcceptedOrphans] = useState<Set<number>>(new Set());

  const finish = useCallback(async () => {
    await refreshProjectState();
    closeDialog();
    setView('single');
    triggerFitToBounds();
  }, [refreshProjectState, closeDialog, setView, triggerFitToBounds]);

  const handleAccept = useCallback(async (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion) return;

    setProcessing(true);
    try {
      await mergeStations(
        { section_id: suggestion.orphanSectionId, station_index: suggestion.orphanStationIndex },
        { section_id: suggestion.targetSectionId, station_index: suggestion.targetStationIndex },
      );
      // Mark this suggestion and all others for the same orphan end as decided
      const newDecided = new Set(decided);
      const newAcceptedOrphans = new Set(acceptedOrphans);
      newAcceptedOrphans.add(suggestion.orphanSectionId);
      suggestions.forEach((s, i) => {
        if (
          s.orphanSectionId === suggestion.orphanSectionId &&
          s.orphanStationIndex === suggestion.orphanStationIndex
        ) {
          newDecided.add(i);
        }
      });
      // Also invalidate other suggestions targeting the same orphan section
      // (it may no longer be orphaned after this merge)
      suggestions.forEach((s, i) => {
        if (newAcceptedOrphans.has(s.orphanSectionId)) {
          newDecided.add(i);
        }
      });
      setDecided(newDecided);
      setAcceptedOrphans(newAcceptedOrphans);
    } finally {
      setProcessing(false);
    }
  }, [suggestions, decided, acceptedOrphans, mergeStations]);

  const handleSkip = useCallback((index: number) => {
    setDecided((prev) => new Set(prev).add(index));
  }, []);

  const handleAcceptAll = useCallback(async () => {
    setProcessing(true);
    try {
      const processedOrphans = new Set<number>();
      for (let i = 0; i < suggestions.length; i++) {
        if (decided.has(i)) continue;
        const s = suggestions[i]!;
        // Skip if we already accepted a suggestion for this orphan section
        if (processedOrphans.has(s.orphanSectionId)) continue;
        await mergeStations(
          { section_id: s.orphanSectionId, station_index: s.orphanStationIndex },
          { section_id: s.targetSectionId, station_index: s.targetStationIndex },
        );
        processedOrphans.add(s.orphanSectionId);
      }
      await finish();
    } finally {
      setProcessing(false);
    }
  }, [suggestions, decided, mergeStations, finish]);

  const remaining = suggestions.filter((_, i) => !decided.has(i));
  const allDecided = remaining.length === 0;

  // Group by orphan section for display
  const grouped = new Map<string, { suggestion: OrphanPlacementSuggestion; index: number }[]>();
  for (let i = 0; i < suggestions.length; i++) {
    if (decided.has(i)) continue;
    const s = suggestions[i]!;
    const key = `${s.orphanSectionId}-${s.orphanStationIndex}`;
    const list = grouped.get(key) ?? [];
    list.push({ suggestion: s, index: i });
    grouped.set(key, list);
  }

  const confidenceLabel = (c: OrphanPlacementSuggestion['confidence']): string => {
    switch (c) {
      case 'high': return 'High';
      case 'medium': return 'Med';
      case 'low': return 'Low';
      default: return c;
    }
  };

  const confidenceColor = (c: OrphanPlacementSuggestion['confidence']): string => {
    switch (c) {
      case 'high': return 'text-green-400';
      case 'medium': return 'text-yellow-400';
      case 'low': return 'text-text-tertiary';
      default: return '';
    }
  };

  return (
    <DialogWrapper
      title="Connect Orphaned Sections"
      onClose={finish}
      size="lg"
      data-testid="orphan-placement-dialog"
    >
      <div className="space-y-4">
        {!allDecided && (
          <p className="text-sm text-text-secondary">
            Found {remaining.length} potential connection{remaining.length !== 1 ? 's' : ''} for
            orphaned sections:
          </p>
        )}

        {allDecided ? (
          <p className="text-sm text-text-secondary">All suggestions have been processed.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-2">
            {[...grouped.entries()].map(([key, entries]) => (
              <div key={key} className="space-y-1">
                {entries.map(({ suggestion: s, index }) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 border border-border rounded bg-surface-alt"
                    data-testid={`orphan-suggestion-${index}`}
                  >
                    <div className="flex-1 min-w-0 mr-3">
                      <div className="text-sm font-medium truncate">
                        {s.orphanSectionName}
                        <span className="text-text-tertiary font-normal"> stn {s.orphanStationIndex}</span>
                      </div>
                      <div className="text-xs text-text-secondary truncate">
                        &rarr; {s.targetSectionName}
                        <span className="text-text-tertiary"> stn {s.targetStationIndex}</span>
                        <span className="ml-2">
                          ({Math.round(s.score * 100)}%,{' '}
                          <span className={confidenceColor(s.confidence)}>
                            {confidenceLabel(s.confidence)}
                          </span>
                          , {s.matchedShots} shot{s.matchedShots !== 1 ? 's' : ''})
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        data-testid={`orphan-accept-${index}`}
                        onClick={() => handleAccept(index)}
                        disabled={processing}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        data-testid={`orphan-skip-${index}`}
                        onClick={() => handleSkip(index)}
                        disabled={processing}
                      >
                        Skip
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          {!allDecided && (
            <Button
              data-testid="orphan-accept-all"
              onClick={handleAcceptAll}
              disabled={processing}
            >
              Accept All
            </Button>
          )}
          <Button
            data-primary-action=""
            data-testid="orphan-close"
            onClick={finish}
            disabled={processing}
          >
            {allDecided ? 'Close' : 'Skip All'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
