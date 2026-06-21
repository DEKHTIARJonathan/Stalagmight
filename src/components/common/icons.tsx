import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  title?: string;
}

function BaseIcon({
  size = 16,
  title,
  className,
  children,
  ...props
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

function BaseIcon24({
  size = 16,
  title,
  className,
  children,
  ...props
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function SelectToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M5 3L13 17L14 11L19 10Z" />
      <rect x="15" y="15" width="6" height="6" strokeDasharray="2 1.5" fill="none" />
    </BaseIcon24>
  );
}

export function PanToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M8 13V6.5A1 1 0 0 1 10 6.5V12" />
      <path d="M10 12V4.5A1 1 0 0 1 12 4.5V12" />
      <path d="M12 12V5.5A1 1 0 0 1 14 5.5V12" />
      <path d="M14 12V7.5A1 1 0 0 1 16 7.5V14" />
      <path d="M8 13L6.5 15.5A4 4 0 0 0 10 20H14A4 4 0 0 0 18 16V14" />
    </BaseIcon24>
  );
}

export function ZoomToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <circle cx="10" cy="10" r="6" />
      <line x1="14.5" y1="14.5" x2="20" y2="20" strokeWidth="2" />
      <line x1="10" y1="7.5" x2="10" y2="12.5" />
      <line x1="7.5" y1="10" x2="12.5" y2="10" />
    </BaseIcon24>
  );
}

export function MergeToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <circle cx="4" cy="8" r="2.5" />
      <circle cx="4" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4" cy="16" r="2.5" />
      <circle cx="4" cy="16" r="0.8" fill="currentColor" stroke="none" />
      <path d="M7 8L15 12" />
      <path d="M7 16L15 12" />
      <path d="M13 10L16 12L13 14" fill="none" />
      <circle cx="19" cy="12" r="2.5" />
      <circle cx="19" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </BaseIcon24>
  );
}

export function MeasureToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <rect x="2" y="8" width="20" height="8" rx="1" />
      <line x1="6" y1="8" x2="6" y2="11" />
      <line x1="10" y1="8" x2="10" y2="12.5" />
      <line x1="14" y1="8" x2="14" y2="11" />
      <line x1="18" y1="8" x2="18" y2="12.5" />
    </BaseIcon24>
  );
}

export function CommentToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M5 4H19A1 1 0 0 1 20 5V15A1 1 0 0 1 19 16H10L6 20V16H5A1 1 0 0 1 4 15V5A1 1 0 0 1 5 4Z" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="13" y2="12" />
    </BaseIcon24>
  );
}

export function MoveCommentToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M4 4H14A1 1 0 0 1 15 5V12A1 1 0 0 1 14 13H8L5 16V13H4A1 1 0 0 1 3 12V5A1 1 0 0 1 4 4Z" />
      <line x1="6" y1="8" x2="12" y2="8" />
      <line x1="17" y1="10" x2="21" y2="14" />
      <path d="M18 14L21 14L21 11" fill="none" />
    </BaseIcon24>
  );
}

export function MoveStationToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M12 2L14 5H10L12 2Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M12 22L10 19H14L12 22Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M2 12L5 10V14L2 12Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M22 12L19 14V10L22 12Z" fill="currentColor" stroke="none" opacity="0.55" />
      <rect x="11" y="5" width="2" height="14" fill="currentColor" stroke="none" opacity="0.25" />
      <rect x="5" y="11" width="14" height="2" fill="currentColor" stroke="none" opacity="0.25" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </BaseIcon24>
  );
}

export function MoveShotToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M12 2L14 5H10L12 2Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M12 22L10 19H14L12 22Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M2 12L5 10V14L2 12Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M22 12L19 14V10L22 12Z" fill="currentColor" stroke="none" opacity="0.55" />
      <rect x="11" y="5" width="2" height="14" fill="currentColor" stroke="none" opacity="0.25" />
      <rect x="5" y="11" width="14" height="2" fill="currentColor" stroke="none" opacity="0.25" />
      <line x1="7" y1="17" x2="17" y2="7" />
      <circle cx="7" cy="17" r="2" />
      <circle cx="17" cy="7" r="2" />
    </BaseIcon24>
  );
}

