import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { withEnglish } from './i18n/englishNamespaces';
import { BridgeProvider } from './bridge/BridgeProvider';
import { MotionProvider } from './motion/MotionProvider';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { FloatingToasts } from './components/ui/FloatingToasts';
import { SkipLink } from './components/ui/SkipLink';
import { ProtocolMismatchBanner } from './components/ProtocolMismatchBanner';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import type { WelcomePageHandle } from './pages/Welcome/WelcomePage';
import { PanelRouter } from './PanelRouter';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useFocusTrap } from './hooks/useFocusTrap';
import { useRouteFocus } from './hooks/useRouteFocus';
import { useKonamiCode } from './hooks/useKonamiCode';
import { useSendMessage } from './hooks/useMessageBus';
import { buildMessage } from './bridge/messageHelpers';
import { useAppStore } from './stores/useAppStore';
import { useNotificationStore } from './stores/useNotificationStore';
import { reloadPanel } from './bridge/reloadPanel';
import { sendBridgeMessage } from './bridge/sendBridgeMessage';

/*
 * The overlays a panel shows now and then — the welcome wizard on a first
 * run, What's New after an update, the easter egg — each come in a chunk of
 * their own, loaded when one opens: every panel used to parse them up front.
 * Each brings the namespaces of the English catalogue it renders beyond the
 * shell's, as a page does (PanelRouter).
 */
const WelcomePage = lazy(
  withEnglish(
    () => import('./pages/Welcome/WelcomePage').then((module) => ({ default: module.WelcomePage })),
    ['errors', 'onboarding', 'settings'],
  ),
);
const WhatsNewPage = lazy(
  withEnglish(
    () =>
      import('./pages/Welcome/WhatsNewPage').then((module) => ({ default: module.WhatsNewPage })),
    ['onboarding'],
  ),
);
const MojitoOverlay = lazy(
  withEnglish(
    () =>
      import('./components/EasterEgg/MojitoOverlay').then((module) => ({
        default: module.MojitoOverlay,
      })),
    [],
  ),
);

/** Props for OverlayBoundary. */
interface OverlayBoundaryProps {
  /** Closes the overlay: an overlay left open would throw again on every render. */
  onFailed: () => void;
  children: React.ReactNode;
}

/**
 * Catches an overlay that fails, which renders outside the page's boundary:
 * its failure reached the root boundary, which took down the bridge and the
 * page, and whose Recover threw again on every press, the overlay still open
 * in the store. The overlay is closed instead, the page left as it was, and
 * a toast says what did not load and offers the way back.
 */
