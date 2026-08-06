/**
 * Last-resort error boundary. Without one, any exception thrown during
 * render unmounts the entire React tree — a blank window with no
 * explanation, from a tool whose whole job is opening untrusted files.
 * Known render hazards are guarded at their source (safeStringify and
 * friends); this catches whatever was not foreseen and keeps the failure
 * explainable and recoverable.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === undefined) {
      return this.props.children;
    }
    return (
      <div className="crash-screen">
        <h2>Something went wrong while rendering</h2>
        <p>
          The rest of the app state is intact. This usually means a loaded file contained a
          structure the display code could not handle — worth reporting.
        </p>
        <pre className="detail-json">{this.state.error.message}</pre>
        <button
          type="button"
          className="secondary-button"
          onClick={() => this.setState({ error: undefined })}
        >
          Try to continue
        </button>
      </div>
    );
  }
}
