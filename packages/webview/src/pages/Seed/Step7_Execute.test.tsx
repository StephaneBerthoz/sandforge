import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { Step7Execute } from './Step7_Execute';
import type { ObjectProgress } from './Step7_Execute';

const progress: ObjectProgress[] = [
  { objectApiName: 'Account', total: 500, completed: 500, failed: 0, status: 'done' },
  { objectApiName: 'Contact', total: 1000, completed: 600, failed: 10, status: 'running' },
];

describe('Step7Execute', () => {
  it('should render the step', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('step-execute')).toBeDefined();
  });

  it('should show elapsed time', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('elapsed-time').textContent).toContain('5.0s');
  });

  it('should show per-object progress', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('progress-Account')).toBeDefined();
    expect(screen.getByTestId('progress-Contact')).toBeDefined();
  });

  it('should show status badges', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByText('done')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });

  it('should show failed count', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    const contactRow = screen.getByTestId('progress-Contact');
    expect(contactRow.textContent).toContain('10');
  });

  it('should show completion counts', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByTestId('progress-Account').textContent).toContain('500/500');
    expect(screen.getByTestId('progress-Contact').textContent).toContain('600/1000');
  });

  it('should show running label when in progress', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByText('Seeding data...')).toBeDefined();
  });
});

describe('Step7Execute progress for assistive technology', () => {
  it('names each object bar after the object on its row', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    expect(screen.getByRole('progressbar', { name: 'Contact' })).toBeDefined();
  });

  it('announces the run progress in a polite status region', () => {
    render(
      <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
    );
    const region = screen.getByTestId('seed-progress-status');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Seed progress: 73%');
  });

  it('keeps a single progress announcement when the run is partitioned', () => {
    useGrappeStore.getState().start('op-1', 4, 6000);
    try {
      render(
        <Step7Execute isRunning objectProgress={progress} overallPercent={73} elapsedMs={5000} />,
      );
      expect(screen.getByTestId('grappe-panel')).toBeDefined();
      expect(screen.getAllByRole('status').map((region) => region.textContent)).toEqual([
        'Seed progress: 73%',
      ]);
    } finally {
      useGrappeStore.getState().reset();
    }
  });

  describe('the last announcement of a run', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Start a run at 40% and move it on within the announcement interval. */
    function runUnderway(): { rerender: (ui: React.ReactElement) => void; region: HTMLElement } {
      const { rerender } = render(
        <Step7Execute isRunning objectProgress={progress} overallPercent={40} elapsedMs={4000} />,
      );
      const region = screen.getByTestId('seed-progress-status');
      rerender(
        <Step7Execute isRunning objectProgress={progress} overallPercent={55} elapsedMs={4500} />,
      );
      // Mid-run values wait for the interval.
      expect(region.textContent).toBe('Seed progress: 40%');
      return { rerender, region };
    }

    it('says 100% as soon as the run reaches it', () => {
      const { rerender, region } = runUnderway();
      rerender(
        <Step7Execute isRunning objectProgress={progress} overallPercent={100} elapsedMs={5000} />,
      );
      expect(region.textContent).toBe('Seed progress: 100%');
    });

    it('says where a run that stopped short ended, as soon as it stops', () => {
      const { rerender, region } = runUnderway();
      rerender(
        <Step7Execute
          isRunning={false}
          objectProgress={progress}
          overallPercent={70}
          elapsedMs={5000}
        />,
      );
      expect(region.textContent).toBe('Seed progress: 70%');
    });
  });
});
