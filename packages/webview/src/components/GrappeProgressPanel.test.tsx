import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GrappeProgressPanel } from './GrappeProgressPanel';
import { useGrappeStore } from '../stores/useGrappeStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

describe('GrappeProgressPanel', () => {
  beforeEach(() => {
    useGrappeStore.getState().reset();
  });

  it('should not render when inactive and no operationId', () => {
    const { container } = render(<GrappeProgressPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('should render when grappe is active', () => {
    useGrappeStore.getState().start('op-1', 5, 10000);
    render(<GrappeProgressPanel />);
    expect(screen.getByTestId('grappe-panel')).toBeDefined();
  });

  it('should show partition count', () => {
    useGrappeStore.getState().start('op-1', 5, 10000);
    render(<GrappeProgressPanel />);
    const panel = screen.getByTestId('grappe-panel');
    expect(panel.textContent).toContain('0/5');
  });

  it('should show total records', () => {
    useGrappeStore.getState().start('op-1', 3, 6000);
    render(<GrappeProgressPanel />);
    const stats = screen.getByTestId('grappe-stats');
    expect(stats.textContent).toMatch(/6.?000/);
  });

  it('should show active partitions', () => {
    useGrappeStore.getState().start('op-1', 3, 6000);
    useGrappeStore.getState().updatePartition('p-1', 50, 1000);
    render(<GrappeProgressPanel />);
    expect(screen.getByTestId('grappe-partition-p-1')).toBeDefined();
  });

  it('should show completed state', () => {
    useGrappeStore.getState().start('op-1', 2, 3000);
    useGrappeStore.getState().complete(2800, 200);
    render(<GrappeProgressPanel />);
    const stats = screen.getByTestId('grappe-stats');
    expect(stats.textContent).toMatch(/2.?800/);
    expect(stats.textContent).toContain('200');
  });
});
