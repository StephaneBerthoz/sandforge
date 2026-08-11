import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  PanelRouter: ({ moduleId }: { moduleId: string }) => (
    <div data-testid="panel-router">{moduleId}</div>
  ),
}));

vi.mock('./components/CommandPalette/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}));

vi.mock('./pages/Welcome/WelcomePage', () => ({
  WelcomePage: ({ onComplete }: { onComplete: () => void }) => (
    <button data-testid="welcome-page-stub" onClick={onComplete}>
      welcome
    </button>
  ),
}));

describe('PanelApp', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useAppStore.setState({ currentRoute: 'home', showWelcome: false });
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

  it('should not clobber the panel module with the store default on mount', () => {
    // The store defaults to 'home'; the panel must keep rendering its own
    // module until a real navigation happens.
    render(<PanelApp moduleId="settings" />);
    expect(screen.getByTestId('panel-router').textContent).toBe('settings');
  });
});
