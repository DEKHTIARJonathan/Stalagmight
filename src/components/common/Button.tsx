import { type ReactNode, type ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  icon?: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-background hover:bg-accent/90',
  secondary: 'bg-panel border border-border text-text-primary hover:bg-border',
  ghost: 'text-text-primary hover:bg-panel',
  danger: 'bg-error text-white hover:bg-error/90',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-sm',
  md: 'px-3 py-1.5',
  lg: 'px-4 py-2 text-lg',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  icon,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`
        inline-flex items-center justify-center gap-2 rounded
        font-medium transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${className}
      `}
      disabled={disabled}
      {...(variant === 'primary' || variant === 'danger' ? { 'data-primary-action': '' } : {})}
      {...props}
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  tooltip?: string;
  active?: boolean;
}

export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  tooltip,
  active,
  className = '',
  ...props
}: IconButtonProps) {
  const iconSizes: Record<ButtonSize, string> = {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-10 h-10',
  };

  return (
    <button
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
      {...props}
    >
      {icon}
    </button>
  );
}