export function MoveSegmentToolIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M12 2L14 5H10L12 2Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M12 22L10 19H14L12 22Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M2 12L5 10V14L2 12Z" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M22 12L19 14V10L22 12Z" fill="currentColor" stroke="none" opacity="0.55" />
      <rect x="11" y="5" width="2" height="14" fill="currentColor" stroke="none" opacity="0.25" />
      <rect x="5" y="11" width="14" height="2" fill="currentColor" stroke="none" opacity="0.25" />
      <path d="M7 17L12 10L17 14L20 9" />
      <path d="M12 10L9 7" />
      <circle cx="7" cy="17" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="9" cy="7" r="1.5" fill="currentColor" stroke="none" />
    </BaseIcon24>
  );
}

export function FitToViewIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path d="M3 8V4A1 1 0 0 1 4 3H8" fill="none" />
      <path d="M16 3H20A1 1 0 0 1 21 4V8" fill="none" />
      <path d="M21 16V20A1 1 0 0 1 20 21H16" fill="none" />
      <path d="M8 21H4A1 1 0 0 1 3 20V16" fill="none" />
      <line x1="9" y1="9" x2="5" y2="5" />
      <line x1="15" y1="9" x2="19" y2="5" />
      <line x1="15" y1="15" x2="19" y2="19" />
      <line x1="9" y1="15" x2="5" y2="19" />
    </BaseIcon24>
  );
}

export function CenterMapIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <circle cx="12" cy="12" r="8" />
      <line x1="12" y1="2" x2="12" y2="7" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <line x1="2" y1="12" x2="7" y2="12" />
      <line x1="17" y1="12" x2="22" y2="12" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </BaseIcon24>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="6 8 10 12 14 8" />
    </BaseIcon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="6 12 10 8 14 12" />
    </BaseIcon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="12 6 8 10 12 14" />
    </BaseIcon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="8 6 12 10 8 14" />
    </BaseIcon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="4" y1="10" x2="16" y2="10" />
      <polyline points="8 6 4 10 8 14" />
    </BaseIcon>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="5" y1="15" x2="15" y2="5" />
      <polyline points="10 5 15 5 15 10" />
    </BaseIcon>
  );
}

// "External link" / open-out icon: a box with an arrow breaking out of the
// open top-right corner. The arrowhead's two arms are collinear with the box's
// top and right edges (aligned with the square), with a gap so the shapes stay
// distinct. Used as the section focus-mode entry affordance.
export function ExternalLinkIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M8 5 H5 a2 2 0 0 0 -2 2 V15 a2 2 0 0 0 2 2 H13 a2 2 0 0 0 2 -2 V12" />
      <polyline points="11 5 15 5 15 9" />
      <line x1="9" y1="11" x2="15" y2="5" />
    </BaseIcon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="10" y1="4" x2="10" y2="16" />
      <line x1="4" y1="10" x2="16" y2="10" />
    </BaseIcon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="4" y1="10" x2="16" y2="10" />
    </BaseIcon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path fill="currentColor" stroke="none" d="M4.33 5.67 L5.67 4.33 L15.67 14.33 L14.33 15.67 Z" />
      <path fill="currentColor" stroke="none" d="M15.67 5.67 L14.33 4.33 L4.33 14.33 L5.67 15.67 Z" />
    </BaseIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="4 10 8 14 16 6" />
    </BaseIcon>
  );
}

export function CircleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="10" cy="10" r="6" />
    </BaseIcon>
  );
}

export function DotIcon(props: IconProps) {
  return (
    <BaseIcon {...props} fill="currentColor" stroke="none">
      <circle cx="10" cy="10" r="2.5" />
    </BaseIcon>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="10" cy="10" r="7" />
      <polyline points="6 10 9 13 14 7" />
    </BaseIcon>
  );
}

