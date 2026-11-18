import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { BackupExportResult, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { DataOpsPage } from './DataOpsPage';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockBackupMutate = vi.fn();
const mockBackupReset = vi.fn();
const mockAnonymizeMutate = vi.fn();
const mockAnonymizeReset = vi.fn();
const mockRollbackMutate = vi.fn();

/** Mutable query state for backup:list. */
let mockBackupsQueryState = {
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
};

/** Mutable query state for dataops:anonymization-templates. */
let mockTemplatesQueryState = {
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
};

/** Mutable mutation state for backup:execute. */
let mockBackupMutationState = {
  mutate: mockBackupMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockBackupReset,
};

/** Mutable mutation state for dataops:rollback. */
let mockRollbackMutationState = {
  mutate: mockRollbackMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for dataops:anonymize. */
let mockAnonymizeMutationState = {
  mutate: mockAnonymizeMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockAnonymizeReset,
};

/**
 * Mutable mutation state for the `dataops:anonymize` that gives a run in
 * slices up: the page's second mutation of that type, which waits no longer
 * than a request does.
 */
const mockAbandonMutate = vi.fn();
let mockAbandonMutationState = {
  mutate: mockAbandonMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for dataops:anonymization-template:save. */
let mockSaveTemplateMutationState = {
  mutate: vi.fn(),
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for dataops:anonymization-template:delete. */
let mockDeleteTemplateMutationState = {
  mutate: vi.fn(),
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for backup:export. */
let mockExportMutationState = {
  mutate: vi.fn(),
  data: null as BackupExportResult['payload'] | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for backup:delete. */
let mockDeleteBackupsMutationState = {
  mutate: vi.fn(),
  data: null as { orgId: string; deleted: string[] } | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for dataops:anonymize:preview. */
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
let mockPreviewMutationState = {
  mutate: mockPreviewMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockPreviewReset,
};

/** What `dataops:anonymize:coverage` answers, and how the page last asked it. */
let mockCoverageData: Record<string, unknown> | null = null;
let coverageAsked: { payload?: Record<string, unknown>; skip?: boolean } | null = null;
const mockCoverageRefetch = vi.fn();

/** What `backup:objects` answers, and how the page last asked it. */
let mockBackupObjectsData: { objects: string[] } | null = null;
let backupObjectsAsked: { payload?: Record<string, unknown>; skip?: boolean } | null = null;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (
    type: string,
    payload?: Record<string, unknown>,
    options?: { skip?: boolean },
  ) => {
    if (type === 'backup:list') {
      return mockBackupsQueryState;
    }
    if (type === 'backup:objects') {
      backupObjectsAsked = { payload, skip: options?.skip };
      return { data: mockBackupObjectsData, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'dataops:anonymization-templates') {
      return mockTemplatesQueryState;
    }
    if (type === 'dataops:anonymize:coverage') {
      coverageAsked = { payload, skip: options?.skip };
      return { data: mockCoverageData, loading: false, error: null, refetch: mockCoverageRefetch };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

const mutationOptions: Record<
  string,
  { timeoutMs?: number; runOutlivesWait?: boolean } | undefined
> = {};

/** `execution:abort`, which each tab's Stop sends. */
const mockAbortMutate = vi.fn();

/** What the org runs as a masking or a restore writes, as the extension answers a read of it: nothing. */
const mockAutomationMutate = vi.fn();
const NOTHING_FIRES = {
  act: 'masking',
  objects: [],
  steps: {},
  automation: {
    objectsRead: [],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  },
  lines: [],
  emails: [],
  emailsAsk: false,
  refusals: [],
};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { timeoutMs?: number }) => {
    // Giving a run in slices up is the masking request too, waited on as any request.
    if (type === 'dataops:anonymize' && options?.timeoutMs === undefined) {
      return mockAbandonMutationState;
    }
    mutationOptions[type] = options;
    if (type === 'dataops:automation') {
      return {
        mutate: mockAutomationMutate,
        data: NOTHING_FIRES,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    if (type === 'execution:abort') {
      return { mutate: mockAbortMutate, data: null, loading: false, error: null, reset: vi.fn() };
    }
    if (type === 'backup:execute') {
      return mockBackupMutationState;
    }
    if (type === 'dataops:anonymize') {
      return mockAnonymizeMutationState;
    }
    if (type === 'dataops:rollback') {
      return mockRollbackMutationState;
    }
    if (type === 'backup:export') {
      return mockExportMutationState;
    }
    if (type === 'backup:delete') {
      return mockDeleteBackupsMutationState;
    }
    if (type === 'dataops:anonymization-template:save') {
      return mockSaveTemplateMutationState;
    }
    if (type === 'dataops:anonymization-template:delete') {
      return mockDeleteTemplateMutationState;
    }
    if (type === 'dataops:anonymize:preview') {
      return mockPreviewMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/** What the page sent the extension outside a request: `org:select`. */
const mockSendBridge = vi.fn();
vi.mock('../../bridge/sendBridgeMessage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../bridge/sendBridgeMessage')>()),
  sendBridgeMessage: (...args: unknown[]) => mockSendBridge(...args),
}));

const mockNavigate = vi.fn();
let mockNavigationIntent: Record<string, unknown> | null = null;
const mockClearNavigationIntent = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      navigate: mockNavigate,
      currentRoute: 'dataops',
      navigationIntent: mockNavigationIntent,
      clearNavigationIntent: mockClearNavigationIntent,
    }),
}));

/** Open a tab of the page by the id its `page-tab-*` names it with. */
function openTab(id: string): void {
  fireEvent.click(screen.getByTestId(`page-tab-${id}`));
}

/**
 * Open the Masking tab, the one the page opens on, and wait for its panel: a
 * chunk of its own, fetched the first time the tab is drawn (dataOpsParts.tsx),
 * so it is drawn a moment after the page rather than with it.
 */
async function openAnonymizeTab(): Promise<void> {
  openTab('anonymize');
  await screen.findByTestId('anonymize-panel');
}

describe('DataOpsPage', () => {
  it('waits as long as an anonymize run takes to mask every row, not two minutes', () => {
    render(<DataOpsPage />);

    expect(mutationOptions['dataops:anonymize']?.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    mockBackupObjectsData = null;
    backupObjectsAsked = null;
    mockNavigate.mockClear();
    mockBackupMutate.mockClear();
    mockBackupReset.mockClear();
    mockAnonymizeMutate.mockClear();
    mockAnonymizeReset.mockClear();
    mockRollbackMutate.mockClear();
    // Reset to default idle state
    mockBackupsQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
    mockTemplatesQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
    mockBackupMutationState = {
      mutate: mockBackupMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockBackupReset,
    };
    mockAnonymizeMutationState = {
      mutate: mockAnonymizeMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockAnonymizeReset,
    };
    mockRollbackMutationState = {
      mutate: mockRollbackMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
    mockAbandonMutate.mockClear();
    mockAbandonMutationState = {
      mutate: mockAbandonMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
    mockExportMutationState = {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
    mockDeleteBackupsMutationState = {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
    mockSaveTemplateMutationState = {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
    mockDeleteTemplateMutationState = {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
    mockPreviewMutate.mockClear();
    mockPreviewReset.mockClear();
    mockPreviewMutationState = {
      mutate: mockPreviewMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockPreviewReset,
    };
  });

  it('should show empty state when no orgs', () => {
    useOrgStore.setState({ orgs: [] });
    render(<DataOpsPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-dataops')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should show the data protection journey steps in the empty state', () => {
    useOrgStore.setState({ orgs: [] });
    render(<DataOpsPage />);
    expect(screen.getByText('Protect your org data')).toBeDefined();
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect an org: import it from the Salesforce CLI or log in with your browser',
    );
    // A backup reads only what the templates mask: it is no way back from a
    // run on any other object, as "before any risky operation" said.
    expect(screen.getByTestId('empty-step-1').textContent).toContain(
      'Back up the fields a template masks before you mask them',
    );
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an org');
  });

  it('should navigate to orgs when empty state CTA clicked', () => {
    useOrgStore.setState({ orgs: [] });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('should render the page', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('dataops-page')).toBeDefined();
  });

  it('waits as long as a backup takes to read every page of each object, and a restore to write them back', () => {
    render(<DataOpsPage />);

    expect(mutationOptions['backup:execute']?.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(mutationOptions['dataops:rollback']?.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('waits on a backup, a restore and a masking run as on any write run, and never says to try again', () => {
    render(<DataOpsPage />);

    for (const type of ['backup:execute', 'dataops:rollback', 'dataops:anonymize']) {
      expect(mutationOptions[type]).toMatchObject({
        timeoutMs: WRITE_RUN_TIMEOUT_MS,
        runOutlivesWait: true,
      });
    }
  });

  describe('the Stop of each run the page started', () => {
    beforeEach(() => {
      mockAbortMutate.mockClear();
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    });

    it('stops a backup by the id of its request, as Live Operations does, and holds Create meanwhile', async () => {
      mockBackupMutationState = {
        ...mockBackupMutationState,
        loading: true,
        requestId: 'req-backup-1',
      } as typeof mockBackupMutationState;
      render(<DataOpsPage />);
      await openAnonymizeTab();

      expect(screen.getByTestId('create-backup-btn').hasAttribute('disabled')).toBe(true);
      fireEvent.click(screen.getByTestId('backup-stop'));

      expect(mockAbortMutate).toHaveBeenCalledWith({ operationId: 'req-backup-1' });
      expect(screen.getByTestId('backup-stop-stopping')).toBeDefined();
    });

    it('stops a restore by the id of its request', () => {
      mockRollbackMutationState = {
        ...mockRollbackMutationState,
        loading: true,
        requestId: 'req-restore-1',
      } as typeof mockRollbackMutationState;
      render(<DataOpsPage />);
      openTab('backup');

      fireEvent.click(screen.getByTestId('restore-stop'));

      expect(mockAbortMutate).toHaveBeenCalledWith({ operationId: 'req-restore-1' });
    });

    it('offers no Stop while nothing runs', async () => {
      render(<DataOpsPage />);
      await openAnonymizeTab();
      expect(screen.queryByTestId('backup-stop')).toBeNull();
      openTab('backup');
      expect(screen.queryByTestId('restore-stop')).toBeNull();
    });
  });

  it('asks for the backup list again once a backup ends, so one stopped at the cap is listed as such', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: mockOrgs[0].id });
    const { rerender } = render(<DataOpsPage />);
    expect(mockBackupsQueryState.refetch).not.toHaveBeenCalled();

    mockBackupMutationState = {
      ...mockBackupMutationState,
      data: { operationId: 'bk-1', partial: true },
    };
    rerender(<DataOpsPage />);

    expect(mockBackupsQueryState.refetch).toHaveBeenCalledTimes(1);
  });

  describe('org targeting', () => {
    /** A second org, so "first in the list" and "selected" are different. */
    const secondOrg: SalesforceOrg = { ...mockOrgs[0], id: 'org-2', alias: 'prod-copy' };

    it('should back up the SELECTED org, not the first in the list', async () => {
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: 'org-2' });
      render(<DataOpsPage />);
      await openAnonymizeTab();

      fireEvent.click(screen.getByTestId('create-backup-btn'));

      // Both handlers used to read orgs[0], so a user with several connections
      // backed up and anonymised an org other than the one on screen.
      expect(mockBackupMutate).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-2' }));
    });

    it('backs up every object the templates mask, Lead and Opportunity included, when none is picked', async () => {
      mockTemplatesQueryState = {
        data: {
          templates: [
            {
              id: 'tpl-1',
              name: 'GDPR Template',
              description: '',
              complianceFramework: 'gdpr',
              rules: [
                { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Contact.Phone', ruleType: 'mask', description: '' },
              ],
            },
            {
              id: 'tpl-2',
              name: 'Sandbox scrub',
              description: '',
              complianceFramework: 'custom',
              rules: [
                { fieldPattern: 'Opportunity.Description', ruleType: 'nullify', description: '' },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      render(<DataOpsPage />);
      await openAnonymizeTab();

      expect(screen.getByTestId('backup-objects').textContent).toBe(
        'Backs up Contact, Lead, Opportunity: the objects the masking templates mask.',
      );
      fireEvent.click(screen.getByTestId('create-backup-btn'));

      // It read Account and Contact whatever the templates masked.
      expect(mockBackupMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        objects: ['Contact', 'Lead', 'Opportunity'],
      });
    });

    it('backs up the objects of the template picked, beside it on the Masking tab', async () => {
      mockTemplatesQueryState = {
        data: {
          templates: [
            {
              id: 'tpl-1',
              name: 'GDPR Template',
              description: '',
              complianceFramework: 'gdpr',
              rules: [{ fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' }],
            },
            {
              id: 'tpl-2',
              name: 'Sandbox scrub',
              description: '',
              complianceFramework: 'custom',
              rules: [
                { fieldPattern: 'Opportunity.Description', ruleType: 'nullify', description: '' },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      render(<DataOpsPage />);
      await openAnonymizeTab();
      fireEvent.change(screen.getByTestId('template-select'), { target: { value: 'tpl-1' } });

      expect(screen.getByTestId('backup-objects').textContent).toBe(
        'Backs up Lead: the objects GDPR Template masks.',
      );
      fireEvent.click(screen.getByTestId('create-backup-btn'));

      expect(mockBackupMutate).toHaveBeenCalledWith({ orgId: 'org-1', objects: ['Lead'] });
    });

    it('backs up the objects the host plans for the masking, Account with a template masking contacts in an org with person accounts', async () => {
      mockTemplatesQueryState = {
        data: {
          templates: [
            {
              id: 'tpl-ccpa',
              name: 'CCPA Template',
              description: '',
              complianceFramework: 'ccpa',
              rules: [
                { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
                { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      // The masking run plans Account too: its person accounts hold a contact's fields.
      mockBackupObjectsData = { objects: ['Contact', 'Lead', 'Account'] };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      render(<DataOpsPage />);
      await openAnonymizeTab();

      expect(backupObjectsAsked).toEqual({ payload: { orgId: 'org-1' }, skip: false });
      expect(screen.getByTestId('backup-objects').textContent).toBe(
        'Backs up Contact, Lead, Account: the objects the masking templates mask.',
      );
      fireEvent.click(screen.getByTestId('create-backup-btn'));
      expect(mockBackupMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        objects: ['Contact', 'Lead', 'Account'],
      });

      fireEvent.change(screen.getByTestId('template-select'), {
        target: { value: 'tpl-ccpa' },
      });
      expect(backupObjectsAsked?.payload).toEqual({ orgId: 'org-1', templateId: 'tpl-ccpa' });
    });

    it('offers no backup when no org is selected', async () => {
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: null });
      render(<DataOpsPage />);
      await openAnonymizeTab();

      expect(screen.queryByTestId('create-backup-btn')).toBeNull();
      expect(mockBackupMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId('dataops-no-org')).toBeDefined();
    });

    it('should name the target org in the header before anything is clicked', () => {
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: 'org-2' });
      render(<DataOpsPage />);

      // Writing to an org the page never names is the underlying hazard.
      expect(screen.getByText('prod-copy')).toBeDefined();
    });
  });

  it('should show title', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('DataOps')).toBeDefined();
  });

  it('names its tabs in the order of the work, Masking first, by the ids they always had', () => {
    // Six tabs opened on Backup, a list of what Masking wrote over; Restore
    // listed the same backups again, and Quality counted what Cleanup counted.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getAllByRole('tab').map((tab) => [tab.dataset.testid, tab.textContent])).toEqual([
      ['page-tab-anonymize', 'Masking'],
      ['page-tab-backup', 'Backups'],
      ['page-tab-gdpr', 'Personal data'],
      ['page-tab-cleanup', 'Cleanup'],
      ['page-tab-emptying', 'Emptying'],
    ]);
  });

  it('opens on Masking', async () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('page-tab-anonymize').getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByTestId('anonymize-panel')).toBeDefined();
  });

  it('lists the backups once, on Backups', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    openTab('backup');
    expect(screen.getByTestId('backup-panel')).toBeDefined();
  });

  it('counts the org’s backups on the Backups tab, a set of slices as one', () => {
    // Three cards of counts stood above every tab and pushed their work down.
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    mockBackupsQueryState = {
      ...mockBackupsQueryState,
      data: {
        backups: [0, 1].map((i) => ({
          operationId: `op-${i}`,
          orgId: 'org-1',
          timestamp: '2026-10-01T00:00:00Z',
          status: 'completed',
          objectResults: [],
          totalRecords: 10,
          totalSize: 0,
        })),
        sets: [{ setId: 'set-1', totalRecords: 9, slices: [] }],
      },
    };
    render(<DataOpsPage />);

    expect(screen.getByTestId('page-tab-badge-backup').textContent).toBe('3');
    expect(screen.queryByTestId('dataops-kpi-row')).toBeNull();
    expect(screen.queryAllByTestId('kpi-card')).toEqual([]);
  });

  it('counts no backup while no org is selected: what it counts is an org’s', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    render(<DataOpsPage />);
    expect(screen.queryByTestId('page-tab-badge-backup')).toBeNull();
  });

  it('opens on the tab the navigation names, and on Backups for Restore, Cleanup for Quality', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    for (const [asked, opened] of [
      ['gdpr', 'gdpr'],
      ['restore', 'backup'],
      ['quality', 'cleanup'],
      ['emptying', 'emptying'],
    ]) {
      mockNavigationIntent = { route: 'dataops', dataopsTab: asked };
      try {
        const { unmount } = render(<DataOpsPage />);
        expect(screen.getByTestId(`page-tab-${opened}`).getAttribute('aria-selected')).toBe('true');
        unmount();
      } finally {
        mockNavigationIntent = null;
      }
    }
  });

  // Forge's Review of a clone of the whole org sends the target here, the
  // objects it already holds records of to be emptied first.
  it('opens on Emptying for the org a whole-org clone asked to empty first, that once, and nothing of Cleanup above it', async () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    mockNavigationIntent = { route: 'dataops', targetOrgId: 'org-1', emptyObjects: ['Contact'] };
    try {
      render(<DataOpsPage />);

      expect(screen.getByTestId('page-tab-emptying').getAttribute('aria-selected')).toBe('true');
      expect(await screen.findByTestId('empty-panel')).toBeDefined();
      expect(screen.queryByTestId('cleanup-panel')).toBeNull();
      expect(mockClearNavigationIntent).toHaveBeenCalled();
    } finally {
      mockNavigationIntent = null;
    }
  });

  it('opens on its first tab when the intent names another org than the one selected', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    mockNavigationIntent = { route: 'dataops', targetOrgId: 'org-9', emptyObjects: ['Contact'] };
    try {
      render(<DataOpsPage />);

      expect(screen.getByTestId('page-tab-anonymize').getAttribute('aria-selected')).toBe('true');
    } finally {
      mockNavigationIntent = null;
    }
  });

  describe('the objects Back into service asks to mask', () => {
    const templates = {
      templates: [
        {
          id: 'tpl-all',
          name: 'Everyone',
          description: '',
          complianceFramework: 'gdpr',
          rules: [
            { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
            { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
            { fieldPattern: 'Account.Phone', ruleType: 'mask', description: '' },
          ],
        },
        {
          id: 'tpl-people',
          name: 'People',
          description: '',
          complianceFramework: 'gdpr',
          rules: [
            { fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' },
            { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
          ],
        },
      ],
    };

    beforeEach(() => {
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      mockTemplatesQueryState = { ...mockTemplatesQueryState, data: templates };
    });

    it('opens Masking on the template that masks them, says so, and backs up what it masks', async () => {
      mockNavigationIntent = {
        route: 'dataops',
        dataopsTab: 'anonymize',
        targetOrgId: 'org-1',
        maskObjects: ['Lead', 'Contact'],
      };
      try {
        render(<DataOpsPage />);
        await screen.findByTestId('anonymize-panel');

        expect((screen.getByTestId('template-select') as HTMLSelectElement).value).toBe(
          'tpl-people',
        );
        expect(screen.getByTestId('mask-asked').textContent).toBe(
          'Asked to mask on dev1: Lead, Contact.',
        );
        expect(screen.queryByTestId('mask-asked-left')).toBeNull();
        expect(screen.getByTestId('backup-objects').textContent).toBe(
          'Backs up Contact, Lead: the objects People masks.',
        );
      } finally {
        mockNavigationIntent = null;
      }
    });

    it('names the objects the template picked leaves unmasked, and lets another be picked', async () => {
      mockNavigationIntent = { route: 'dataops', maskObjects: ['Lead', 'Case'] };
      try {
        render(<DataOpsPage />);
        await screen.findByTestId('anonymize-panel');

        expect(screen.getByTestId('mask-asked-left').textContent).toBe(
          'People does not mask Case: pick another template, or create one with Create template.',
        );
        fireEvent.change(screen.getByTestId('template-select'), {
          target: { value: 'tpl-all' },
        });
        expect((screen.getByTestId('template-select') as HTMLSelectElement).value).toBe('tpl-all');
      } finally {
        mockNavigationIntent = null;
      }
    });

    it('says when no template masks them', async () => {
      mockNavigationIntent = { route: 'dataops', maskObjects: ['Case'] };
      try {
        render(<DataOpsPage />);
        await screen.findByTestId('anonymize-panel');

        expect(screen.getByTestId('mask-asked-left').textContent).toBe(
          'No template masks Case: create one with Create template.',
        );
        expect((screen.getByTestId('template-select') as HTMLSelectElement).value).toBe('');
      } finally {
        mockNavigationIntent = null;
      }
    });

    it('asks nothing of another org than the one selected', async () => {
      mockNavigationIntent = { route: 'dataops', targetOrgId: 'org-9', maskObjects: ['Lead'] };
      try {
        render(<DataOpsPage />);
        await screen.findByTestId('anonymize-panel');

        expect(screen.queryByTestId('mask-asked')).toBeNull();
        expect((screen.getByTestId('template-select') as HTMLSelectElement).value).toBe('');
      } finally {
        mockNavigationIntent = null;
      }
    });
  });

  it('should open the cleanup scan on the cleanup tab, for the selected org', async () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    render(<DataOpsPage />);
    openTab('cleanup');
    // A coming-soon notice stood here while no scan produced a recommendation.
    expect(await screen.findByTestId('cleanup-panel')).toBeDefined();
    expect(screen.queryByTestId('dataops-cleanup-soon')).toBeNull();
  });

  it('should open the inventory and the subject requests on the compliance tab', async () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    render(<DataOpsPage />);
    openTab('gdpr');
    // A coming-soon notice stood here while nothing handled a data subject request.
    expect(await screen.findByTestId('compliance-panel')).toBeDefined();
    expect(screen.getByTestId('dsr-section')).toBeDefined();
    expect(screen.queryByTestId('dataops-gdpr-soon')).toBeNull();
  });

  it('should offer no compliance, cleanup or emptying work while no org is selected', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    render(<DataOpsPage />);
    openTab('gdpr');
    expect(screen.queryByTestId('compliance-panel')).toBeNull();
    openTab('cleanup');
    expect(screen.queryByTestId('cleanup-panel')).toBeNull();
    openTab('emptying');
    expect(screen.queryByTestId('empty-panel')).toBeNull();
    expect(screen.getByTestId('dataops-no-org')).toBeDefined();
  });

  it('opens Emptying on a tab of its own, Cleanup’s scan not above it', async () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    render(<DataOpsPage />);
    openTab('cleanup');
    expect(await screen.findByTestId('cleanup-panel')).toBeDefined();
    expect(screen.queryByTestId('empty-panel')).toBeNull();

    openTab('emptying');
    expect(await screen.findByTestId('empty-panel')).toBeDefined();
    expect(screen.queryByTestId('cleanup-panel')).toBeNull();
  });

  it('should display error from bridge hook', () => {
    mockBackupsQueryState = {
      data: null,
      loading: false,
      error: 'Backup failed',
      refetch: vi.fn(),
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);

    expect(screen.getByTestId('dataops-error')).toBeDefined();
    expect(screen.getByText('Backup failed')).toBeDefined();
  });

  describe('a backup exported', () => {
    it('waits while the user picks a file and the host writes every record to it', () => {
      render(<DataOpsPage />);

      expect(mutationOptions['backup:export']?.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
    });

    it('says where the host wrote the backup and how many records of each object it holds', () => {
      useNotificationStore.setState({ notifications: [] });
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      const { rerender } = render(<DataOpsPage />);

      mockExportMutationState = {
        ...mockExportMutationState,
        data: {
          operationId: 'op-1',
          status: 'saved',
          path: '/home/u/backup.json',
          objects: [
            { objectApiName: 'Contact', records: 1234 },
            { objectApiName: 'Lead', records: 0 },
          ],
        },
      };
      rerender(<DataOpsPage />);

      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({
          level: 'success',
          message: 'Saved to /home/u/backup.json. Records per object: Contact 1,234, Lead 0.',
        }),
      ]);
      expect(mockExportMutationState.reset).toHaveBeenCalled();
    });

    it('says nothing when the dialog was dismissed', () => {
      useNotificationStore.setState({ notifications: [] });
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      const { rerender } = render(<DataOpsPage />);

      mockExportMutationState = {
        ...mockExportMutationState,
        data: { operationId: 'op-1', status: 'cancelled' },
      };
      rerender(<DataOpsPage />);

      expect(useNotificationStore.getState().notifications).toEqual([]);
      expect(mockExportMutationState.reset).toHaveBeenCalled();
    });
  });

  describe('backups deleted from this machine', () => {
    const listed = {
      backups: [
        {
          operationId: 'op-1',
          orgId: 'org-1',
          timestamp: '2026-10-01T00:00:00Z',
          status: 'completed',
          objectResults: [{ objectApiName: 'Contact', recordCount: 3 }],
          totalRecords: 3,
          totalSize: 0,
        },
      ],
    };

    it('deletes a backup from its row on Backups, and every one of the selected org', () => {
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      mockBackupsQueryState = { ...mockBackupsQueryState, data: listed };
      render(<DataOpsPage />);
      openTab('backup');

      fireEvent.click(screen.getByTestId('delete-backup-btn-op-1'));
      fireEvent.click(screen.getByTestId('delete-backup-confirm'));
      expect(mockDeleteBackupsMutationState.mutate).toHaveBeenLastCalledWith({
        orgId: 'org-1',
        operationIds: ['op-1'],
      });

      fireEvent.click(screen.getByTestId('delete-all-backups-btn'));
      fireEvent.click(screen.getByTestId('delete-backup-confirm'));
      expect(mockDeleteBackupsMutationState.mutate).toHaveBeenLastCalledWith({ orgId: 'org-1' });
    });

    it('asks for the list again once the host deleted them, and says how many', () => {
      useNotificationStore.setState({ notifications: [] });
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      const { rerender } = render(<DataOpsPage />);
      const refetch = mockBackupsQueryState.refetch;

      mockDeleteBackupsMutationState = {
        ...mockDeleteBackupsMutationState,
        data: { orgId: 'org-1', deleted: ['op-1', 'op-2'] },
      };
      rerender(<DataOpsPage />);

      expect(refetch).toHaveBeenCalled();
      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({
          level: 'success',
          message: '2 backups deleted from this machine.',
        }),
      ]);
    });
  });

  it('should show the error of an export the extension refused', () => {
    // The effect that surfaces bridge errors read the export's error without
    // re-running when it changed, so a refused export left the page silent.
    useOrgStore.setState({ orgs: mockOrgs });
    const { rerender } = render(<DataOpsPage />);
    expect(screen.queryByTestId('dataops-error')).toBeNull();

    mockExportMutationState = { ...mockExportMutationState, error: 'Backup too large to export' };
    rerender(<DataOpsPage />);

    expect(screen.getByTestId('dataops-error')).toBeDefined();
    expect(screen.getByText('Backup too large to export')).toBeDefined();
  });

  describe('the org picker in the header', () => {
    const secondOrg: SalesforceOrg = {
      ...mockOrgs[0],
      id: 'org-2',
      alias: 'uat-copy',
      orgType: 'Production',
      metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
    };

    it('picks the org the page works on, as everywhere else, and shows its type beside it', () => {
      // A read-only badge stood there, and with no org the page sent the user
      // to the Organizations page to pick one.
      mockSendBridge.mockClear();
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: 'org-1' });
      render(<DataOpsPage />);

      expect(screen.getByTestId('dataops-org').textContent).toContain('dev1');
      fireEvent.click(screen.getByTestId('dataops-org'));
      fireEvent.click(screen.getByTestId('dataops-org-option-org-2'));

      expect(useOrgStore.getState().selectedOrgId).toBe('org-2');
      expect(mockSendBridge).toHaveBeenCalledWith('org:select', { orgId: 'org-2' });
      expect(screen.getByTestId('dataops-org-type').textContent).toBe('PROD');
    });

    it('says, with no org selected, to pick one in that list', () => {
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
      render(<DataOpsPage />);
      expect(screen.getByTestId('dataops-no-org').textContent).toContain(
        'No org selected: pick one in the list above.',
      );
      expect(screen.queryByTestId('dataops-org-type')).toBeNull();
    });
  });

  describe('a checkpoint offered on the Backups tab', () => {
    it('opens Checkpoints on a take of the org selected', () => {
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      render(<DataOpsPage />);
      openTab('backup');

      fireEvent.click(screen.getByTestId('backup-checkpoint-take'));
      expect(mockNavigate).toHaveBeenCalledWith('checkpoint', {
        takeCheckpoint: true,
        targetOrgId: 'org-1',
      });
    });

    it('is not offered on a production org, where a checkpoint is refused', () => {
      useOrgStore.setState({
        orgs: [
          {
            ...mockOrgs[0],
            orgType: 'Production',
            metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
          },
        ],
        selectedOrgId: 'org-1',
      });
      render(<DataOpsPage />);
      openTab('backup');
      expect(screen.queryByTestId('backup-checkpoint')).toBeNull();
    });
  });

  it('opens Masking, where Create backup is, from Backups of an org with no backup', async () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    mockBackupsQueryState = { ...mockBackupsQueryState, data: { backups: [] } };
    render(<DataOpsPage />);
    openTab('backup');

    expect(screen.getByText('No backup of dev1 yet')).toBeDefined();
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(screen.getByTestId('page-tab-anonymize').getAttribute('aria-selected')).toBe('true');
    await screen.findByTestId('anonymize-panel');
    expect(screen.getByTestId('backup-create')).toBeDefined();
  });

  it('should render the BentoTile wrapper', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    render(<DataOpsPage />);
    expect(screen.getAllByTestId('bento-tile').length).toBeGreaterThanOrEqual(1);
  });

  describe('per-tab loading state', () => {
    /** A backup list already in hand, so a stale skeleton would stack on top of it. */
    const loadedBackups = {
      backups: [
        {
          operationId: 'op-1',
          orgId: 'org-1',
          timestamp: '2024-01-01T00:00:00Z',
          totalRecords: 42,
          totalSize: 1024,
          status: 'completed',
          objectResults: [{ objectApiName: 'Account', recordCount: 42 }],
        },
      ],
    };

    const loading = () => ({ data: null, loading: true, error: null, refetch: vi.fn() });

    beforeEach(() => {
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    });

    it('should keep the loaded backup list visible while the templates query is still in flight', () => {
      mockBackupsQueryState = {
        data: loadedBackups,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      mockTemplatesQueryState = loading();
      render(<DataOpsPage />);
      openTab('backup');

      // The Backups tab never reads dataops:anonymization-templates, so that
      // query's latency must not paint anything over its data.
      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(screen.getByTestId('backup-panel')).toBeDefined();
      expect(screen.getByTestId('backup-op-1')).toBeDefined();
    });

    it('should keep the anonymize templates visible while the backups query is still in flight', async () => {
      mockBackupsQueryState = loading();
      mockTemplatesQueryState = {
        data: { templates: [] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      render(<DataOpsPage />);
      await openAnonymizeTab();

      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(screen.getByTestId('anonymize-panel')).toBeDefined();
    });

    it('keeps the Backups panel and the control the keyboard is on drawn while the backups are read again', () => {
      // A deletion reads the list again, and the skeleton took the panel's
      // place: the Delete button the confirmation hands focus back to went
      // with it, and the keyboard was left on nothing.
      mockBackupsQueryState = {
        data: loadedBackups,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      const { rerender } = render(<DataOpsPage />);
      openTab('backup');
      const deleteButton = screen.getByTestId('delete-backup-btn-op-1');
      deleteButton.focus();

      mockBackupsQueryState = { ...mockBackupsQueryState, loading: true };
      rerender(<DataOpsPage />);

      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(screen.getByTestId('backup-panel')).toBeDefined();
      expect(screen.getByTestId('delete-backup-btn-op-1')).toBe(deleteButton);
      expect(document.activeElement).toBe(deleteButton);
      expect(screen.getByTestId('dataops-content').getAttribute('aria-busy')).toBe('true');

      mockBackupsQueryState = { ...mockBackupsQueryState, loading: false };
      rerender(<DataOpsPage />);
      expect(screen.getByTestId('dataops-content').hasAttribute('aria-busy')).toBe(false);
    });

    it('keeps the Masking panel drawn while its templates are read again after a save', async () => {
      mockTemplatesQueryState = {
        data: { templates: [] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      const { rerender } = render(<DataOpsPage />);
      await openAnonymizeTab();
      const panel = screen.getByTestId('anonymize-panel');

      mockTemplatesQueryState = { ...mockTemplatesQueryState, loading: true };
      rerender(<DataOpsPage />);

      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(screen.getByTestId('anonymize-panel')).toBe(panel);
    });

    it('should show the skeleton alone on the backup tab while its own query loads', () => {
      mockBackupsQueryState = loading();
      render(<DataOpsPage />);
      openTab('backup');

      expect(screen.getByTestId('dataops-skeleton')).toBeDefined();
      expect(screen.queryByTestId('backup-panel')).toBeNull();
    });

    it('should show the skeleton alone on the masking tab while the templates query loads', () => {
      mockTemplatesQueryState = loading();
      render(<DataOpsPage />);

      expect(screen.getByTestId('dataops-skeleton')).toBeDefined();
      expect(screen.queryByTestId('anonymize-panel')).toBeNull();
    });

    it('should not skeleton the cleanup or compliance tab on the backup or template queries', async () => {
      mockBackupsQueryState = loading();
      mockTemplatesQueryState = loading();
      render(<DataOpsPage />);
      openTab('cleanup');

      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(await screen.findByTestId('cleanup-panel')).toBeDefined();

      openTab('gdpr');
      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(await screen.findByTestId('compliance-panel')).toBeDefined();
    });

    it('should not skeleton the emptying tab on the backup or template queries', async () => {
      mockBackupsQueryState = loading();
      mockTemplatesQueryState = loading();
      render(<DataOpsPage />);
      openTab('emptying');

      expect(screen.queryByTestId('dataops-skeleton')).toBeNull();
      expect(await screen.findByTestId('empty-panel')).toBeDefined();
    });
  });
  describe('anonymize safety', () => {
    const templateList = {
      templates: [
        {
          id: 'tpl-1',
          name: 'GDPR Template',
          description: 'Anonymize PII',
          // What the host sends: `Object.Field` and the method.
          rules: [{ fieldPattern: 'Contact.Email', ruleType: 'mask', description: '' }],
          complianceFramework: 'gdpr',
        },
      ],
    };

    /** Open the anonymize tab with one template picked. */
    const openTemplate = async () => {
      mockTemplatesQueryState = {
        data: templateList,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      render(<DataOpsPage />);
      await openAnonymizeTab();
      fireEvent.change(screen.getByTestId('template-select'), { target: { value: 'tpl-1' } });
    };

    it('previews through a request of its own, which masks nothing, for the org and template on screen', async () => {
      await openTemplate();

      // onPreview and onApply were the same handler, so the button labelled
      // "Preview" masked the org's records irreversibly.
      fireEvent.click(screen.getByTestId('preview-btn'));

      expect(mockPreviewMutate).toHaveBeenCalledWith({ orgId: 'org-1', templateId: 'tpl-1' });
      expect(mockAnonymizeMutate).not.toHaveBeenCalled();
    });

    it('shows what the preview answered, original beside masked', async () => {
      mockPreviewMutationState = {
        ...mockPreviewMutationState,
        data: {
          templateId: 'tpl-1',
          objects: [
            {
              objectApiName: 'Contact',
              fields: ['Email'],
              rows: [
                {
                  id: '003000000000001',
                  before: { Email: 'ada@example.org' },
                  after: { Email: '***@*******.***' },
                },
              ],
            },
          ],
          fieldsNotFound: [],
        },
      };
      await openTemplate();

      expect(screen.getByTestId('preview-object-Contact').textContent).toContain('ada@example.org');
      expect(screen.getByTestId('preview-object-Contact').textContent).toContain('***@*******.***');
    });

    it('lets go of a preview when the org changes, and when a run masks what it showed', async () => {
      await openTemplate();
      mockPreviewReset.mockClear();

      act(() => {
        useOrgStore.setState({
          orgs: [...mockOrgs, { ...mockOrgs[0], id: 'org-2', alias: 'dev2' }],
          selectedOrgId: 'org-2',
        });
      });
      expect(mockPreviewReset).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('apply-btn'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev2' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mockPreviewReset).toHaveBeenCalledTimes(2);
    });

    it('should require a typed confirmation before sending dataops:anonymize', async () => {
      await openTemplate();

      fireEvent.click(screen.getByTestId('apply-btn'));
      expect(mockAnonymizeMutate).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      // With a snapshot of what it masks unless unticked, as the command line sends it.
      expect(mockAnonymizeMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        templateId: 'tpl-1',
        snapshot: true,
        // Confirmed once what the org runs as the records are masked was listed.
        acceptAutomation: true,
        // The page's: what refuses it names its confirmation, not the command line's flags.
        fromPage: true,
      });
    });

    it('stops a masking run by the id of its request', async () => {
      mockAbortMutate.mockClear();
      mockAnonymizeMutationState = {
        ...mockAnonymizeMutationState,
        loading: true,
        requestId: 'req-mask-1',
      } as typeof mockAnonymizeMutationState;
      await openTemplate();

      fireEvent.click(screen.getByTestId('anonymize-stop'));

      expect(mockAnonymizeMutate).not.toHaveBeenCalled();
      expect(mockAbortMutate).toHaveBeenCalledWith({ operationId: 'req-mask-1' });
    });

    it('opens Backups on the snapshot a masking run took, listed with the backups', async () => {
      mockAnonymizeMutationState = {
        ...mockAnonymizeMutationState,
        data: {
          templateId: 'tpl-1',
          status: 'success',
          snapshot: { operationId: 'req-mask-1-snapshot', totalRecords: 3 },
        },
      };
      await openTemplate();
      // The snapshot is a backup of the org: the list is read again to hold it.
      expect(mockBackupsQueryState.refetch).toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('anonymize-open-restore'));

      expect(screen.getByTestId('backup-panel')).toBeDefined();
      expect(screen.getByTestId('page-tab-backup').getAttribute('aria-selected')).toBe('true');
    });

    it('says a run refused for its snapshot masked nothing, and how to mask without one', async () => {
      mockAnonymizeMutationState = {
        ...mockAnonymizeMutationState,
        error: 'No snapshot was taken, so nothing was masked: INVALID_TYPE',
        errorCode: 'SNAPSHOT_NOT_TAKEN',
      } as typeof mockAnonymizeMutationState;
      await openTemplate();

      expect(screen.getByTestId('anonymize-snapshot-refused')).toBeDefined();
    });

    it('asks, for the template picked, what a restore of the org’s latest backup brings back, and says it before Apply', async () => {
      mockCoverageData = {
        templateId: 'tpl-1',
        backup: { operationId: 'bk-1', timestamp: '2026-10-01T10:00:00.000Z' },
        objects: [{ objectApiName: 'Contact', count: 30000, backedUp: 2000, truncated: true }],
      };
      await openTemplate();

      expect(coverageAsked).toEqual({
        payload: { orgId: 'org-1', templateId: 'tpl-1' },
        skip: false,
      });
      expect(screen.getByTestId('restore-coverage-shortfall').textContent).toContain('Contact');
      mockCoverageData = null;
    });

    it('resumes the run that stopped short from where it stopped, naming it', async () => {
      mockCoverageData = {
        templateId: 'tpl-1',
        objects: [{ objectApiName: 'Contact', count: 2500, backedUp: 2500, truncated: false }],
        checkpoint: { id: 'run-1', savedAt: '2026-10-09T10:00:00.000Z' },
      };
      await openTemplate();

      fireEvent.click(screen.getByTestId('resume-btn'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(mockAnonymizeMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        templateId: 'tpl-1',
        resumeFrom: 'run-1',
        acceptAutomation: true,
        fromPage: true,
      });
      mockCoverageData = null;
    });

    it('asks again whether a run can be resumed once one ends', () => {
      mockTemplatesQueryState = {
        data: templateList,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      const { rerender } = render(<DataOpsPage />);
      mockCoverageRefetch.mockClear();

      // A run that stopped short leaves a checkpoint, and one that finished forgets it.
      mockAnonymizeMutationState = { ...mockAnonymizeMutationState, data: { status: 'partial' } };
      rerender(<DataOpsPage />);

      expect(mockCoverageRefetch).toHaveBeenCalledTimes(1);
    });

    it('asks nothing until a template is picked on the Masking tab', () => {
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      render(<DataOpsPage />);

      expect(coverageAsked?.skip).toBe(true);
    });
  });

  describe('templates the user saves', () => {
    const shipped = {
      id: 'tpl-1',
      name: 'GDPR Template',
      description: 'Anonymize PII',
      complianceFramework: 'gdpr',
      rules: [{ fieldPattern: 'Contact.Email', ruleType: 'mask', description: '' }],
    };
    const saved = {
      id: 'tpl-saved-1',
      name: 'Support desk',
      description: '',
      complianceFramework: 'custom',
      rules: [{ fieldPattern: 'Contact.Email', ruleType: 'fake', description: '' }],
      saved: true,
    };

    const openAnonymize = async (templates: unknown[] = [shipped]) => {
      mockTemplatesQueryState = {
        data: { templates },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      const view = render(<DataOpsPage />);
      await openAnonymizeTab();
      return view;
    };

    it('sends the rules on screen, under the name given, to be saved', async () => {
      await openAnonymize();
      fireEvent.change(screen.getByTestId('template-select'), { target: { value: 'tpl-1' } });
      fireEvent.click(screen.getByTestId('create-template-btn'));
      fireEvent.change(screen.getByTestId('template-name-input'), {
        target: { value: 'Support desk' },
      });
      fireEvent.change(screen.getByTestId('template-rule-method-0'), {
        target: { value: 'fake' },
      });
      fireEvent.click(screen.getByTestId('template-save'));

      expect(mockSaveTemplateMutationState.mutate).toHaveBeenCalledWith({
        name: 'Support desk',
        rules: [{ fieldPattern: 'Contact.Email', ruleType: 'fake' }],
      });
    });

    it('lists the saved template again from the host, picks it, and says it is saved', async () => {
      const view = await openAnonymize();
      mockSaveTemplateMutationState = {
        ...mockSaveTemplateMutationState,
        data: { template: saved },
      };
      mockTemplatesQueryState = {
        ...mockTemplatesQueryState,
        data: { templates: [shipped, saved] },
      };
      view.rerender(<DataOpsPage />);

      expect(mockTemplatesQueryState.refetch).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('template-detail').textContent).toContain('Support desk');
      expect((screen.getByTestId('template-select') as HTMLSelectElement).value).toBe(
        'tpl-saved-1',
      );
    });

    it('shows why the host refused a save', async () => {
      mockSaveTemplateMutationState = {
        ...mockSaveTemplateMutationState,
        error: 'A template named "GDPR Template" already exists. Pick another name.',
      };
      await openAnonymize();

      expect(screen.getByTestId('dataops-error').textContent).toContain('already exists');
    });

    it('deletes a saved template, lists the templates again, and lets go of it', async () => {
      const view = await openAnonymize([shipped, saved]);
      fireEvent.change(screen.getByTestId('template-select'), {
        target: { value: 'tpl-saved-1' },
      });
      fireEvent.click(screen.getByTestId('delete-template-btn'));
      fireEvent.click(screen.getByTestId('delete-template-confirm'));
      expect(mockDeleteTemplateMutationState.mutate).toHaveBeenCalledWith({
        templateId: 'tpl-saved-1',
      });

      mockDeleteTemplateMutationState = {
        ...mockDeleteTemplateMutationState,
        data: { templateId: 'tpl-saved-1', deleted: true },
      };
      mockTemplatesQueryState = { ...mockTemplatesQueryState, data: { templates: [shipped] } };
      view.rerender(<DataOpsPage />);

      expect(mockTemplatesQueryState.refetch).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('template-detail')).toBeNull();
      expect((screen.getByTestId('template-select') as HTMLSelectElement).value).toBe('');
    });
  });

  describe('restore feedback', () => {
    const loadedBackups = {
      backups: [
        {
          operationId: 'op-1',
          orgId: 'org-1',
          timestamp: '2024-01-01T00:00:00Z',
          totalRecords: 42,
          totalSize: 1024,
          status: 'completed',
          objectResults: [{ objectApiName: 'Account', recordCount: 42 }],
        },
      ],
    };

    beforeEach(() => {
      mockBackupsQueryState = {
        data: loadedBackups,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    });

    /** Open Backups, where each backup is listed with its Restore…. */
    const selectBackup = () => {
      render(<DataOpsPage />);
      openTab('backup');
    };

    it('should surface a failed rollback instead of failing silently', () => {
      mockRollbackMutationState = {
        ...mockRollbackMutationState,
        error: 'Rollback failed: INSUFFICIENT_ACCESS',
      };
      render(<DataOpsPage />);

      // dataops:rollback was the one mutation left out of the error funnel:
      // a restore that wrote nothing looked exactly like one that succeeded.
      expect(screen.getByTestId('dataops-error')).toBeDefined();
      expect(screen.getByText('Rollback failed: INSUFFICIENT_ACCESS')).toBeDefined();
    });

    it('should refuse a second restore while the first one is still writing', () => {
      mockRollbackMutationState = { ...mockRollbackMutationState, loading: true };
      selectBackup();

      const restoreBtn = screen.getByTestId('restore-btn-op-1');
      expect(restoreBtn.getAttribute('aria-disabled')).toBe('true');

      fireEvent.click(restoreBtn);
      expect(mockRollbackMutate).not.toHaveBeenCalled();
    });

    it('sends no rollback on the click, only once the question naming the org is answered yes', () => {
      // The click wrote into the org, which the button never named.
      selectBackup();

      fireEvent.click(screen.getByTestId('restore-btn-op-1'));
      expect(mockRollbackMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId('danger-title').textContent).toMatch(/into dev1\?$/);

      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mockRollbackMutate).toHaveBeenCalledTimes(1);
      expect(mockRollbackMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        operationId: 'op-1',
        // Confirmed once what the org runs as the values go back was listed.
        acceptAutomation: true,
        fromPage: true,
      });
    });

    it('sends no rollback when the question is dismissed', () => {
      selectBackup();

      fireEvent.click(screen.getByTestId('restore-btn-op-1'));
      fireEvent.click(screen.getByTestId('danger-dismiss-btn'));

      expect(mockRollbackMutate).not.toHaveBeenCalled();
    });

    it('asks the restore to write every row back once the box in its question says so', () => {
      selectBackup();

      fireEvent.click(screen.getByTestId('restore-btn-op-1'));
      fireEvent.click(screen.getByTestId('restore-rewrite-all'));
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(mockRollbackMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        operationId: 'op-1',
        rewriteAll: true,
        acceptAutomation: true,
        fromPage: true,
      });
    });

    describe('the backup a Sync run kept of what it wrote over', () => {
      beforeEach(() => {
        mockBackupsQueryState = {
          ...mockBackupsQueryState,
          data: {
            backups: [{ ...loadedBackups.backups[0], operationId: 'op-1', origin: 'sync' }],
          },
        };
      });

      it('asks the restore to include the records changed since the run once the box in its question says so', () => {
        selectBackup();

        fireEvent.click(screen.getByTestId('restore-btn-op-1'));
        fireEvent.click(screen.getByTestId('restore-include-changed-op-1'));
        fireEvent.click(screen.getByTestId('danger-confirm-btn'));

        expect(mockRollbackMutate).toHaveBeenCalledWith({
          orgId: 'org-1',
          operationId: 'op-1',
          includeChanged: true,
          acceptAutomation: true,
          fromPage: true,
        });
      });

      it('lists what the restore left as it is, changed since the run, from its answer', () => {
        mockRollbackMutationState = {
          ...mockRollbackMutationState,
          data: {
            status: 'partial',
            totalRestored: 1,
            totalFailed: 0,
            totalUnchanged: 0,
            keptChanged: { total: 1, objects: [{ objectApiName: 'Account', count: 1 }] },
          },
        };
        selectBackup();

        expect(screen.getByTestId('restore-kept-changed').textContent).toContain('Account 1');
      });
    });

    it('says what the restore wrote and what it found unchanged, from its answer', () => {
      mockRollbackMutationState = {
        ...mockRollbackMutationState,
        data: { status: 'success', totalRestored: 3, totalFailed: 0, totalUnchanged: 39 },
      };
      selectBackup();

      expect(screen.getByTestId('restore-result').textContent).toBe(
        'Last restore — written: 3 · already as in the backup, left alone: 39 · refused: 0',
      );
    });

    it('offers a backup whose read failed part-way, marked partial, and restores it', () => {
      // Listed on the Backup tab alone, it could be restored from the command line only.
      mockBackupsQueryState = {
        ...mockBackupsQueryState,
        data: {
          backups: [
            {
              operationId: 'op-failed',
              orgId: 'org-1',
              timestamp: '2024-01-02T00:00:00Z',
              totalRecords: 1300,
              totalSize: 0,
              status: 'failed',
              partial: true,
              objectResults: [
                { objectApiName: 'Account', recordCount: 300, orgCount: 300, truncated: false },
                {
                  objectApiName: 'Contact',
                  recordCount: 1000,
                  orgCount: 1234,
                  truncated: true,
                  stoppedAt: 'failure',
                },
              ],
            },
          ],
        },
      };
      render(<DataOpsPage />);
      openTab('backup');

      expect(screen.getByTestId('backup-status-op-failed').textContent).toBe('Partial');
      expect(screen.getByTestId('backup-partial-op-failed').textContent).toContain(
        'Contact: 1,000 of 1,234 rows read — the read failed there.',
      );
      fireEvent.click(screen.getByTestId('restore-btn-op-failed'));
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(mockRollbackMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        operationId: 'op-failed',
        acceptAutomation: true,
        fromPage: true,
      });
    });
  });

  describe('masking and backing up in slices', () => {
    const templateList = {
      templates: [
        {
          id: 'tpl-1',
          name: 'GDPR Template',
          description: 'Anonymize PII',
          rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' }],
          complianceFramework: 'gdpr',
        },
      ],
    };
    /** The coverage of an org whose contacts hold more rows than one backup does. */
    const past = {
      templateId: 'tpl-1',
      objects: [
        {
          objectApiName: 'Contact',
          count: 3_002,
          backedUp: 0,
          truncated: false,
          slicePlan: { objectApiName: 'Contact', size: 1_000, slices: 4 },
        },
      ],
      plan: {
        requests: 40,
        parts: { snapshots: 6, updates: 17, reads: 17 },
        bulkBatches: 0,
        diskBytes: 1_000_000,
        seconds: 60,
        apiBudget: { verdict: 'fits', remaining: 4_861_233, max: 5_000_000 },
      },
    };
    /** A set of slices as `backup:list` gives it. */
    const set = {
      setId: 'set-1',
      orgId: 'org-1',
      kind: 'masking',
      state: 'done',
      startedAt: '2026-11-14T08:00:00.000Z',
      lastActivityAt: '2026-11-14T09:00:00.000Z',
      size: 1_000,
      totalRecords: 2_000,
      templateId: 'tpl-1',
      slices: [1, 2].map((index) => ({
        index,
        objectApiName: 'Contact',
        snapshotId: `set-1-s000${index}`,
        rows: 1_000,
        masked: 1_000,
        refused: 0,
        deletedSince: 0,
        nothingToMask: 0,
        state: 'masked',
      })),
    };

    beforeEach(() => {
      mockTemplatesQueryState = {
        data: templateList,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      useNotificationStore.setState({ notifications: [] });
    });

    /** Open the Masking tab on the template, the coverage answering `coverage`. */
    const openTemplate = async (coverage: Record<string, unknown>) => {
      mockCoverageData = coverage;
      const view = render(<DataOpsPage />);
      await openAnonymizeTab();
      fireEvent.change(screen.getByTestId('template-select'), { target: { value: 'tpl-1' } });
      return view;
    };

    it('masks in slices, each a snapshot, once the confirmation’s box asks for them', async () => {
      await openTemplate(past);
      fireEvent.click(screen.getByTestId('apply-btn'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
      fireEvent.click(screen.getByTestId('confirm-slices-toggle'));
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(mockAnonymizeMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        templateId: 'tpl-1',
        snapshot: true,
        slices: true,
        acceptAutomation: true,
        fromPage: true,
      });
      mockCoverageData = null;
    });

    it('resumes an open set in slices, and gives one up with a request that masks nothing', async () => {
      await openTemplate({
        ...past,
        checkpoint: { id: 'ck-1', savedAt: '2026-11-14T10:00:00.000Z' },
        sliceSet: {
          setId: 'set-1',
          savedAt: '2026-11-14T10:00:00.000Z',
          done: 2,
          total: 4,
          state: 'open',
          size: 1_000,
        },
      });

      fireEvent.click(screen.getByTestId('resume-btn'));
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev1' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mockAnonymizeMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        templateId: 'tpl-1',
        resumeFrom: 'ck-1',
        slices: true,
        acceptAutomation: true,
        fromPage: true,
      });

      fireEvent.click(screen.getByTestId('abandon-btn'));
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(mockAbandonMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        templateId: 'tpl-1',
        abandon: true,
        fromPage: true,
      });
      mockCoverageData = null;
    });

    it('asks the coverage and the list again once a set is given up', async () => {
      const { rerender } = await openTemplate(past);
      mockCoverageRefetch.mockClear();
      const listAgain = mockBackupsQueryState.refetch;

      mockAbandonMutationState = {
        ...mockAbandonMutationState,
        data: { status: 'success', abandoned: true, slices: { setId: 'set-1', objects: [] } },
      };
      rerender(<DataOpsPage />);

      expect(mockCoverageRefetch).toHaveBeenCalledTimes(1);
      expect(listAgain).toHaveBeenCalled();
      mockCoverageData = null;
    });

    it('says a run in slices ended, slices left or not, where any tab shows it', () => {
      const { rerender } = render(<DataOpsPage />);
      const result = (state: string) => ({
        status: 'success',
        slices: {
          setId: 'set-1',
          size: 1_000,
          state,
          objects: [{ objectApiName: 'Contact', slices: set.slices }],
          lateRecords: 0,
          requestsSpent: 40,
          slicesLeft: state === 'open',
        },
      });

      mockAnonymizeMutationState = { ...mockAnonymizeMutationState, data: result('done') };
      rerender(<DataOpsPage />);
      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({
          level: 'success',
          message: 'Masking in slices finished: 2 of 2 slices masked, each with its backup.',
        }),
      ]);

      useNotificationStore.setState({ notifications: [] });
      mockAnonymizeMutationState = { ...mockAnonymizeMutationState, data: result('open') };
      rerender(<DataOpsPage />);
      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({
          level: 'warning',
          message:
            'Masking in slices stopped with slices left: 2 of 2 masked. Resume, on the ' +
            'Masking tab, carries on.',
        }),
      ]);
    });

    it('lists the org’s sets in Backups, and restores one slice of one by its set', () => {
      mockBackupsQueryState = {
        data: { backups: [], sets: [set] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      render(<DataOpsPage />);
      openTab('backup');

      fireEvent.click(screen.getByTestId('restore-set-set-1-toggle'));
      fireEvent.click(screen.getByTestId('restore-set-set-1-slices-2-restore'));
      expect(mockRollbackMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId('danger-title').textContent).toMatch(/^Restore slice 2 of the set/);
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(mockRollbackMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        operationId: 'set-1',
        slices: [2],
        acceptAutomation: true,
        fromPage: true,
      });
    });

    it('counts a set among the org’s backups', () => {
      mockBackupsQueryState = {
        data: { backups: [], sets: [set] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      render(<DataOpsPage />);

      expect(screen.getByTestId('page-tab-badge-backup').textContent).toBe('1');
    });

    it('offers a backup in slices of an object the last backup stopped at the cap for, and takes it so', async () => {
      mockBackupObjectsData = { objects: ['Contact'] };
      mockBackupsQueryState = {
        data: {
          backups: [
            {
              operationId: 'op-1',
              orgId: 'org-1',
              timestamp: '2026-11-14T08:00:00.000Z',
              totalRecords: 1_000,
              totalSize: 0,
              status: 'completed',
              partial: true,
              objectResults: [
                {
                  objectApiName: 'Contact',
                  recordCount: 1_000,
                  orgCount: 3_002,
                  truncated: true,
                  stoppedAt: 'cap',
                },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
      render(<DataOpsPage />);
      await openAnonymizeTab();

      fireEvent.click(screen.getByTestId('create-backup-btn'));
      expect(mockBackupMutate).toHaveBeenLastCalledWith({ orgId: 'org-1', objects: ['Contact'] });

      fireEvent.click(screen.getByTestId('backup-slices-toggle'));
      fireEvent.click(screen.getByTestId('create-backup-btn'));
      expect(mockBackupMutate).toHaveBeenLastCalledWith({
        orgId: 'org-1',
        objects: ['Contact'],
        slices: true,
      });
    });

    it('offers no backup in slices while every object fits one', async () => {
      mockBackupObjectsData = { objects: ['Contact'] };
      render(<DataOpsPage />);
      await openAnonymizeTab();

      expect(screen.queryByTestId('backup-slices-toggle')).toBeNull();
    });
  });
});
