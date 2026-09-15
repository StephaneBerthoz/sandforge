import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forwardRef, useImperativeHandle } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelApp } from './PanelApp';
import { useAppStore } from './stores/useAppStore';

const mockPostMessage = vi.fn();

vi.mock('./hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

vi.mock('./bridge/BridgeProvider', () => ({
  BridgeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bridge">{children}</div>
  ),
}));

vi.mock('./motion/MotionProvider', () => ({
  MotionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="motion-provider">{children}</div>
  ),
}));

vi.mock('./components/ui/FloatingToasts', () => ({
  FloatingToasts: () => <div data-testid="floating-toasts" />,
}));

vi.mock('./PanelRouter', () => ({
  PanelRouter: ({ moduleId }: { moduleId: string }) => {
    if (moduleId === 'crashing') {
      throw new Error('page render failed');
    }
    return <div data-testid="panel-router">{moduleId}</div>;
  },
}));

vi.mock('./components/CommandPalette/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}));

const mockWelcomeSkip = vi.hoisted(() => vi.fn());

vi.mock('./pages/Welcome/WelcomePage', () => ({
  WelcomePage: forwardRef<{ skip: () => void }, { onComplete: () => void }>(
    function WelcomePageStub({ onComplete }, ref) {
      useImperativeHandle(ref, () => ({
        skip: () => {
          mockWelcomeSkip();
          onComplete();
        },
      }));
      return (
        <>
          <button data-testid="welcome-page-stub" onClick={onComplete}>
            welcome
          </button>
          <button data-testid="welcome-page-last">next</button>
        </>
      );
    },
  ),
}));

vi.mock('./pages/Welcome/WhatsNewPage', () => ({
  WhatsNewPage: ({ version, onDismiss }: { version: string; onDismiss: () => void }) => (
    <>
      <button data-testid="whats-new-page-stub" onClick={onDismiss}>
        whats-new {version}
      </button>
      <button data-testid="whats-new-page-last">changelog</button>
    </>
  ),
}));

vi.mock('./components/EasterEgg/MojitoOverlay', () => ({
  MojitoOverlay: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="mojito-overlay-stub" onClick={onClose}>
      mojito
    </button>
  ),
}));

