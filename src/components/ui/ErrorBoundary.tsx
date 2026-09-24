import { Component, type ErrorInfo, type ReactNode } from 'react';
import { EN_MESSAGES } from '@/i18n/index';
import { Button } from './Button';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Top-level crash guard using the `err.*` strings. Deliberately reads
 * `EN_MESSAGES` directly rather than `useT()` — a component that crashed
 * because of a broken i18n context must not depend on that same context to
 * render its own fallback UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] caught render error', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  public override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">{EN_MESSAGES['err.title']}</h1>
        <p className="text-fg-muted">{EN_MESSAGES['err.generic']}</p>
        <Button onClick={this.handleReload}>{EN_MESSAGES['err.reload']}</Button>
      </div>
    );
  }
}
