import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  panelName: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary] ${this.props.panelName} panel error:`, error, info);
  }

  resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-3 p-6 bg-surface text-text-secondary"
          data-testid="error-boundary-fallback"
        >
          <p className="text-sm font-medium">
            {this.props.panelName} encountered an error
          </p>
          {this.state.error?.message && (
            <p className="text-xs text-text-secondary/70 max-w-xs text-center break-words">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={this.resetError}
            className="px-3 py-1.5 text-sm rounded border border-border bg-panel text-text-primary hover:bg-border transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
