/**
 * Colour classes for `Button` / `IconButton`, kept apart from the components so
 * the all-themes contrast test (src/theme/__tests__/tokens.test.ts) reads the
 * very strings the buttons render with. Every colour here is a theme token
 * (tailwind.config.js maps each key to a `--cc-*` variable); a raw palette class
 * such as `bg-sky-100` fails that test.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'highlight'
  | 'warning'
  | 'success'
  | 'info'
  | 'external'
  | 'neutral';

/**
 * The tone variants, each in two forms built the same way from its tokens:
 * - outline (tint): the tone's `-text` colour as label and border, on its `-10`
 *   wash, `-20` on hover. `border-solid` is load-bearing: index.css's button
 *   reset (`button { border: none }`) leaves `border` alone with no style, so a
 *   1px width would render as no border at all;
 * - filled: the tone itself under its `-on` text, `-90` on hover.
 * `neutral` is an outline only: it is never the one filled action of a view.
 */
export const toneForms = {
  primary: {
    filled: 'bg-accent text-accent-on hover:bg-accent-90',
    outline: 'border border-solid border-accent-text bg-accent-10 text-accent-text hover:bg-accent-20',
  },
  danger: {
    filled: 'bg-error text-error-on hover:bg-error-90',
    outline: 'border border-solid border-error-text bg-error-10 text-error-text hover:bg-error-20',
  },
  warning: {
    filled: 'bg-warning text-warning-on hover:bg-warning-90',
    outline: 'border border-solid border-warning-text bg-warning-10 text-warning-text hover:bg-warning-20',
  },
  success: {
    filled: 'bg-success text-success-on hover:bg-success-90',
    outline: 'border border-solid border-success-text bg-success-10 text-success-text hover:bg-success-20',
  },
  info: {
    filled: 'bg-info text-info-on hover:bg-info-90',
    outline: 'border border-solid border-info-text bg-info-10 text-info-text hover:bg-info-20',
  },
  external: {
    filled: 'bg-external text-external-on hover:bg-external-90',
    outline: 'border border-solid border-external-text bg-external-10 text-external-text hover:bg-external-20',
  },
  neutral: {
    outline: 'border border-solid border-neutral-border bg-neutral-10 text-neutral-text hover:bg-neutral-20',
  },
} as const satisfies Partial<Record<ButtonVariant, { filled?: string; outline: string }>>;

type Tone = keyof typeof toneForms;

/** Variants outside the tone system, unchanged app-wide styles. */
const otherStyles: Record<Exclude<ButtonVariant, Tone>, string> = {
  secondary: 'bg-panel border border-border text-text-primary hover:bg-border',
  ghost: 'text-text-primary hover:bg-panel',
  // The main action of a panel that has no `primary` of its own: the warning
  // tone's filled form (`--cc-warning-on` reads at AA on it, see the tests).
  highlight: toneForms.warning.filled,
};

/** Tones that are filled unless a caller asks for the outline. */
const FILLED_BY_DEFAULT: ReadonlySet<ButtonVariant> = new Set(['primary', 'danger']);

const isTone = (variant: ButtonVariant): variant is Tone => variant in toneForms;

/** Whether `variant` renders filled, given the caller's `filled` (undefined = the variant's default). */
export function isFilled(variant: ButtonVariant, filled: boolean | undefined): boolean {
  if (!isTone(variant)) return variant === 'highlight';
  if (!('filled' in toneForms[variant])) return false;
  return filled ?? FILLED_BY_DEFAULT.has(variant);
}

/** The colour classes for `variant` in the form `filled` selects. */
export function variantClasses(variant: ButtonVariant, filled?: boolean): string {
  if (!isTone(variant)) return otherStyles[variant];
  const forms = toneForms[variant];
  return isFilled(variant, filled) && 'filled' in forms ? forms.filled : forms.outline;
}
