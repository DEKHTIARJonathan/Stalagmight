interface HelpTooltipProps {
  text: string;
  className?: string;
  iconClassName?: string;
  tooltipClassName?: string;
  iconTestId?: string;
  tooltipTestId?: string;
}

/**
 * Small themed tooltip trigger used for inline "?" help affordances.
 * Hover-only behavior keeps interaction simple and consistent with existing UX.
 */
export function HelpTooltip({
  text,
  className = '',
  iconClassName = '',
  tooltipClassName = '',
  iconTestId,
  tooltipTestId,
}: HelpTooltipProps) {
  return (
    <span className={`relative inline-flex items-center group ${className}`}>
      <span
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full border border-border text-[10px] font-bold text-text-secondary cursor-help ${iconClassName}`}
        aria-label={text}
        role="img"
        data-testid={iconTestId}
      >
        ?
      </span>
      <span
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-20 whitespace-nowrap rounded border border-border bg-panel-90 text-text-primary text-xs px-2 py-1 opacity-0 invisible transition-opacity duration-100 group-hover:opacity-100 group-hover:visible ${tooltipClassName}`}
        role="tooltip"
        data-testid={tooltipTestId}
      >
        {text}
      </span>
    </span>
  );
}