class OverlayBoundary extends React.Component<OverlayBoundaryProps, { failed: boolean }> {
  constructor(props: OverlayBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    try {
      sendBridgeMessage('error:boundary', {
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
      });
    } catch {
      // Nothing to report to outside a webview.
    }
    useNotificationStore.getState().addNotification({
      level: 'error',
      title: i18n.t('errorBoundary.notLoadedTitle'),
      message: i18n.t('errorBoundary.notLoadedDescription'),
      actions: [
        {
          label: i18n.t('errorBoundary.reloadPanel'),
          command: 'panel-reload',
          onAction: reloadPanel,
        },
      ],
    });
    this.props.onFailed();
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Props for PanelApp. */
export interface PanelAppProps {
  moduleId: string;
}

/** Props for OverlayDialog. */
interface OverlayDialogProps {
  label: string;
  /** Escape does what the overlay's own close action does. */
  onEscape: () => void;
  children: React.ReactNode;
}

/**
 * Full-panel modal overlay. Rendered only while open, so the focus trap moves
 * focus in when it appears and hands it back when it goes. Its content comes
 * in a chunk of its own: the Suspense that waits for it sits outside the
 * dialog, so the dialog and its trap mount with the content in them. Inside,
 * the trap mounted on an empty dialog, found nothing to focus and focused the
 * dialog itself, and nothing moved the focus when the content arrived.
 */
const OverlayDialog: React.FC<OverlayDialogProps> = ({ label, onEscape, children }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, onEscape);
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-100 bg-black/50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      <div className="w-full max-h-screen overflow-auto">{children}</div>
    </div>
  );
};

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
  const { t } = useTranslation();

  const [route, setRoute] = useState(moduleId);
  useEffect(() => {
    setRoute(moduleId);
    return useAppStore.subscribe((state, prev) => {
      if (state.currentRoute !== prev.currentRoute) {
        setRoute(state.currentRoute);
      }
    });
  }, [moduleId]);

  // A page change remounts the page and drops the focus with the control that
  // navigated: the new page's heading takes it, and the title names the page.
  useRouteFocus(route);

  /*
   * Global keyboard shortcuts (Ctrl+1..9/0, G+key chords) — mounted here
   * since the old App/AppShell shell is gone and panels are the only
   * production roots.
   * Known limitation: VS Code owns some of these chords at the workbench
   * level (Ctrl+1..8 focus editor groups, Ctrl+0 focuses the sidebar). When
   * the workbench consumes the keystroke the webview never receives it, so
   * the panel shortcut simply does not fire — the G+key chords remain the
   * reliable path. Behavior intentionally left as-is.
   */
  useGlobalShortcuts();

  const showWelcome = useAppStore((s) => s.showWelcome);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const showWhatsNew = useAppStore((s) => s.showWhatsNew);
  const whatsNewVersion = useAppStore((s) => s.whatsNewVersion);
  const setShowWhatsNew = useAppStore((s) => s.setShowWhatsNew);
  const sendMessage = useSendMessage();

  /*
   * What the panel shows, told to the extension as it changes: the Help and
   * Reports panels are released while hidden and rebuilt on their own page,
   * which would drop a Settings page Help's link routed to, its edits with
   * it, or the welcome tour half done. They are released only while the page
   * shows its own module with no overlay open.
   */
  const overlay = showWelcome || showWhatsNew;
  useEffect(() => {
    sendMessage(buildMessage('panel:route', { moduleId, route, overlay }));
  }, [sendMessage, moduleId, route, overlay]);

  /**
   * Handle welcome wizard completion. Nothing is told to the extension: it
   * recorded the end of the tour, and nothing read what it recorded.
   */
  const handleWelcomeComplete = useCallback((): void => {
    setShowWelcome(false);
  }, [setShowWelcome]);

  const welcomeRef = useRef<WelcomePageHandle>(null);
  /** Escape skips the wizard the way its Skip button does, keeping "Don't show again". */
  const handleWelcomeEscape = useCallback((): void => {
    if (welcomeRef.current) welcomeRef.current.skip();
    else handleWelcomeComplete();
  }, [handleWelcomeComplete]);

  /** Handle what's new dismissal (same contract as App's overlay). */
  const handleWhatsNewDismiss = useCallback((): void => {
    setShowWhatsNew(false);
  }, [setShowWhatsNew]);

  /*
   * Easter egg (mojito overlay) — same three triggers as the dead App shell
   * used to mount: Konami code, `easter-egg:show` from the `sandforge.cheers`
   * command, and 7 clicks on the SandForge title/logo. Without this wiring
   * the command posted into the void in production.
   */
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const handleEasterEggClose = useCallback((): void => setShowEasterEgg(false), []);
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Trigger 1: Konami Code. */
  useKonamiCode(useCallback(() => setShowEasterEgg(true), []));

  /** Trigger 2: `sandforge.cheers` command message. */
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview host.
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      if (event.data?.type === 'easter-egg:show') {
        setShowEasterEgg(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  /** Trigger 3: 7 clicks on the SandForge title/logo. */
  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      if (
        target.textContent?.includes('SandForge') &&
        (target.tagName === 'H1' ||
          target.tagName === 'SPAN' ||
          target.closest('[data-testid="app-logo"]'))
      ) {
        logoClickCount.current += 1;
        if (logoClickTimer.current) {
          clearTimeout(logoClickTimer.current);
        }
        logoClickTimer.current = setTimeout(() => {
          logoClickCount.current = 0;
        }, 3000);
        if (logoClickCount.current >= 7) {
          setShowEasterEgg(true);
          logoClickCount.current = 0;
        }
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <>
      <SkipLink />
      <ProtocolMismatchBanner />
      {/*
       * The panel body is the page's single `main` landmark: screen readers
       * jump straight here, and `tabIndex={-1}` makes it a valid target for
       * SkipLink's programmatic focus (a `main` is not focusable otherwise).
       */}
      <main
        id="main-content"
        tabIndex={-1}
        className="h-screen w-full overflow-auto bg-(--sf-bg-primary) text-(--sf-text-primary)"
        data-testid="panel-app"
      >
        {/*
         * A page crash is caught here rather than at the root, so the palette,
         * the shortcuts and the overlays stay mounted and the user can still
         * navigate away. Keying on the route gives the next page a fresh
         * boundary instead of the fallback the last one left behind.
         */}
        <ErrorBoundary key={route}>
          <PanelRouter moduleId={route} />
        </ErrorBoundary>
      </main>
      <CommandPalette />
      {showWelcome && (
        <OverlayBoundary onFailed={handleWelcomeComplete}>
          <Suspense fallback={null}>
            <OverlayDialog
              label={t('a11y.welcomeWizard', 'Welcome wizard')}
              onEscape={handleWelcomeEscape}
            >
              <WelcomePage ref={welcomeRef} onComplete={handleWelcomeComplete} />
            </OverlayDialog>
          </Suspense>
        </OverlayBoundary>
      )}
      {showWhatsNew && (
        <OverlayBoundary onFailed={handleWhatsNewDismiss}>
          <Suspense fallback={null}>
            <OverlayDialog
              label={t('a11y.whatsNew', "What's new")}
              onEscape={handleWhatsNewDismiss}
            >
              <WhatsNewPage version={whatsNewVersion} onDismiss={handleWhatsNewDismiss} />
            </OverlayDialog>
          </Suspense>
        </OverlayBoundary>
      )}
      {showEasterEgg && (
        <OverlayBoundary onFailed={handleEasterEggClose}>
          <Suspense fallback={null}>
            <MojitoOverlay onClose={handleEasterEggClose} />
          </Suspense>
        </OverlayBoundary>
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
