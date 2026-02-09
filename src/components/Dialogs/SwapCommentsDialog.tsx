import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { restoreMoveCommentSource } from '../../utils/toolUtils';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { StationRef, SectionId, ShotId } from '../../types/project';

interface CommentHolder {
  type: 'station' | 'shot';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
  comment: string;
}

async function setComment(
  holder: CommentHolder,
  comment: string | null,
  ps: ReturnType<typeof useProjectStore.getState>,
) {
  if (holder.type === 'station' && holder.stationRef) {
    await ps.updateStationComment(holder.stationRef, comment);
  } else if (holder.type === 'shot' && holder.sectionId !== undefined && holder.shotId !== undefined) {
    await ps.updateShot(holder.sectionId, holder.shotId, { comment });
  }
}

export default function SwapCommentsDialog() {
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const clearMoveCommentSource = useUIStore((s) => s.clearMoveCommentSource);
  const moveCommentSource = useUIStore((s) => s.moveCommentSource);
  const [busy, setBusy] = useState(false);

  const source = dialogData.source as CommentHolder | undefined;
  const target = dialogData.target as CommentHolder | undefined;

  if (!source || !target) return null;

  // Cancel: restore picked-up comment back to source
  const handleCancel = async () => {
    setBusy(true);
    try {
      await restoreMoveCommentSource(moveCommentSource);
      clearMoveCommentSource();
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  // Overwrite: place source's comment on target (source was already cleared on pickup)
  const handleOverwrite = async () => {
    setBusy(true);
    try {
      const ps = useProjectStore.getState();
      await setComment(target, source.comment, ps);
      clearMoveCommentSource();
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  // Swap: place source's comment on target, place target's comment on source
  const handleSwap = async () => {
    setBusy(true);
    try {
      const ps = useProjectStore.getState();
      await setComment(target, source.comment, ps);
      await setComment(source, target.comment, ps);
      clearMoveCommentSource();
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogWrapper title="Move comment" onClose={handleCancel} size="md" data-testid="swap-comments-dialog">
      <div className="space-y-4">
        <div>
          <p className="text-text-secondary text-sm mb-1">Comment being moved:</p>
          <blockquote className="border-l-2 border-accent pl-3 text-text-primary italic">
            {source.comment}
          </blockquote>
        </div>
        <div>
          <p className="text-text-secondary text-sm mb-1">Target already has a comment:</p>
          <blockquote className="border-l-2 border-warning pl-3 text-text-primary italic">
            {target.comment}
          </blockquote>
        </div>
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={handleOverwrite} disabled={busy} data-testid="swap-overwrite">
            Overwrite
          </Button>
          <Button variant="primary" onClick={handleSwap} disabled={busy} data-primary-action="" data-testid="swap-swap">
            Swap
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
