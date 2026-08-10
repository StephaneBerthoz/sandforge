import React from 'react';
import './i18n';
import { BridgeProvider } from './bridge/BridgeProvider';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { FloatingToasts } from './components/ui/FloatingToasts';
import { ProtocolMismatchBanner } from './components/ProtocolMismatchBanner';
import { PanelRouter } from './PanelRouter';

/** Props for PanelApp. */
export interface PanelAppProps {
  moduleId: string;
}

/**
 * Root component for a full-width WebviewPanel.
 * Renders only the target module page — no sidebar, no topbar.
 * Each panel is an independent React instance with its own bridge.
 * Wrapped in the same ErrorBoundary as App so a render crash shows the
 * recovery UI instead of a blank panel.
 */
export const PanelApp: React.FC<PanelAppProps> = ({ moduleId }) => {
  return (
    <ErrorBoundary>
      <BridgeProvider>
        <ProtocolMismatchBanner />
        <div
          className="h-screen w-full overflow-auto bg-[var(--sf-bg-primary)] text-[var(--sf-text-primary)]"
          data-testid="panel-app"
        >
          <PanelRouter moduleId={moduleId} />
        </div>
        <FloatingToasts />
      </BridgeProvider>
    </ErrorBoundary>
  );
};