export function XCircleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="10" cy="10" r="7" />
      <line x1="7" y1="7" x2="13" y2="13" />
      <line x1="13" y1="7" x2="7" y2="13" />
    </BaseIcon>
  );
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M10 3 L18 17 H2 Z" />
      <line x1="10" y1="8" x2="10" y2="12" />
      <circle cx="10" cy="14.5" r="0.8" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function AlertCircleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="10" cy="10" r="7" />
      <line x1="10" y1="6" x2="10" y2="11" />
      <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function DatabaseIcon(props: IconProps) {
  return (
    <BaseIcon24 {...props}>
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M3 5 C3 2.8 7.03 1 12 1 C16.97 1 21 2.8 21 5 L21 19 C21 21.2 16.97 23 12 23 C7.03 23 3 21.2 3 19 Z M4.95 5.6 C4.95 4.05 8.21 2.8 12 2.8 C15.79 2.8 19.05 4.05 19.05 5.6 L19.05 18.4 C19.05 19.95 15.79 21.2 12 21.2 C8.21 21.2 4.95 19.95 4.95 18.4 Z" />
      <path fill="currentColor" stroke="none" d="M3.3 10.4 C5.1 12 8.3 13 12 13 C15.7 13 18.9 12 20.7 10.4 C18.9 13.4 15.7 14.9 12 14.9 C8.3 14.9 5.1 13.4 3.3 10.4 Z" />
    </BaseIcon24>
  );
}

export function EyeIcon(props: IconProps) {
  // Filled (lens band knocked out via evenodd + filled pupil) rather than
  // stroked, so it holds weight at any UI scale (WebKit fattens thin strokes
  // under page-zoom; fills rasterize cleanly).
  return (
    <BaseIcon {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        stroke="none"
        d="M2 10 C2 10 5 5 10 5 C15 5 18 10 18 10 C18 10 15 15 10 15 C5 15 2 10 2 10 Z M3.9 10 C3.9 10 6.34 6.34 10 6.9 C13.66 6.34 16.1 10 16.1 10 C16.1 10 13.66 13.66 10 13.1 C6.34 13.66 3.9 10 3.9 10 Z"
      />
      <circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function MapIcon(props: IconProps) {
  // Hollow folded-map outline (band) + the two fold creases, rendered as fills.
  return (
    <BaseIcon {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        stroke="none"
        d="M3 4 L8 2 L12 4 L17 2 V16 L12 18 L8 16 L3 18 Z M4.44 5.24 L8.46 3.84 L11.4 5.8 L15.75 3.43 L15.56 14.76 L11.54 16.16 L8.6 14.2 L4.25 16.57 Z"
      />
      <path
        fill="currentColor"
        stroke="none"
        d="M7.05 4.3 H8.95 V13.8 H7.05 Z M11.05 6.3 H12.95 V15.8 H11.05 Z"
      />
    </BaseIcon>
  );
}

export function DownloadIcon(props: IconProps) {
  // Faithful outline download (shaft bar + chevron band + tray frame) as fills,
  // so it keeps weight at any UI scale (WebKit fattens thin strokes at zoom).
  return (
    <BaseIcon {...props}>
      <path fill="currentColor" stroke="none" d="M9.05 3 H10.95 V11.5 H9.05 Z" />
      <path fill="currentColor" stroke="none" d="M6 9 L10 13 L14 9 L12.3 7.85 L10 11.1 L7.7 7.85 Z" />
      <rect x="4" y="15.05" width="12" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function FilePlusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M6 2 H12 L16 6 V18 H6 Z M7.9 3.9 H12 L14.1 6 V16.1 H7.9 Z" />
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M12 2 L12 6 L16 6 L16 4.4 L14 2.4 Z M14.1 4.4 L14.1 4.9 L12.9 4.9 L12.9 4.4 Z" />
      <rect x="9.05" y="9" width="1.9" height="6" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="7" y="11.05" width="6" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function FolderOpenIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M3 5 H8 L10 7 H17 V16 H3 Z M4.9 6.9 H7.5 L9.5 8.9 H15.1 V14.1 H4.9 Z" />
    </BaseIcon>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 14 L5 10 L12 3 L16 7 L9 14 Z" />
      <line x1="11" y1="4" x2="15" y2="8" />
    </BaseIcon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="3 6 17 6" />
      <rect x="5" y="6" width="10" height="11" rx="1" />
      <line x1="8" y1="9" x2="8" y2="15" />
      <line x1="12" y1="9" x2="12" y2="15" />
      <line x1="7" y1="4" x2="13" y2="4" />
    </BaseIcon>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M8 12 L6 14 A3 3 0 0 1 2 10 L4 8" />
      <path d="M12 8 L14 6 A3 3 0 0 1 18 10 L16 12" />
      <line x1="7" y1="13" x2="13" y2="7" />
    </BaseIcon>
  );
}

export function LinkOffIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M8 12 L6 14 A3 3 0 0 1 2 10 L4 8" />
      <path d="M12 8 L14 6 A3 3 0 0 1 18 10 L16 12" />
      <line x1="6" y1="6" x2="14" y2="14" />
    </BaseIcon>
  );
}

export function RulerIcon(props: IconProps) {
  // Hollow ruler frame (outline) + tick marks, rendered as fills.
  return (
    <BaseIcon {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        stroke="none"
        d="M4 6 H16 A1 1 0 0 1 17 7 V13 A1 1 0 0 1 16 14 H4 A1 1 0 0 1 3 13 V7 A1 1 0 0 1 4 6 Z M4.9 7.9 H15.1 V12.1 H4.9 Z"
      />
      <path
        fill="currentColor"
        stroke="none"
        d="M5.05 6 H6.95 V9.3 H5.05 Z M8.05 6 H9.95 V10.3 H8.05 Z M11.05 6 H12.95 V9.3 H11.05 Z M14.05 6 H15.95 V10.3 H14.05 Z"
      />
    </BaseIcon>
  );
}

export function MoveHorizontalIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="4" y1="10" x2="16" y2="10" />
      <polyline points="6 8 4 10 6 12" />
      <polyline points="14 8 16 10 14 12" />
    </BaseIcon>
  );
}

export function MoveDiagonalIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="5" y1="15" x2="15" y2="5" />
      <polyline points="11 5 15 5 15 9" />
      <polyline points="9 15 5 15 5 11" />
    </BaseIcon>
  );
}

