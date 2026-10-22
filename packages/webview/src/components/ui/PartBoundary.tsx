import React from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { cn } from '../../theme';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { reloadPanel } from '../../bridge/reloadPanel';
import { isChunkLoadError } from '../../utils/chunkLoadError';
import { Button } from './Button';

/** Props for PartBoundary. */
export interface PartBoundaryProps {
  children: React.ReactNode;
  /** What else the failure means, said under it: that a run goes on, for one. */
  note?: string;
  /** Classes of the box the failure is said in, so it takes the part's place. */
  className?: string;
  /** Test id of the failure; its button is `<id>-reload`. */
  'data-testid'?: string;
}

/** State tracked by PartBoundary. */
interface PartBoundaryState {
  error: Error | null;
}

/** What a part that failed says in its place. */
const PartFailed: React.FC<{
  error: Error;
  note?: string;
  className?: string;
  testId: string;
}> = ({ error, note, className, testId }) => {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-2 rounded-sm border border-subtle bg-surface-1 p-3 text-sm text-text-primary',
        className,
      )}
      data-testid={testId}
    >
      <p>
        {isChunkLoadError(error) ? t('errorBoundary.partNotLoaded') : t('errorBoundary.partFailed')}
      </p>
      {note && <p className="text-text-secondary">{note}</p>}
      <Button
        variant="secondary"
        size="sm"
        icon={<RefreshCw size={12} aria-hidden="true" />}
        onClick={reloadPanel}
        data-testid={`${testId}-reload`}
      >
        {t('errorBoundary.reloadPanel')}
      </Button>
    </div>
  );
};

/**
 * Keeps a part of a page that fails — a Forge step, a Reports tab, a Monitor
 * chart, Sync's schedules, a graph — to its own place, said there in words
 * with the way back (Reload panel), while the rest of the page stays up.
 *
 * Each of these parts is a file fetched the first time it is shown, minutes
 * or hours after the panel opened, and only the page's boundary caught its
 * failure: a decorative chart whose file could not be fetched replaced the
 * whole Monitor page, its Stop buttons with it, and a Forge run went on
 * writing behind a page that showed neither its progress nor its Abort.
 * React keeps such a part failed for as long as the document lives, so the
 * way back is a new document, not a retry.
 */
export class PartBoundary extends React.Component<PartBoundaryProps, PartBoundaryState> {
  constructor(props: PartBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): PartBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Reported as the page's boundary reports a crash: the extension logs it.
    try {
      sendBridgeMessage('error:boundary', {
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
      });
    } catch {
      // Nothing to report to outside a webview.
    }
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <PartFailed
        error={error}
        note={this.props.note}
        className={this.props.className}
        testId={this.props['data-testid'] ?? 'part-failed'}
      />
    );
  }
}
