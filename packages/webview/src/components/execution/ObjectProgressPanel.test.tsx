import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { BulkExecutionProgress } from '@sandforge/shared';
import { ObjectProgressPanel } from './ObjectProgressPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts?.defaultValue) return String(opts.defaultValue)
        .replace('{{time}}', String(opts.time ?? ''))
        .replace('{{processed}}', String(opts.processed ?? ''))
        .replace('{{total}}', String(opts.total ?? ''))
        .replace('{{count}}', String(opts.count ?? ''));
      return key;
    },
  }),
}));

const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

function dispatchProgress(progress: BulkExecutionProgress): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: 'msg-' + Date.now(),
        type: 'execution:progress',
        timestamp: Date.now(),
        payload: progress,
      },
    }),
  );
}

describe('ObjectProgressPanel', () => {
  it('should show skeleton when no progress data is available', () => {
    render(<ObjectProgressPanel executionId="exec-unknown" />);
    expect(screen.getByTestId('object-progress-empty')).toBeDefined();
    expect(screen.getByTestId('skeleton-panel')).toBeDefined();
  });

  it('should render overall progress bar', () => {
    const { rerender } = render(<ObjectProgressPanel executionId="exec-1" />);

    act(() => {
      dispatchProgress({
        executionId: 'exec-1',
        objects: [{
          objectName: 'Account',
          jobId: 'job-1',
          operation: 'insert',
          recordsProcessed: 50,
          recordsFailed: 0,
          totalRecords: 100,
          state: 'processing',
          startedAt: Date.now(),
        }],
        overallPercent: 50,
        elapsedMs: 30000,
      });
    });

    rerender(<ObjectProgressPanel executionId="exec-1" />);

    const panel = screen.getByTestId('object-progress-panel');
    expect(panel).toBeDefined();
    expect(screen.getByText('Overall Progress')).toBeDefined();
  });

  it('should render per-object progress rows', () => {
    const { rerender } = render(<ObjectProgressPanel executionId="exec-1" />);

    act(() => {
      dispatchProgress({
        executionId: 'exec-1',
        objects: [
          {
            objectName: 'Account',
            jobId: 'job-1',
            operation: 'insert',
            recordsProcessed: 30,
            recordsFailed: 0,
            totalRecords: 100,
            state: 'processing',
            startedAt: Date.now(),
          },
          {
            objectName: 'Contact',
            jobId: 'job-2',
            operation: 'upsert',
            recordsProcessed: 200,
            recordsFailed: 5,
            totalRecords: 200,
            state: 'complete',
            startedAt: Date.now(),
          },
        ],
        overallPercent: 77,
        elapsedMs: 60000,
      });
    });

    rerender(<ObjectProgressPanel executionId="exec-1" />);

    const rows = screen.getAllByTestId('object-progress-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });

  it('should show status badges', () => {
    const { rerender } = render(<ObjectProgressPanel executionId="exec-1" />);

    act(() => {
      dispatchProgress({
        executionId: 'exec-1',
        objects: [{
          objectName: 'Lead',
          jobId: 'job-1',
          operation: 'insert',
          recordsProcessed: 0,
          recordsFailed: 0,
          totalRecords: 50,
          state: 'queued',
          startedAt: Date.now(),
        }],
        overallPercent: 0,
        elapsedMs: 1000,
      });
    });

    rerender(<ObjectProgressPanel executionId="exec-1" />);
    expect(screen.getByText('queued')).toBeDefined();
  });

  it('should display failed records count in red', () => {
    const { rerender } = render(<ObjectProgressPanel executionId="exec-1" />);

    act(() => {
      dispatchProgress({
        executionId: 'exec-1',
        objects: [{
          objectName: 'Account',
          jobId: 'job-1',
          operation: 'insert',
          recordsProcessed: 90,
          recordsFailed: 10,
          totalRecords: 100,
          state: 'failed',
          startedAt: Date.now(),
        }],
        overallPercent: 90,
        elapsedMs: 5000,
      });
    });

    rerender(<ObjectProgressPanel executionId="exec-1" />);
    const failedEl = screen.getByTestId('failed-count');
    expect(failedEl).toBeDefined();
    expect(failedEl.textContent).toContain('10');
  });

  it('should update when progress changes', () => {
    const { rerender } = render(<ObjectProgressPanel executionId="exec-1" />);

    act(() => {
      dispatchProgress({
        executionId: 'exec-1',
        objects: [{
          objectName: 'Account',
          jobId: 'job-1',
          operation: 'insert',
          recordsProcessed: 25,
          recordsFailed: 0,
          totalRecords: 100,
          state: 'processing',
          startedAt: Date.now(),
        }],
        overallPercent: 25,
        elapsedMs: 2000,
      });
    });

    rerender(<ObjectProgressPanel executionId="exec-1" />);
    expect(screen.getByText('25 / 100 records')).toBeDefined();

    act(() => {
      dispatchProgress({
        executionId: 'exec-1',
        objects: [{
          objectName: 'Account',
          jobId: 'job-1',
          operation: 'insert',
          recordsProcessed: 75,
          recordsFailed: 0,
          totalRecords: 100,
          state: 'processing',
          startedAt: Date.now(),
        }],
        overallPercent: 75,
        elapsedMs: 8000,
      });
    });

    rerender(<ObjectProgressPanel executionId="exec-1" />);
    expect(screen.getByText('75 / 100 records')).toBeDefined();
  });
});