// Fullscreen enter/exit pair (data-table fullscreen mode): two diagonal arrows
// pointing out of (Expand) or into (Shrink) the corners.
export function ExpandIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="11" y1="9" x2="16" y2="4" />
      <polyline points="12 4 16 4 16 8" />
      <line x1="9" y1="11" x2="4" y2="16" />
      <polyline points="8 16 4 16 4 12" />
    </BaseIcon>
  );
}

export function ShrinkIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="16" y1="4" x2="11" y2="9" />
      <polyline points="11 5 11 9 15 9" />
      <line x1="4" y1="16" x2="9" y2="11" />
      <polyline points="9 15 9 11 5 11" />
    </BaseIcon>
  );
}

export function MoveAllIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="10" y1="3" x2="10" y2="17" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <polyline points="8 5 10 3 12 5" />
      <polyline points="8 15 10 17 12 15" />
      <polyline points="5 8 3 10 5 12" />
      <polyline points="15 8 17 10 15 12" />
    </BaseIcon>
  );
}

export function CursorIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 3 L12 15 L13 10 L17 9 Z" />
    </BaseIcon>
  );
}

export function HandIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M6 9 V4 A1 1 0 0 1 8 4 V9" />
      <path d="M8 9 V3 A1 1 0 0 1 10 3 V9" />
      <path d="M10 9 V4 A1 1 0 0 1 12 4 V9" />
      <path d="M12 9 V5 A1 1 0 0 1 14 5 V11" />
      <path d="M6 9 L5 11 A3 3 0 0 0 8 15 H12 A3 3 0 0 0 15 12 V11" />
    </BaseIcon>
  );
}

