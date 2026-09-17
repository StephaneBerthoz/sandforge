import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import '../i18n';
import { GrappeProgressPanel } from './GrappeProgressPanel';
import { useGrappeStore } from '../stores/useGrappeStore';

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

describe('GrappeProgressPanel for assistive technology', () => {
  beforeEach(() => {
    useGrappeStore.getState().reset();
  });

  it('names the overall bar and each partition bar', () => {
    useGrappeStore.getState().start('op-1', 3, 6000);
    useGrappeStore.getState().updatePartition('p-1', 50, 1000);
    render(<GrappeProgressPanel />);
    expect(screen.getByRole('progressbar', { name: 'Grappe progress' })).toBeDefined();
    expect(screen.getByRole('progressbar', { name: 'p-1' })).toBeDefined();
  });

  it('announces the run progress in a polite status region', () => {
    useGrappeStore.getState().start('op-1', 4, 6000);
    useGrappeStore.getState().updatePartition('p-1', 100, 1500);
    render(<GrappeProgressPanel />);
    const region = screen.getByTestId('grappe-progress-status');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Grappe progress: 25%');
  });

  it('says 100% as soon as the run completes, without waiting for the interval', () => {
    vi.useFakeTimers();
    try {
      useGrappeStore.getState().start('op-1', 4, 6000);
      useGrappeStore.getState().updatePartition('p-1', 100, 1500);
      render(<GrappeProgressPanel />);
      const region = screen.getByTestId('grappe-progress-status');
      act(() => {
        useGrappeStore.getState().updatePartition('p-2', 100, 1500);
      });
      // Mid-run values wait for the interval.
      expect(region.textContent).toBe('Grappe progress: 25%');

      act(() => {
        useGrappeStore.getState().complete(6000, 0);
      });
      expect(region.textContent).toBe('Grappe progress: 100%');
    } finally {
      vi.useRealTimers();
    }
  });
});
