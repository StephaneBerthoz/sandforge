import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import type { FrozenLoadPlanInfo, FrozenStatusInfo } from '@sandforge/shared';
import { FrozenLoadTab } from './FrozenLoadTab';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { useNotificationStore } from '../../stores/useNotificationStore';

const ORGS = [
  { id: 'org-dev', alias: 'DEV-SANDBOX', status: 'connected' },
  { id: 'org-qa', alias: 'QA-SANDBOX', status: 'connected' },
];

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ orgs: ORGS, selectedOrgId: 'org-dev' }),
}));

/** What each bridge request answers, by its type, as the tab reads it. */
interface Answer {
  data?: unknown;
  loading?: boolean;
  error?: string | null;
  requestId?: string | null;
}
const answers: Record<string, Answer> = {};
const mutate = vi.fn();

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string) => ({
    mutate: (payload?: Record<string, unknown>) => mutate(requestType, payload),
    data: answers[requestType]?.data ?? null,
    loading: answers[requestType]?.loading ?? false,
    error: answers[requestType]?.error ?? null,
    requestId: answers[requestType]?.requestId ?? null,
    reset: vi.fn(),
  }),
}));

/** A load recorded in `orgId`, as `frozen:status` counts it. */
function loadInto(orgId: string, loadedAt: string, accounts: number) {
  return {
    orgId,
    loadedAt,
    created: [{ objectApiName: 'Account', count: accounts }],
    linked: 0,
    recorded: true,
  };
}

const STATUS: FrozenStatusInfo = {
  configured: true,
  sasDir: '/sas',
  datasetDir: '/sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: {
    version: '1.0.0',
    status: 'frozen',
    frozenAt: '2026-09-24T09:00:00.000Z',
    source: { orgId: 'org-src', decisionDate: '2026-09-24' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1.0.0',
    volumetry: { budgetMax: 100, measured: { Account: 3 }, measuredAt: '2026-09-24' },
    controls: {
      nonReidentification: { passed: true, checks: [], author: 'qa', checkedAt: '2026-09-24' },
      dryRunLoad: null,
      author: 'qa',
      date: '2026-09-24',
    },
  },
  lastLoad: null,
  lastVerifies: [],
  loadRecords: [
    loadInto('org-dev', '2026-09-24T10:05:00.000Z', 1),
    loadInto('org-qa', '2026-09-24T11:05:00.000Z', 4),
  ],
};

const PLAN: FrozenLoadPlanInfo = {
  orgId: 'org-dev',
  mode: { pilot: false, reload: true },
  plannedAt: '2026-10-09T10:00:00.000Z',
  perObject: [
    {
      objectApiName: 'Account',
      fromFiles: 3,
      toInsert: 1,
      reusedByKeys: 2,
      reusedFromCatalog: 0,
      fieldsDropped: 1,
      picklistsRewritten: 0,
      notSent: 0,
      toPurge: 5,
      toDeactivate: 0,
    },
    {
      objectApiName: 'Pricebook2',
      fromFiles: 1,
      toInsert: 0,
      reusedByKeys: 0,
      reusedFromCatalog: 1,
      fieldsDropped: 0,
      picklistsRewritten: 3,
      notSent: 0,
      toPurge: 0,
      toDeactivate: 0,
    },
  ],
  excludedObjects: [],
  removals: [],
  placeholders: [
    {
      objectApiName: 'Contact',
      field: 'Owner__c',
      placeholderObjectApiName: 'Owner__c',
      placeholderName: 'PLACEHOLDER',
      affectedRecords: 2,
    },
  ],
  requiredDefaults: [],
  recordTypeIssues: 0,
  personContacts: 0,
  earlierLoads: 2,
};

const tab = () => <FrozenLoadTab onRefetchStatus={vi.fn()} />;

/** The cells of each row of the preview table, the header row first. */
function previewRows(): string[][] {
  return within(screen.getByTestId('frozen-preview'))
    .getAllByRole('row')
    .map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent?.trim() ?? ''),
    );
}

