import React, { useCallback, useEffect, useState } from 'react';
import './i18n';
import { BridgeProvider } from './bridge/BridgeProvider';
import { MotionProvider } from './motion/MotionProvider';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { FloatingToasts } from './components/ui/FloatingToasts';
import { ProtocolMismatchBanner } from './components/ProtocolMismatchBanner';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { WelcomePage } from './pages/Welcome/WelcomePage';
import { PanelRouter } from './PanelRouter';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useSendMessage } from './hooks/useMessageBus';
import { buildMessage } from './bridge/messageHelpers';
import { useAppStore } from './stores/useAppStore';

/** Props for PanelApp. */
export interface PanelAppProps {
  moduleId: string;
}

/**
 * Inner panel content — calls hooks, so it must render under the providers.
 */
const PanelInner: React.FC<PanelAppProps> = ({ moduleId }) => {
  /**
   * The panel renders its own module until something navigates the shared
   * store (global shortcuts, command palette, welcome wizard). The store
   * defaults to 'home', so it cannot be trusted as the initial route source:
   * follow store *changes* from `moduleId` onwards instead of reading it
   * directly.
   */
  const [route, setRoute] = useState(moduleId);
  useEffect(() => {
    setRoute(moduleId);
    return useAppStore.subscribe((state, prev) => {
      if (state.currentRoute !== prev.currentRoute) {
        setRoute(state.currentRoute);
      }
    });
  }, [moduleId]);

  /*
   * Global keyboard shortcuts (Ctrl+1..9/0, G+key chords, Ctrl+Enter,
   * Escape) — same hook the full App mounts in AppShell.
   * Known limitation: VS Code owns some of these chords at the workbench
   * level (Ctrl+1..8 focus editor groups, Ctrl+0 focuses the sidebar). When
   * the workbench consumes the keystroke the webview never receives it, so
   * the panel shortcut simply does not fire — the G+key chords remain the
   * reliable path. Behavior intentionally left as-is.
   */
  useGlobalShortcuts();

  const showWelcome = useAppStore((s) => s.showWelcome);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const sendMessage = useSendMessage();

  /** Handle welcome wizard completion (same contract as App's overlay). */
  const handleWelcomeComplete = useCallback((): void => {
    setShowWelcome(false);
    sendMessage(buildMessage('onboarding:complete', { skipped: false }));
  }, [setShowWelcome, sendMessage]);

  return (
    <>
      <ProtocolMismatchBanner />
      <div
        className="h-screen w-full overflow-auto bg-[var(--sf-bg-primary)] text-[var(--sf-text-primary)]"
        data-testid="panel-app"
      >
        <PanelRouter moduleId={route} />
      </div>
      <CommandPalette />
      {showWelcome && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Welcome wizard"
        >
          <div className="w-full max-h-screen overflow-auto">
            <WelcomePage onComplete={handleWelcomeComplete} />
          </div>
        </div>
      )}
      <FloatingToasts />
    </>
  );
};

/**
 * Root component for a full-width WebviewPanel.
 * Renders only the target module page — no sidebar, no topbar.
 * Each panel is an independent React instance with its own bridge.
 * Wrapped in the same ErrorBoundary as App so a render crash shows the
 * recovery UI instead of a blank panel, and in the same MotionProvider so
 * `m` components (e.g. HomePage) get their LazyMotion features and every
 * animation honors the OS prefers-reduced-motion setting.
 */
export const PanelApp: React.FC<PanelAppProps> = ({ moduleId }) => {
  return (
    <ErrorBoundary>
      <BridgeProvider>
        <MotionProvider>
          <PanelInner moduleId={moduleId} />
        </MotionProvider>
      </BridgeProvider>
    </ErrorBoundary>
  );
};