export function MagnifierIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="8" cy="8" r="4" />
      <line x1="11" y1="11" x2="16" y2="16" />
    </BaseIcon>
  );
}

export function LayersIcon(props: IconProps) {
  // Hollow top diamond (outline band) + a chevron band hinting the layer below.
  return (
    <BaseIcon {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        stroke="none"
        d="M3 8 L10 4 L17 8 L10 12 Z M4.9 8 L10 5.9 L15.1 8 L10 10.1 Z"
      />
      <path
        fill="currentColor"
        stroke="none"
        d="M3 12 L10 16 L17 12 L15.2 11.2 L10 14.1 L4.8 11.2 Z"
      />
    </BaseIcon>
  );
}

export function TargetIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="10" cy="10" r="6" />
      <circle cx="10" cy="10" r="2" />
    </BaseIcon>
  );
}

export function DashedLineIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="3" y1="10" x2="17" y2="10" strokeDasharray="2 2" />
    </BaseIcon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="5" y="9" width="10" height="8" rx="1" />
      <path d="M7 9V6a3 3 0 0 1 6 0v3" fill="none" />
    </BaseIcon>
  );
}

export function MessageIcon(props: IconProps) {
  // Hollow speech-bubble outline (band), rendered as a fill.
  return (
    <BaseIcon {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        stroke="none"
        d="M4 4 H16 A1 1 0 0 1 17 5 V13 A1 1 0 0 1 16 14 H8 L5 17 V14 H4 A1 1 0 0 1 3 13 V5 A1 1 0 0 1 4 4 Z M5.4 5.9 H14.6 A0.5 0.5 0 0 1 15.1 6.4 V11.6 A0.5 0.5 0 0 1 14.6 12.1 H8.2 L6.4 13.9 V12.1 H5.4 A0.5 0.5 0 0 1 4.9 11.6 V6.4 A0.5 0.5 0 0 1 5.4 5.9 Z"
      />
    </BaseIcon>
  );
}

export function MoveCommentIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      {/* Speech bubble */}
      <path d="M3 4 H12 A1 1 0 0 1 13 5 V10 A1 1 0 0 1 12 11 H7 L5 13 V11 H3 A1 1 0 0 1 2 10 V5 A1 1 0 0 1 3 4 Z" />
      {/* Arrow pointing right */}
      <line x1="14" y1="8" x2="18" y2="8" />
      <polyline points="16 6 18 8 16 10" />
    </BaseIcon>
  );
}

export function BugIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      {/* Body (band) */}
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M10 7 A4 5 0 1 1 10 17 A4 5 0 1 1 10 7 Z M10 8.9 A2.1 3.1 0 1 0 10 15.1 A2.1 3.1 0 1 0 10 8.9 Z" />
      {/* Head (band) */}
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M10 4 A2 2 0 1 1 10 8 A2 2 0 1 1 10 4 Z M10 5.5 A0.5 0.5 0 1 0 10 6.5 A0.5 0.5 0 1 0 10 5.5 Z" />
      {/* Antennae + legs (bars) */}
      <path fill="currentColor" stroke="none" d="M8.84 4.84 L9.16 4.16 L6.34 1.66 L5.66 2.34 Z" />
      <path fill="currentColor" stroke="none" d="M11.16 4.84 L10.84 4.16 L13.66 1.66 L14.34 2.34 Z" />
      <path fill="currentColor" stroke="none" d="M6.4 10.79 L5.6 9.21 L2.6 7.21 L3.4 8.79 Z" />
      <path fill="currentColor" stroke="none" d="M6.4 12.21 L5.6 13.79 L2.6 14.79 L3.4 13.21 Z" />
      <path fill="currentColor" stroke="none" d="M13.6 10.79 L14.4 9.21 L17.4 7.21 L16.6 8.79 Z" />
      <path fill="currentColor" stroke="none" d="M13.6 12.21 L14.4 13.79 L17.4 14.79 L16.6 13.21 Z" />
    </BaseIcon>
  );
}

