import React from 'react';

/* Last-resort catch for render crashes. Without it, one thrown error anywhere
   in the tree blanks the whole portal to a white screen with no way back. */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[YS] render crash:', error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="authbg">
        <div className="panel authcard" role="alert">
          <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            The page hit an unexpected error. Your data is safe — reloading usually fixes it.
          </p>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn ghost" onClick={() => { window.location.hash = '#/'; window.location.reload(); }}>
              Go to my dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
