import { type ReactNode, type ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'success' | 'info';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'data-testid'?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  icon?: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-on hover:bg-accent-90',
  secondary: 'bg-panel border border-border text-text-primary hover:bg-border',
  ghost: 'text-text-primary hover:bg-panel',
  danger: 'bg-error text-accent-on hover:bg-error-90',
  warning: 'bg-warning-20 border border-warning text-warning hover:bg-warning-30',
  success: 'bg-success-10 border border-success text-success hover:bg-success-30',
  info: 'bg-accent-10 border border-accent text-accent hover:bg-accent-20',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-sm',
  md: 'px-3 py-1.5',
  lg: 'px-4 py-2 text-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary',
  size = 'md',
  children,
  icon,
  className = '',
  disabled,
  'data-testid': testId,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      className={`
        inline-flex items-center justify-center gap-2 rounded
        font-medium transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${className}
      `}
      disabled={disabled}
      data-testid={testId}
      {...(variant === 'primary' ? { 'data-primary-action': '' } : {})}
      {...props}
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'data-testid'?: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  tooltip?: string;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  tooltip,
  active,
  className = '',
  'data-testid': testId,
  ...props
}, ref) {
  const iconSizes: Record<ButtonSize, string> = {
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-11 h-11',
  };

  return (
    <button
      ref={ref}
      className={`
        inline-flex items-center justify-center rounded
        transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantStyles[variant]}
        ${iconSizes[size]}
        ${active ? 'ring-2 ring-accent' : ''}
        ${className}
      `}
      title={tooltip}
      data-testid={testId}
      {...props}
    >
      {icon}
    </button>
  );
});
