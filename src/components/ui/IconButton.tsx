import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only buttons have no visible text, so an accessible name is mandatory. */
  readonly 'aria-label': string;
  readonly children: ReactNode;
  readonly active?: boolean;
}

/** A 44x44 minimum touch-target button for a single icon. Always requires `aria-label`. */
export function IconButton({ className, children, active, ...rest }: IconButtonProps) {
  const classes = [
    'inline-flex min-h-touch min-w-touch items-center justify-center rounded-full',
    'text-fg hover:bg-surface-raised transition-colors disabled:opacity-50 disabled:pointer-events-none',
    active ? 'bg-surface-raised text-accent' : '',
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