export function MenuIcon(props: IconProps) {
  // Filled bars (not strokes) so the icon keeps a consistent weight at any UI
  // scale — WebKit/WKWebView render thin strokes heavy under page-zoom, but
  // fills rasterize cleanly. Matches the duotone glyphs' filled base.
  return (
    <BaseIcon {...props}>
      <rect x="3" y="4.05" width="14" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="3" y="9.05" width="14" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="3" y="14.05" width="14" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M10 6.1 A3.9 3.9 0 1 1 10 13.9 A3.9 3.9 0 1 1 10 6.1 M10 8 A2 2 0 1 0 10 12 A2 2 0 1 0 10 8" />
      <rect x="9.05" y="2" width="1.9" height="2.5" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="9.05" y="15.5" width="1.9" height="2.5" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="2" y="9.05" width="2.5" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="15.5" y="9.05" width="2.5" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <path fill="currentColor" stroke="none" d="M3.63 4.97 L5.03 3.57 L6.43 4.97 L5.03 6.37 Z" />
      <path fill="currentColor" stroke="none" d="M13.57 14.97 L14.97 13.57 L16.37 14.97 L14.97 16.37 Z" />
      <path fill="currentColor" stroke="none" d="M3.63 15.03 L5.03 16.43 L6.43 15.03 L5.03 13.63 Z" />
      <path fill="currentColor" stroke="none" d="M13.57 5.03 L14.97 6.43 L16.37 5.03 L14.97 3.63 Z" />
    </BaseIcon>
  );
}

export function QuitIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      {/* Power glyph: ring (band) with a top gap + a vertical stem */}
      <path fill="currentColor" stroke="none" d="M6 5 A6 6 0 1 0 14 5 L12.74 6.45 A4.1 4.1 0 1 1 7.26 6.45 Z" />
      <rect x="9.05" y="2" width="1.9" height="7" rx="0.95" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="6.95" y="4.05" width="10.1" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="6.95" y="9.05" width="10.1" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="6.95" y="14.05" width="10.1" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <circle cx="3.25" cy="5" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="3.25" cy="10" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="3.25" cy="15" r="0.95" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function SaveIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      {/* Floppy disk */}
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M4 4 H13 L16 7 V16 H4 Z M5.45 5.1 H12.33 L14.73 7.4 V14.9 H5.45 Z" />
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M6 4 H12 V8 H6 Z M7.45 5.1 H10.55 V6.9 H7.45 Z" />
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M6 11 H14 V16 H6 Z M7.45 12.45 H12.55 V14.55 H7.45 Z" />
    </BaseIcon>
  );
}

export function ExportIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      {/* Box with an arrow leaving upward */}
      <path fill="currentColor" stroke="none" d="M9.05 4.5 H10.95 V13 H9.05 Z" />
      <path fill="currentColor" stroke="none" d="M6 8 L10 4 L14 8 L12.3 9.15 L10 5.9 L7.7 9.15 Z" />
      <path fill="currentColor" stroke="none" d="M4 12 L4 16 L16 16 L16 12 L14.1 12 L14.1 14.1 L5.9 14.1 L5.9 12 Z" />
    </BaseIcon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path fillRule="evenodd" fill="currentColor" stroke="none" d="M10 3 A7 7 0 1 1 10 17 A7 7 0 1 1 10 3 M10 4.9 A5.1 5.1 0 1 0 10 15.1 A5.1 5.1 0 1 0 10 4.9" />
      <rect x="9.05" y="9.05" width="1.9" height="5" rx="0.95" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6.55" r="0.95" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function SlidersIcon(props: IconProps) {
  // Filled tracks + knobs.
  return (
    <BaseIcon {...props}>
      <rect x="3" y="5.05" width="14" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <rect x="3" y="13.05" width="14" height="1.9" rx="0.95" fill="currentColor" stroke="none" />
      <circle cx="8" cy="6" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="13" cy="14" r="2.5" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}
