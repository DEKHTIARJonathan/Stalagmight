import { useUnwindTarget, type ChainDirection } from '../../hooks/useUnwindTarget';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { RedoIcon, UndoIcon } from '../common/icons';

function HistoryStep({ direction }: { direction: ChainDirection }) {
  const editing = useSpeleoStore((s) => s.link?.editState === 'editing');
  const busy = useSpeleoStore((s) => s.busy);
  const canLocal = useProjectStore((s) => direction === 'back' ? s.canUndo : s.canRedo);
  const survey = useUIStore((s) => s.appMode === 'survey');
  const enabled = editing && survey && !canLocal;
  const { target } = useUnwindTarget(enabled, direction);
  return <Button disabled={!enabled || !target || busy} data-testid={`speleodb-history-${direction}`}
    icon={direction === 'back' ? <UndoIcon size={16} /> : <RedoIcon size={16} />}
    onClick={() => {
      if (!target || !enabled) return;
      useUIStore.getState().openDialog('speleodb-unwind', {
        hexsha: target.hexsha, forward: direction === 'forward',
        isCurrent: target.direction === 'back' && target.is_current,
        isLatest: target.direction === 'forward' && target.is_latest,
        discardsUnpushed: target.direction === 'back' && target.discards_unpushed,
      });
    }}>{direction === 'back' ? 'Unwind to previous version' : 'Rewind to next version'}</Button>;
}
export function SpeleoHistorySteps() {
  return <div className="grid gap-2"><HistoryStep direction="back" /><HistoryStep direction="forward" /></div>;
}
