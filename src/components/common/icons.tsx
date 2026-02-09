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
      <line x1="5" y1="5" x2="15" y2="15" />
      <line x1="15" y1="5" x2="5" y2="15" />
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

export function EyeIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
      <circle cx="10" cy="10" r="2.5" />
    </BaseIcon>
  );
}

export function MapIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M3 4 L8 2 L12 4 L17 2 V16 L12 18 L8 16 L3 18 Z" />
      <line x1="8" y1="2" x2="8" y2="16" />
      <line x1="12" y1="4" x2="12" y2="18" />
    </BaseIcon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="10" y1="3" x2="10" y2="11" />
      <polyline points="6 9 10 13 14 9" />
      <rect x="4" y="14" width="12" height="3" rx="1" />
    </BaseIcon>
  );
}

export function FilePlusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M6 2 H12 L16 6 V18 H6 Z" />
      <polyline points="12 2 12 6 16 6" />
      <line x1="10" y1="9" x2="10" y2="15" />
      <line x1="7" y1="12" x2="13" y2="12" />
    </BaseIcon>
  );
}

export function FolderOpenIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M3 6 H8 L10 8 H17 V16 H3 Z" />
      <path d="M3 6 V4 H9 L11 6 Z" />
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
  return (
    <BaseIcon {...props}>
      <rect x="3" y="6" width="14" height="8" rx="1" />
      <line x1="6" y1="6" x2="6" y2="9" />
      <line x1="9" y1="6" x2="9" y2="10" />
      <line x1="12" y1="6" x2="12" y2="9" />
      <line x1="15" y1="6" x2="15" y2="10" />
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
  return (
    <BaseIcon {...props}>
      <path d="M3 8 L10 4 L17 8 L10 12 Z" />
      <path d="M3 12 L10 16 L17 12" />
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
  return (
    <BaseIcon {...props}>
      <path d="M4 4 H16 A1 1 0 0 1 17 5 V13 A1 1 0 0 1 16 14 H8 L5 17 V14 H4 A1 1 0 0 1 3 13 V5 A1 1 0 0 1 4 4 Z" />
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
      {/* Body */}
      <ellipse cx="10" cy="12" rx="4" ry="5" />
      {/* Head */}
      <circle cx="10" cy="6" r="2" />
      {/* Antennae */}
      <line x1="8.5" y1="4.5" x2="6" y2="2" />
      <line x1="11.5" y1="4.5" x2="14" y2="2" />
      {/* Legs */}
      <line x1="6" y1="10" x2="3" y2="8" />
      <line x1="6" y1="13" x2="3" y2="14" />
      <line x1="14" y1="10" x2="17" y2="8" />
      <line x1="14" y1="13" x2="17" y2="14" />
    </BaseIcon>
  );
}