describe('FrozenLoadTab', () => {
  beforeEach(() => {
    for (const key of Object.keys(answers)) delete answers[key];
    mutate.mockClear();
    useNotificationStore.setState({ notifications: [] });
    useFrozenStore.setState({
      status: STATUS,
      targetOrgId: '',
      progress: [],
      loadReport: null,
      verdict: null,
      lastError: null,
    });
  });

  describe('the last load, and taking it back', () => {
    // One mapping per sas, a load into a second org replaced the first org's,
    // and the card offered only the load the sas held last.
    it('shows the load into the selected target', () => {
      render(tab());

      expect(screen.getByTestId('frozen-removal-loaded').textContent).toContain('DEV-SANDBOX');
    });

    it('shows the load into another target once it is selected, and removes that one', () => {
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-target'));
      fireEvent.click(screen.getByTestId('frozen-load-target-option-org-qa'));

      expect(screen.getByTestId('frozen-removal-loaded').textContent).toContain('QA-SANDBOX');
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'QA-SANDBOX' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mutate).toHaveBeenCalledWith('frozen:remove', {
        targetOrgId: 'org-qa',
        loadedAt: '2026-09-24T11:05:00.000Z',
      });
    });

    it('shows no load for a target none went into', () => {
      useFrozenStore.setState({
        status: { ...STATUS, loadRecords: [loadInto('org-qa', '2026-09-24T11:05:00.000Z', 4)] },
      });

      render(tab());

      expect(screen.queryByTestId('frozen-removal')).toBeNull();
    });
  });

  describe('cancelling the load it started', () => {
    it('offers no cancel while no load runs', () => {
      render(tab());

      expect(screen.queryByTestId('frozen-load-cancel')).toBeNull();
    });

    it('sends execution:abort with the id of the load, and is not offered twice', () => {
      answers['frozen:load'] = { loading: true, requestId: 'req-load-7' };
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-cancel'));

      expect(mutate).toHaveBeenCalledWith('execution:abort', { operationId: 'req-load-7' });
      expect(screen.getByTestId('frozen-load-cancel').getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByTestId('frozen-load-stopping').textContent).toContain('next write');
      fireEvent.click(screen.getByTestId('frozen-load-cancel'));
      expect(mutate.mock.calls.filter(([type]) => type === 'execution:abort')).toHaveLength(1);
    });

    it('says so when the extension refuses the cancel, and offers it again', () => {
      answers['frozen:load'] = { loading: true, requestId: 'req-load-7' };
      const { rerender } = render(tab());
      fireEvent.click(screen.getByTestId('frozen-load-cancel'));

      answers['execution:abort'] = { data: { success: false, error: 'Operation not found' } };
      rerender(tab());

      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({ level: 'warning', title: 'Could not cancel the load' }),
      ]);
      expect(screen.getByTestId('frozen-load-cancel').getAttribute('aria-disabled')).toBeNull();
    });
  });

  describe('previewing the load', () => {
    it('asks what a load with the options chosen would do', () => {
      render(tab());

      fireEvent.click(screen.getByTestId('frozen-load-reload'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));

      expect(mutate).toHaveBeenCalledWith('frozen:load:preview', {
        targetOrgId: 'org-dev',
        reload: true,
      });
      expect(mutate.mock.calls.map(([type]) => type)).not.toContain('frozen:load');
    });

    it('shows, per object, what the load would insert, link, drop, rewrite and purge', () => {
      answers['frozen:load:preview'] = { data: { plan: PLAN } };

      render(tab());

      expect(screen.getByTestId('frozen-preview').textContent).toContain(
        'What a load into DEV-SANDBOX would do',
      );
      expect(previewRows()).toEqual([
        [
          'Object',
          'In the dataset',
          'To insert',
          'Found by identity keys',
          'Found in the catalog',
          'Fields dropped',
          'Picklist values rewritten',
          'To purge',
          'To deactivate',
        ],
        ['Account', '3', '1', '2', '0', '1', '0', '5', '0'],
        ['Pricebook2', '1', '0', '0', '1', '0', '3', '0', '0'],
      ]);
      expect(screen.getByTestId('frozen-preview-reload').textContent).toContain('2 earlier loads');
      expect(screen.getByTestId('frozen-preview-placeholders').textContent).toContain(
        'Contact.Owner__c (2)',
      );
    });

    it('leaves out the purge of a load that is not a reload', () => {
      answers['frozen:load:preview'] = {
        data: { plan: { ...PLAN, mode: { pilot: false, reload: false } } },
      };

      render(tab());

      expect(previewRows()[0]).not.toContain('To purge');
      expect(screen.queryByTestId('frozen-preview-reload')).toBeNull();
    });
  });
});
