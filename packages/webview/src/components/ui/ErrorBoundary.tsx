import React from 'react';
import { Flame, RefreshCw, AlertTriangle, Copy } from 'lucide-react';
import i18n from '../../i18n';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { reloadPanel } from '../../bridge/reloadPanel';
import { isChunkLoadError, withoutFileUrls } from '../../utils/chunkLoadError';

/** Props for the ErrorBoundary component. */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback to render instead of default error UI. */
  fallback?: React.ReactNode;
}

/** State tracked by the ErrorBoundary. */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  copied: boolean;
}

/**
 * Error boundary that catches unhandled React errors and renders a recovery
 * UI instead of a white screen. Mounted at each root and, in a panel, around
 * the routed page (keyed on the route) so a page crash leaves navigation up.
 *
 * A page whose file could not be fetched is told apart from one that broke:
 * React keeps a page loaded on demand failed once its file failed, so Recover
 * drew the same failure again, under Chromium's untranslated "Failed to fetch
 * dynamically imported module" and a URL spelling the user's home folder.
 * That page is offered the one way back, a new document (Reload panel).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, copied: false };
  }

  /** Timer id for the "Copied!" feedback reset; cleared on unmount. */
  private copyResetTimeout: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });
    // Report the crash to the extension host. Goes through the broker
    // envelope (sendBridgeMessage) — a raw postMessage is silently dropped
    // since the broker validates envelopes. sendBridgeMessage resolves the
    // module-cached API itself and degrades to a no-op outside a webview
    // (tests, dev server).
    try {
      sendBridgeMessage('error:boundary', {
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
      });
    } catch {
      // Silently ignore if postMessage is not available
    }
  }

  override componentWillUnmount(): void {
    if (this.copyResetTimeout !== null) {
      clearTimeout(this.copyResetTimeout);
      this.copyResetTimeout = null;
    }
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null, copied: false });
  };

  private handleCopyError = (): void => {
    const { error, errorInfo } = this.state;
    // The URLs of a webview's files spell the user's home folder: each is cut
    // to the file it names before it reaches a bug report.
    const text = withoutFileUrls(
      [
        `Error: ${error?.message ?? 'Unknown error'}`,
        '',
        'Stack:',
        error?.stack ?? 'No stack trace',
        '',
        'Component Stack:',
        errorInfo?.componentStack ?? 'No component stack',
      ].join('\n'),
    );

    void navigator.clipboard.writeText(text).then(() => {
      this.setState({ copied: true });
      this.copyResetTimeout = setTimeout(() => this.setState({ copied: false }), 2000);
    });
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    const { error, copied } = this.state;
    const notLoaded = isChunkLoadError(error);

    return (
      <div
        className="flex flex-col items-center justify-center h-full p-8"
        style={{ background: 'var(--sf-bg-primary, #0A0A0F)' }}
        data-testid="error-boundary"
      >
        <div
          className="w-full max-w-md text-center"
          style={{ color: 'var(--sf-text-primary, #F2F2F2)' }}
        >
          {/* Icon */}
          <div className="flex items-center justify-center gap-2 mb-6">
            <Flame className="w-8 h-8 text-status-error" />
            <AlertTriangle className="w-6 h-6 text-status-warning" />
          </div>

          {/* Title */}
          <h2
            className="text-lg font-semibold mb-2"
            style={{ color: 'var(--sf-text-primary, #F2F2F2)' }}
          >
            {notLoaded
              ? i18n.t('errorBoundary.notLoadedTitle')
              : i18n.t('errorBoundary.title', 'Something went wrong')}
          </h2>
          <p className="text-sm mb-6" style={{ color: 'var(--sf-text-secondary, #A3A3A3)' }}>
            {notLoaded
              ? i18n.t('errorBoundary.notLoadedDescription')
              : i18n.t(
                  'errorBoundary.description',
                  'SandForge encountered an unexpected error. You can try recovering or copy the error details for a bug report.',
                )}
          </p>

          {/* Error message. A file that could not be fetched is said in words
              above: the browser's own message is English and holds its URL. */}
          {!notLoaded && (
            <div
              className="text-left text-xs font-mono p-3 rounded-lg mb-6 overflow-auto max-h-32 text-status-error"
              style={{
                background: 'var(--sf-bg-input, #262635)',
                border: '1px solid var(--sf-border, rgba(255,255,255,0.10))',
              }}
              data-testid="error-message"
            >
              {error?.message ?? 'Unknown error'}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 justify-center">
            <button
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{
                background: 'var(--sf-button-bg, #0e639c)',
                color: 'var(--sf-button-fg, #fff)',
              }}
              onClick={notLoaded ? reloadPanel : this.handleReload}
              data-testid={notLoaded ? 'error-reload-panel-btn' : 'error-recover-btn'}
            >
              <RefreshCw className="w-4 h-4" />
              {notLoaded
                ? i18n.t('errorBoundary.reloadPanel')
                : i18n.t('errorBoundary.recover', 'Recover')}
            </button>
            <button
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{
                background: 'var(--sf-button-secondary-bg, #3a3d41)',
                color: 'var(--sf-button-secondary-fg, #d4d4d4)',
              }}
              onClick={this.handleCopyError}
              data-testid="error-copy-btn"
            >
              <Copy className="w-4 h-4" />
              {copied
                ? i18n.t('errorBoundary.copied', 'Copied!')
                : i18n.t('errorBoundary.copyError', 'Copy Error')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
