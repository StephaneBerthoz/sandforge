import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { CleanupScanResult } from '@sandforge/shared';
import { CleanupPanel } from './CleanupPanel';

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
}

const idle = (): MutationState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  reset: vi.fn(),
  requestId: null,
});

/**
 * The dry run and the delete are two hooks on one channel: the dry run waits
 * five minutes on the host, the delete ten — that is what tells them apart here.
 */
let states: Record<string, MutationState>;

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { timeoutMs?: number }) => {
    if (type === 'dataops:cleanup:delete') {
      return options?.timeoutMs === 300_000 ? states.plan : states.remove;
    }
    return states[type];
  },
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: {
      objects: [
        { apiName: 'Account', label: 'Account' },
        { apiName: 'Contact', label: 'Contact' },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const scanned: CleanupScanResult = {
  orgId: 'org-1',
  staleDays: 365,
  scannedAt: '2026-09-23T10:00:00.000Z',
  orphanThreshold: 0.9,
  bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
  objects: [
    {
      status: 'scanned',
      objectApiName: 'Account',
      label: 'Account',
      totalRecords: 10,
      stale: { days: 365, records: 2 },
      orphans: [],
      duplicates: null,
      keyFields: [],
      errors: [],
    },
  ],
};

beforeEach(() => {
  states = {
    'dataops:cleanup:scan': idle(),
    'dataops:cleanup:export': idle(),
    plan: idle(),
    remove: idle(),
  };
});

describe('CleanupPanel', () => {
  it('scans the objects picked with the threshold typed', () => {
    render(<CleanupPanel orgId="org-1" />);

    fireEvent.click(screen.getByTestId('cleanup-object-option-Account'));
    fireEvent.change(screen.getByTestId('cleanup-stale-days'), { target: { value: '180' } });
    fireEvent.click(screen.getByTestId('cleanup-scan-btn'));

    expect(states['dataops:cleanup:scan'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objects: [{ objectApiName: 'Account' }],
      staleDays: 180,
    });
  });

  it('asks what a delete takes before it deletes anything', () => {
    states['dataops:cleanup:scan'].data = scanned;
    render(<CleanupPanel orgId="org-1" />);

    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));

    expect(states.plan.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectApiName: 'Account',
      recommendation: { kind: 'stale', days: 365 },
      dryRun: true,
    });
    expect(states.remove.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('cleanup-review').textContent).toContain(
      'Delete Account records not modified in 365 days',
    );
  });

  it('deletes once the plan is read and the confirmation typed', () => {
    states['dataops:cleanup:scan'].data = scanned;
    render(<CleanupPanel orgId="org-1" />);
    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));
    states.plan.data = {
      objectApiName: 'Account',
      dryRun: true,
      plan: {
        objectApiName: 'Account',
        label: 'Account',
        records: 2,
        related: [{ objectApiName: 'Contact', label: 'Contact', records: 5 }],
        uncounted: [],
      },
      truncated: false,
    };
    // The answer lands: the review shows it.
    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));

    expect(screen.getByTestId('removal-plan-related').textContent).toContain('Contact: 5 records');
    fireEvent.click(screen.getByTestId('cleanup-delete-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'delete' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(states.remove.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectApiName: 'Account',
      recommendation: { kind: 'stale', days: 365 },
      dryRun: false,
    });
  });

  it('names the lookup a delete reviews by its label, as the scan read it', () => {
    states['dataops:cleanup:scan'].data = {
      ...scanned,
      objects: [
        {
          ...scanned.objects[0],
          orphans: [
            {
              fieldApiName: 'ParentId',
              label: 'Parent Account ID',
              referenceTo: 'Account',
              filled: 9,
              empty: 1,
            },
          ],
        },
      ],
    } as CleanupScanResult;
    render(<CleanupPanel orgId="org-1" />);

    fireEvent.click(screen.getByTestId('cleanup-orphans-ParentId-delete'));

    expect(screen.getByRole('heading', { level: 3, name: /leave/ }).textContent).toBe(
      'Delete Account records that leave Parent Account ID empty',
    );
  });

  it('says a delete takes only the first records of a larger recommendation', () => {
    states['dataops:cleanup:scan'].data = scanned;
    states.plan.data = {
      objectApiName: 'Account',
      dryRun: true,
      plan: {
        objectApiName: 'Account',
        label: 'Account',
        records: 1000,
        related: [],
        uncounted: [],
      },
      truncated: true,
    };
    render(<CleanupPanel orgId="org-1" />);

    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));

    expect(screen.getByTestId('cleanup-review-truncated').textContent).toContain('1,000');
  });

  it('counts the object again once a delete has run', () => {
    states['dataops:cleanup:scan'].data = scanned;
    const { rerender } = render(<CleanupPanel orgId="org-1" />);
    expect(states['dataops:cleanup:scan'].mutate).not.toHaveBeenCalled();

    // The delete's answer lands on the page the scan filled.
    states.remove.data = {
      objectApiName: 'Account',
      dryRun: false,
      plan: { objectApiName: 'Account', label: 'Account', records: 2 },
      truncated: false,
      outcome: {
        status: 'success',
        done: 2,
        failed: 0,
        objects: [{ objectApiName: 'Account', done: 2, failed: 0 }],
        errors: [],
      },
    };
    rerender(<CleanupPanel orgId="org-1" />);

    expect(states['dataops:cleanup:scan'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objects: [{ objectApiName: 'Account' }],
      staleDays: 365,
    });
  });

  it('exports the records of a recommendation, and says where they went', () => {
    states['dataops:cleanup:scan'].data = scanned;
    states['dataops:cleanup:export'].data = {
      objectApiName: 'Account',
      records: 2,
      truncated: false,
      saved: { status: 'saved', path: '/home/me/stale.json' },
    };
    render(<CleanupPanel orgId="org-1" />);

    fireEvent.click(screen.getByTestId('cleanup-stale-export'));

    expect(states['dataops:cleanup:export'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectApiName: 'Account',
      recommendation: { kind: 'stale', days: 365 },
    });
    expect(screen.getByTestId('cleanup-export-status').textContent).toBe(
      'Saved 2 records to /home/me/stale.json.',
    );
  });
});
