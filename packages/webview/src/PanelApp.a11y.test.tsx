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
  BridgeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('./motion/MotionProvider', () => ({
  MotionProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

/**
 * Landmark and bypass-block coverage for the panel shell (WCAG 2.4.1).
 * Kept beside the behavioural PanelApp.test.tsx so the structural
 * guarantees can be read on their own.
 */
describe('PanelApp landmarks', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useAppStore.setState({ currentRoute: 'home', showWelcome: false, showWhatsNew: false });
  });

  it('should wrap the routed module in a main landmark', () => {
    render(<PanelApp moduleId="monitor" />);
    const container = screen.getByTestId('panel-app');
    expect(container.tagName).toBe('MAIN');
    expect(container.getAttribute('id')).toBe('main-content');
  });

  it('should make the main landmark programmatically focusable', () => {
    render(<PanelApp moduleId="monitor" />);
    expect(screen.getByTestId('panel-app').getAttribute('tabindex')).toBe('-1');
  });

  it('should render a skip link that targets the main landmark', () => {
    render(<PanelApp moduleId="monitor" />);
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link.getAttribute('href')).toBe('#main-content');
  });

  it('should move focus to the main landmark when the skip link is activated', () => {
    render(<PanelApp moduleId="monitor" />);
    const main = screen.getByTestId('panel-app');
    main.scrollIntoView = vi.fn();

    fireEvent.click(screen.getByRole('link', { name: /skip to main content/i }));

    expect(document.activeElement).toBe(main);
  });
});
