import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { MessageIcon } from '../common/icons';

/**
 * Lightweight overlay that shows the picked-up comment text following the cursor
 * while the move_comment tool has a source selected.
 * Uses a pointer event listener on document to avoid coupling into MapCanvas's mouse handler.
 */
export default function MoveCommentCursorTag() {
  const moveCommentSource = useUIStore((s) => s.moveCommentSource);
  // Initialize position from the pickup click so the tag appears immediately
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!moveCommentSource) {
      setPos(null);
      return;
    }

    // Seed position from the click that picked up the comment
    if (moveCommentSource.screenPos) {
      setPos(moveCommentSource.screenPos);
    }

    const handlePointerMove = (e: PointerEvent) => {
      // Throttle to animation frame to avoid excessive re-renders
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setPos({ x: e.clientX, y: e.clientY });
      });
    };

    document.addEventListener('pointermove', handlePointerMove);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      cancelAnimationFrame(rafRef.current);
    };
  }, [moveCommentSource]);

  if (!moveCommentSource || !pos) return null;

  // Truncate long comments for display
  const text = moveCommentSource.comment.length > 40
    ? moveCommentSource.comment.slice(0, 37) + '...'
    : moveCommentSource.comment;

  return (
    <div
      className="fixed z-50 pointer-events-none flex items-center gap-1.5 bg-panel border border-border rounded-lg px-2 py-1 text-xs text-text-primary shadow-lg max-w-[200px]"
      style={{
        left: pos.x + 14,
        top: pos.y + 14,
      }}
      data-testid="move-comment-cursor-tag"
    >
      <MessageIcon size={12} />
      <span className="truncate italic">{text}</span>
    </div>
  );
}
