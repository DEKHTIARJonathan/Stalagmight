/**
 * EntityBlob — a round, entity-colored badge that labels an id (or other short
 * text) with the syntactic-highlighting color for its entity type. This is the
 * "Full"-level cue that teaches users which geometry element a row/link refers
 * to (shot = blue, station = green, …).
 *
 * Renders the colored badge only when the highlighting level is "full";
 * otherwise it renders its children as plain text, so callers can wrap an id
 * unconditionally.
 */
import { useUIStore } from '../../store/uiStore';
import type { BlobEntity } from '../../theme/syntacticPalette';
import { syntacticVarName } from '../../theme/syntacticPalette';
import { readableTextColor } from '../../utils/colorContrast';

export interface EntityBlobProps {
  /** Which geometry entity this represents (drives the color). */
  entity: BlobEntity;
  /** The id/label rendered inside the blob. */
  children: React.ReactNode;
  /** Optional tooltip. */
  title?: string;
  /** Extra classes for the badge. */
  className?: string;
  testId?: string;
}

export function EntityBlob({ entity, children, title, className = '', testId }: EntityBlobProps) {
  const level = useUIStore((s) => s.syntacticLevel);
  const color = useUIStore((s) => s.syntacticColors[entity]);

  // Only the Full level paints blobs; otherwise keep the plain text rendering.
  if (level !== 'full') {
    return <>{children}</>;
  }

  const textColor = readableTextColor(color ?? '#000000');

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full px-1.5 min-w-[1.25rem] h-5 text-[11px] font-semibold leading-none tabular-nums ${className}`}
      style={{ backgroundColor: `var(${syntacticVarName(entity)})`, color: textColor }}
      data-entity={entity}
      data-testid={testId}
      title={title}
    >
      {children}
    </span>
  );
}

export default EntityBlob;
