/**
 * Catches render-time exceptions so a single bad component can't blank the
 * whole app.
 *
 * Without this, any uncaught error during render unmounts the entire React
 * tree and the user is left staring at a white page with no explanation and
 * no way back — the worst possible failure mode for someone mid-way through
 * entering a lead. React only surfaces these to a class component, which is
 * why this is the one class in the codebase.
 *
 * Two levels are used (see App.tsx):
 *   - one around the router, so a crash in the shell still renders something;
 *   - one inside the layout keyed on the route, so a crash in a single page
 *     leaves the sidebar and header usable and navigating away recovers.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Changing this remounts the boundary — pass the route so navigation clears a crashed page. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack — the message alone rarely identifies which
    // field or widget threw. Wired to console rather than a service because
    // no error reporter is configured yet; this is the single place to add one.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div className="max-w-md">
          <h2 className="text-lg font-semibold">Something went wrong on this screen</h2>
          <p className="mt-1 text-sm text-muted">
            The rest of the app is still fine — you can go back, or reload to try again.
            Nothing you had already saved is affected.
          </p>
          {/* The message is useful when reporting a bug and harmless to show:
              it is a client-side exception, not server data. */}
          <p className="mt-3 break-words rounded-lg bg-slate-100 px-3 py-2 text-left font-mono text-2xs dark:bg-slate-800 text-muted">
            {error.message}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary btn-sm" onClick={() => window.history.back()}>
            Go back
          </button>
          <button className="btn-primary btn-sm" onClick={() => window.location.reload()}>
            <RefreshCw className="h-3.5 w-3.5" /> Reload
          </button>
        </div>
      </div>
    );
  }
}
