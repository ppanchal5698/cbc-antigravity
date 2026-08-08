'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

type Props = { children: ReactNode; label: string };
type State = { error: Error | null };

/** Keeps one broken panel from taking down the whole page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="border-alert border-l-2 py-3 pl-3">
        <p className="text-sm font-medium">{this.props.label} hit an error.</p>
        <p className="text-ink-muted mt-1 max-w-md text-xs break-words">
          {this.state.error.message}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </Button>
      </div>
    );
  }
}
