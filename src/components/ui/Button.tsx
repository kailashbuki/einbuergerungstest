import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 active:opacity-80',
  secondary: 'bg-surface-raised text-fg border border-line hover:bg-surface',
  ghost: 'bg-transparent text-fg hover:bg-surface-raised',
};

/** Primary interactive CTA. Always at least 44x44 for thumb reach; caller supplies layout (width/position). */
export function Button({ variant = 'primary', className, children, ...rest }: ButtonProps) {
  const classes = [
    'inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-xl px-5 py-3',
    'text-base font-medium transition-opacity disabled:opacity-50 disabled:pointer-events-none',
    VARIANT_CLASSES[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