describe('PanelApp', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useAppStore.setState({ currentRoute: 'home', showWelcome: false, showWhatsNew: false });
  });

  it('should render the panel-app container', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('panel-app')).toBeDefined();
  });

  it('should render within BridgeProvider', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('bridge')).toBeDefined();
  });

  it('should render PanelRouter with the moduleId', () => {
    render(<PanelApp moduleId="forge" />);
    const router = screen.getByTestId('panel-router');
    expect(router.textContent).toBe('forge');
  });

  it('should render FloatingToasts', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('floating-toasts')).toBeDefined();
  });

  it('should wrap the panel in MotionProvider', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('motion-provider')).toBeDefined();
  });

  it('should mount the CommandPalette', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('command-palette')).toBeDefined();
  });

  it('should not render the welcome overlay by default', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.queryByTestId('welcome-page-stub')).toBeNull();
  });

  it('should render the welcome overlay when showWelcome is set (onboarding:show)', () => {
    useAppStore.setState({ showWelcome: true });
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('welcome-page-stub')).toBeDefined();
  });

  it('should hide the welcome overlay and notify the extension on completion', () => {
    useAppStore.setState({ showWelcome: true });
    render(<PanelApp moduleId="monitor" />);
    fireEvent.click(screen.getByTestId('welcome-page-stub'));

    expect(useAppStore.getState().showWelcome).toBe(false);
    expect(screen.queryByTestId('welcome-page-stub')).toBeNull();
    const types = mockPostMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { payload: { type: string } }).payload.type,
    );
    expect(types).toContain('onboarding:complete');
  });

  it('should not render the whats-new overlay by default', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.queryByTestId('whats-new-page-stub')).toBeNull();
  });

  it('should render the whats-new overlay when showWhatsNew is set (whats-new:show)', () => {
    useAppStore.setState({ showWhatsNew: true, whatsNewVersion: '1.6.0' });
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('whats-new-page-stub').textContent).toContain('1.6.0');
  });

  it('should hide the whats-new overlay on dismiss', () => {
    useAppStore.setState({ showWhatsNew: true, whatsNewVersion: '1.6.0' });
    render(<PanelApp moduleId="monitor" />);
    fireEvent.click(screen.getByTestId('whats-new-page-stub'));

    expect(useAppStore.getState().showWhatsNew).toBe(false);
    expect(screen.queryByTestId('whats-new-page-stub')).toBeNull();
  });

  it('should show the mojito overlay on easter-egg:show (sandforge.cheers)', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.queryByTestId('mojito-overlay-stub')).toBeNull();

    fireEvent(window, new MessageEvent('message', { data: { type: 'easter-egg:show' } }));

    expect(screen.getByTestId('mojito-overlay-stub')).toBeDefined();
  });

  it('should hide the mojito overlay on close', () => {
    render(<PanelApp moduleId="monitor" />);
    fireEvent(window, new MessageEvent('message', { data: { type: 'easter-egg:show' } }));
    fireEvent.click(screen.getByTestId('mojito-overlay-stub'));

    expect(screen.queryByTestId('mojito-overlay-stub')).toBeNull();
  });

  it('should follow store navigation triggered by the global shortcuts (Ctrl+number)', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('panel-router').textContent).toBe('monitor');

    fireEvent.keyDown(document, { key: '4', ctrlKey: true });

    expect(useAppStore.getState().currentRoute).toBe('compare');
    expect(screen.getByTestId('panel-router').textContent).toBe('compare');
  });

  it('should follow store navigation triggered by chord shortcuts (G then key)', () => {
    render(<PanelApp moduleId="monitor" />);

    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'f' });

    expect(useAppStore.getState().currentRoute).toBe('forge');
    expect(screen.getByTestId('panel-router').textContent).toBe('forge');
  });

  it('keeps the shortcuts and the palette after a page crash, and navigating away renders the new page', () => {
    // React reports the caught render error; keep the run output readable.
    const reportedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<PanelApp moduleId="crashing" />);

    expect(screen.getByTestId('error-boundary')).toBeDefined();
    expect(screen.getByTestId('command-palette')).toBeDefined();
    expect(screen.getByTestId('floating-toasts')).toBeDefined();

    // The store already sits on 'home' (beforeEach), so go somewhere else to
    // produce a real route change.
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'm' });

    expect(screen.queryByTestId('error-boundary')).toBeNull();
    expect(screen.getByTestId('panel-router').textContent).toBe('monitor');
    reportedError.mockRestore();
  });

  it('moves focus into the welcome dialog, keeps Tab inside it, and skips the wizard on Escape', () => {
    mockWelcomeSkip.mockClear();
    useAppStore.setState({ showWelcome: true });
    render(<PanelApp moduleId="monitor" />);
    const dialog = screen.getByRole('dialog', { name: 'Welcome wizard' });
    const first = screen.getByTestId('welcome-page-stub');
    const last = screen.getByTestId('welcome-page-last');

    expect(dialog.contains(document.activeElement)).toBe(true);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: 'Escape' });
    // Through the wizard's own skip, so a ticked "Don't show again" is kept.
    expect(mockWelcomeSkip).toHaveBeenCalledOnce();
    expect(useAppStore.getState().showWelcome).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Welcome wizard' })).toBeNull();
  });

  it("moves focus into the what's new dialog, keeps Tab inside it, and closes it on Escape", () => {
    useAppStore.setState({ showWhatsNew: true, whatsNewVersion: '1.6.0' });
    render(<PanelApp moduleId="monitor" />);
    const dialog = screen.getByRole('dialog', { name: "What's new" });
    const first = screen.getByTestId('whats-new-page-stub');
    const last = screen.getByTestId('whats-new-page-last');

    expect(dialog.contains(document.activeElement)).toBe(true);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Escape' });
    expect(useAppStore.getState().showWhatsNew).toBe(false);
  });

  it('should not clobber the panel module with the store default on mount', () => {
    // The store defaults to 'home'; the panel must keep rendering its own
    // module until a real navigation happens.
    render(<PanelApp moduleId="settings" />);
    expect(screen.getByTestId('panel-router').textContent).toBe('settings');
  });
});
