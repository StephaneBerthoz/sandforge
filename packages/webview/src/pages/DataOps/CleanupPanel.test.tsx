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

/** What the org runs as the delete goes, as the extension answers a read of it: nothing. */
const NOTHING_FIRES = {
  act: 'cleanup',
  objects: [{ objectApiName: 'Account', records: 2 }],
  steps: { delete: ['Account'] },
  automation: {
    objectsRead: ['Account'],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 1,
  },
  lines: [],
  emails: [],
  emailsAsk: false,
  refusals: [],
};

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
    'dataops:automation': { ...idle(), data: NOTHING_FIRES },
  };
});

describe('CleanupPanel', () => {
  it('scans the objects picked with the threshold typed', () => {
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);

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
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);

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
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);
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
    // The org's name arms it, not the word delete: 削除 in Japanese, typed
    // only through an input method.
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'delete' } });
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    // Marked as the page's: what refuses them names its confirmation, not flags.
    expect(states['dataops:automation'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'cleanup',
      objects: [{ objectApiName: 'Account', records: 2 }],
      fromPage: true,
    });
    // Confirmed once what the org runs as the records go was listed.
    expect(states.remove.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectApiName: 'Account',
      recommendation: { kind: 'stale', days: 365 },
      dryRun: false,
      acceptAutomation: true,
      fromPage: true,
    });
  });

  it('reads what fires on what the org deletes along with the records, as the dry run counts it', () => {
    states['dataops:cleanup:scan'].data = scanned;
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);
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
      written: [
        { objectApiName: 'Account', records: 2 },
        { objectApiName: 'Contact', records: 5 },
      ],
    };
    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));
    fireEvent.click(screen.getByTestId('cleanup-delete-btn'));

    // The five contacts the accounts take with them: a flow before their
    // delete was never listed in the confirmation.
    expect(states['dataops:automation'].mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      act: 'cleanup',
      objects: [
        { objectApiName: 'Account', records: 2 },
        { objectApiName: 'Contact', records: 5 },
      ],
      fromPage: true,
    });
  });

  it('holds the delete until what the org runs is read, and until the emails it delivers are let through', () => {
    states['dataops:cleanup:scan'].data = scanned;
    states['dataops:automation'].data = null;
    const { rerender } = render(<CleanupPanel orgId="org-1" orgName="dev1" />);
    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));
    states.plan.data = {
      objectApiName: 'Account',
      dryRun: true,
      plan: { objectApiName: 'Account', label: 'Account', records: 2 },
      truncated: false,
    };
    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));
    fireEvent.click(screen.getByTestId('cleanup-delete-btn'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });

    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('danger-held').textContent).toContain('Waiting for what dev1 runs');

    // The read lands: a flow before the delete that emails the owner, on an
    // org that delivers every email.
    states['dataops:automation'].data = {
      ...NOTHING_FIRES,
      automation: {
        ...NOTHING_FIRES.automation,
        objects: [
          {
            objectApiName: 'Account',
            flows: [
              {
                apiName: 'Tell_Owner',
                label: 'Tell Owner',
                timing: 'afterSave',
                startsOn: 'delete',
                condition: 'read',
                permissions: [],
                messages: [{ kind: 'email', name: 'Send', limit: 'SingleEmail' }],
              },
            ],
            triggers: [],
          },
        ],
      },
      deliverability: {
        reading: { level: 'all' },
        senders: [{ objectApiName: 'Account', kind: 'flow', name: 'Tell Owner', why: 'email' }],
      },
      emailsAsk: true,
    };
    rerender(<CleanupPanel orgId="org-1" orgName="dev1" />);

    expect(screen.getByTestId('dataops-automation-cleanup').textContent).toContain('Tell Owner');
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('dataops-automation-cleanup-accept-emails'));
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(states.remove.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ acceptAutomation: true, acceptEmails: true }),
    );
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
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);

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
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);

    fireEvent.click(screen.getByTestId('cleanup-stale-delete'));

    expect(screen.getByTestId('cleanup-review-truncated').textContent).toContain('1,000');
  });

  it('counts the object again once a delete has run', () => {
    states['dataops:cleanup:scan'].data = scanned;
    const { rerender } = render(<CleanupPanel orgId="org-1" orgName="dev1" />);
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
    rerender(<CleanupPanel orgId="org-1" orgName="dev1" />);

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
    render(<CleanupPanel orgId="org-1" orgName="dev1" />);

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
