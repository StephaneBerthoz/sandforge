import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelApp } from './PanelApp';

vi.mock('./bridge/BridgeProvider', () => ({
  BridgeProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="bridge">{children}</div>,
}));

vi.mock('./components/ui/FloatingToasts', () => ({
  FloatingToasts: () => <div data-testid="floating-toasts" />,
}));

vi.mock('./PanelRouter', () => ({
  PanelRouter: ({ moduleId }: { moduleId: string }) => <div data-testid="panel-router">{moduleId}</div>,
}));

describe('PanelApp', () => {
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
});
