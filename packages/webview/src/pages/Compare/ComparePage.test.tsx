import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { ComparePage } from './ComparePage';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockCompareMutate = vi.fn();
const mockCompareReset = vi.fn();

/** Mutable mutation state for compare:execute. */
let mockCompareMutationState = {
  mutate: mockCompareMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockCompareReset,
};

/**
 * Per-request-type query payloads, keyed exactly as the tab asks for them.
 *
 * This used to be a blanket `{ data: null }` for every type, which is why the
 * Permissions, Snapshots and Drift tabs could ship reading a shape the
 * extension has never sent: no test ever put a real response through them.
 * Anything left unset here still resolves to `null`, so the tabs' "nothing
 * came back" branches stay covered too.
 */
const mockQueryData: Record<string, unknown> = {};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data: mockQueryData[type] ?? null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

/** What a comparison that read every component both orgs hold says it read. */
const COMPARED_EVERYTHING = {
  compared: 92,
  notCompared: { unreadable: 0, read_failed: 0, over_budget: 0 },
  budget: { components: 500, seconds: 90 },
};

/** A `CompareResult` complete enough to unlock the results tabs. */
const RESULT_WITH_TABS = {
  configId: 'cfg-1',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  mode: 'metadata',
  summary: {
    totalItems: 100,
    added: 5,
    removed: 3,
    modified: 10,
    unchanged: 82,
    notCompared: 0,
    byType: {},
  },
  content: COMPARED_EVERYTHING,
  diffs: [
    {
      componentType: 'ApexClass',
      fullName: 'TestClass',
      status: 'modified',
      sourceValue: 'v1',
      targetValue: 'v2',
      severity: 'warning',
      deployable: true,
    },
  ],
  timestamp: '2024-01-01T12:00:00Z',
  duration: 5000,
};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'compare:execute') {
      return mockCompareMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const twoOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'Dev',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgId: 'oid-1',
    orgType: 'Sandbox' as const,
    authMethod: 'oauth_web' as const,
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected' as const,
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'Prod',
    username: 'prod@test.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: 'oid-2',
    orgType: 'Production' as const,
    authMethod: 'oauth_web' as const,
    safetyTier: OrgSafetyTier.CRITICAL,
    appearance: { color: '#c23934', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected' as const,
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('ComparePage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: twoOrgs, selectedOrgId: null });
    mockCompareMutate.mockClear();
    mockCompareReset.mockClear();
    // Reset to default idle state
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
    for (const key of Object.keys(mockQueryData)) delete mockQueryData[key];
  });

  it('should show empty state with fewer than 2 orgs', () => {
    useOrgStore.setState({ orgs: [twoOrgs[0]] });
    render(<ComparePage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-compare')).toBeDefined();
    expect(screen.getByText('Spot differences between two orgs')).toBeDefined();
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an Org');
  });

  it('should prompt for a second org in the empty state when exactly one org exists', () => {
    useOrgStore.setState({ orgs: [twoOrgs[0]] });
    render(<ComparePage />);
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect a second org via SFDX import',
    );
    expect(screen.getByTestId('empty-step-1').textContent).toContain('Pick source and target orgs');
  });

  it('should render the compare page', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('compare-page')).toBeDefined();
  });

  it('should render the title', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Compare Org')).toBeDefined();
  });

  it('should render org selector', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('org-selector')).toBeDefined();
  });

  it('should render category selector', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('category-selector')).toBeDefined();
  });

  it('should render run button', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('run-compare-btn')).toBeDefined();
  });

  it('should disable run button when orgs not selected', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('run-compare-btn').hasAttribute('disabled')).toBe(true);
  });

  it('should show no results message when no result', () => {
    render(<ComparePage />);
    expect(screen.getAllByText('No comparison results yet').length).toBeGreaterThan(0);
  });

  it('does not say no comparison has run above the results of one', () => {
    // The header subtitle read "No comparison results yet" whatever the page showed.
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    render(<ComparePage />);
    expect(screen.getByTestId('compare-summary')).toBeDefined();
    expect(screen.queryByText('No comparison results yet')).toBeNull();
  });

  it('says nothing differs in the diff tab when a comparison found no difference', () => {
    mockCompareMutationState = {
      ...mockCompareMutationState,
      data: {
        ...RESULT_WITH_TABS,
        summary: { ...RESULT_WITH_TABS.summary, added: 0, removed: 0, modified: 0 },
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'TestClass',
            status: 'unchanged',
            severity: 'info',
            deployable: false,
          },
        ],
      },
    };
    render(<ComparePage />);
    expect(screen.getByTestId('no-diffs').textContent).toMatch(/^Nothing differs/);
    expect(screen.queryByText('No comparison results yet')).toBeNull();
  });

  /** Pick two orgs and a category, as the Run button requires. */
  function readyToRun(): void {
    fireEvent.change(screen.getByLabelText('Source Org'), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByLabelText('Target Org'), { target: { value: 'org-2' } });
    fireEvent.click(screen.getByTestId('cat-ApexClass'));
  }

  it('compares what a managed package installed unless the box is unticked', () => {
    render(<ComparePage />);
    const box = screen.getByLabelText('Include managed package components') as HTMLInputElement;
    expect(box.checked).toBe(true);

    readyToRun();
    fireEvent.click(screen.getByTestId('run-compare-btn'));

    expect(mockCompareMutate).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['ApexClass'], includeManaged: true }),
    );
  });

  it('asks the extension to leave managed package components out once the box is unticked', () => {
    render(<ComparePage />);
    readyToRun();
    fireEvent.click(screen.getByLabelText('Include managed package components'));
    fireEvent.click(screen.getByTestId('run-compare-btn'));

    expect(mockCompareMutate).toHaveBeenCalledWith(
      expect.objectContaining({ includeManaged: false }),
    );
  });

  it('should show summary when compare mutation returns data', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: {
        configId: 'cfg-1',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        mode: 'metadata',
        summary: {
          totalItems: 100,
          added: 5,
          removed: 3,
          modified: 10,
          unchanged: 82,
          notCompared: 0,
          byType: {},
        },
        content: COMPARED_EVERYTHING,
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'TestClass',
            status: 'modified',
            sourceValue: 'v1',
            targetValue: 'v2',
            severity: 'warning',
            deployable: true,
          },
        ],
        timestamp: '2024-01-01T12:00:00Z',
        duration: 5000,
      },
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    expect(screen.getByTestId('compare-summary')).toBeDefined();
    expect(screen.getByText(/\+5 Added/)).toBeDefined();
    expect(screen.getByText(/-3 Removed/)).toBeDefined();
  });

  it('should show tabs when result is received', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: {
        configId: 'cfg-1',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        mode: 'metadata',
        summary: {
          totalItems: 100,
          added: 5,
          removed: 3,
          modified: 10,
          unchanged: 82,
          notCompared: 0,
          byType: {},
        },
        content: COMPARED_EVERYTHING,
        diffs: [],
        timestamp: '2024-01-01T12:00:00Z',
        duration: 5000,
      },
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    expect(screen.getByText('Diff Viewer')).toBeDefined();
    expect(screen.getByText('Permission Presence')).toBeDefined();
    expect(screen.getByText('Deploy from Diff')).toBeDefined();
  });

  it('offers the changes of the comparison for deployment, and refuses its production target', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: {
        configId: 'cfg-1',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        mode: 'metadata',
        summary: {
          totalItems: 100,
          added: 5,
          removed: 3,
          modified: 10,
          unchanged: 82,
          notCompared: 0,
          byType: {},
        },
        content: COMPARED_EVERYTHING,
        diffs: [
          {
            componentType: 'ApexClass',
            fullName: 'TestClass',
            status: 'modified',
            sourceValue: 'v1',
            targetValue: 'v2',
            severity: 'warning',
            deployable: true,
          },
        ],
        timestamp: '2024-01-01T12:00:00Z',
        duration: 5000,
      },
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    fireEvent.click(screen.getByTestId('page-tab-deploy'));

    // The deployment is drawn from the comparison: its changes, between the
    // two orgs it compared, whatever the selectors say by then.
    expect(screen.getByTestId('compare-deploy')).toBeDefined();
    expect(screen.getByText('Deploy from Dev to Prod')).toBeDefined();
    expect(screen.getByTestId('deploy-pick-ApexClass:TestClass')).toBeDefined();
    // Prod is a production org: the page says so, and sends nothing.
    expect(screen.getByTestId('deploy-target-refused')).toBeDefined();
    fireEvent.click(screen.getByTestId('deploy-pick-ApexClass:TestClass'));
    expect((screen.getByTestId('deploy-validate-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('compare-deploy-soon')).toBeNull();
  });

  it('keeps what the Deploy tab holds across a visit to another tab', () => {
    // A validation runs for minutes: a tab change must not drop its answer,
    // nor what was picked for it.
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    render(<ComparePage />);

    fireEvent.click(screen.getByTestId('page-tab-deploy'));
    fireEvent.click(screen.getByTestId('deploy-pick-ApexClass:TestClass'));
    fireEvent.click(screen.getByTestId('page-tab-diff'));
    expect(screen.getByTestId('compare-deploy-tab').hidden).toBe(true);
    fireEvent.click(screen.getByTestId('page-tab-deploy'));

    expect(screen.getByTestId('compare-deploy-tab').hidden).toBe(false);
    expect(
      (screen.getByTestId('deploy-pick-ApexClass:TestClass') as HTMLInputElement).checked,
    ).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /* Results tabs, fed the envelope CompareHandler really posts          */
  /* ---------------------------------------------------------------- */

  it('should render the permission presence matrix from the compare:permissions envelope', () => {
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    // Exactly what CompareHandler.handlePermissions posts: an object under
    // `permissions` holding name buckets -- never PermissionMatrixRow[].
    mockQueryData['compare:permissions'] = {
      permissions: {
        permissionSets: {
          sourceOnly: [{ name: 'Sales_Admin', label: 'Sales Admin' }],
          targetOnly: [],
          shared: [{ name: 'Support_Agent', label: 'Support Agent' }],
        },
        profiles: {
          sourceOnly: [],
          targetOnly: [{ name: 'Read Only' }],
          shared: [{ name: 'System Administrator' }],
        },
      },
    };
    render(<ComparePage />);

    fireEvent.click(screen.getByTestId('page-tab-permissions'));

    expect(screen.getByTestId('perm-presence-matrix')).toBeDefined();
    // Source-only permission set: present on the left, absent on the right.
    expect(screen.getByTestId('perm-source-PermissionSet-Sales_Admin').textContent).toBe('\u2713');
    expect(screen.getByTestId('perm-target-PermissionSet-Sales_Admin').textContent).toBe('\u2717');
    expect(screen.getByTestId('perm-status-PermissionSet-Sales_Admin').textContent).toBe('Removed');
    // Target-only profile is the mirror case.
    expect(screen.getByTestId('perm-status-Profile-Read Only').textContent).toBe('Added');
    expect(screen.getByTestId('perm-status-Profile-System Administrator').textContent).toBe(
      'Unchanged',
    );
    // The page is still standing: the old code threw inside PermissionMatrix.
    expect(screen.getByTestId('compare-page')).toBeDefined();
  });

  it('should render the schema snapshot from the compare:snapshots envelope', () => {
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    mockQueryData['compare:snapshots'] = {
      snapshot: {
        source: {
          orgId: 'org-1',
          totalObjects: 812,
          customObjects: 44,
          standardObjects: 768,
          queryableObjects: 790,
        },
        target: {
          orgId: 'org-2',
          totalObjects: 806,
          customObjects: 41,
          standardObjects: 765,
          queryableObjects: 784,
        },
        diff: { sourceOnly: ['Legacy__c'], targetOnly: [], sharedCount: 805 },
        capturedAt: '2026-09-10T09:05:00.000Z',
      },
    };
    render(<ComparePage />);

    fireEvent.click(screen.getByTestId('page-tab-snapshots'));

    expect(screen.getByTestId('snapshot-comparison')).toBeDefined();
    expect(screen.getByTestId('snapshot-source-total').textContent).toBe('812 objects');
    expect(screen.getByTestId('snapshot-target-total').textContent).toBe('806 objects');
    // The object the target lacks is named, and named as a removal.
    expect(screen.getByTestId('snapshot-object-Legacy__c')).toBeDefined();
    expect(screen.getByTestId('snapshot-object-status-Legacy__c').textContent).toBe('Removed');
    // Sample size behind the two lists.
    expect(screen.getByTestId('snapshot-shared-count').textContent).toBe('805 objects');
    expect(screen.getByTestId('compare-page')).toBeDefined();
  });

  it('should render settings drift from the compare:drift envelope', () => {
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    mockQueryData['compare:drift'] = {
      drift: {
        items: [
          {
            setting: 'Organization.DefaultLocaleSidKey',
            sourceValue: 'fr_FR',
            targetValue: 'en_US',
            status: 'drift',
          },
          {
            setting: 'Organization.TimeZoneSidKey',
            sourceValue: 'Europe/Paris',
            targetValue: 'Europe/Paris',
            status: 'match',
          },
        ],
        totalChecked: 2,
        driftCount: 1,
        matchCount: 1,
        missingCount: 0,
        detectedAt: '2026-09-10T09:06:00.000Z',
      },
    };
    render(<ComparePage />);

    fireEvent.click(screen.getByTestId('page-tab-drift'));

    expect(screen.getByTestId('settings-drift')).toBeDefined();
    expect(screen.getByTestId('drift-source-Organization.DefaultLocaleSidKey').textContent).toBe(
      'fr_FR',
    );
    expect(screen.getByTestId('drift-target-Organization.DefaultLocaleSidKey').textContent).toBe(
      'en_US',
    );
    expect(screen.getByTestId('drift-status-Organization.DefaultLocaleSidKey').textContent).toBe(
      'Modified',
    );
    expect(screen.getByTestId('drift-status-Organization.TimeZoneSidKey').textContent).toBe(
      'Unchanged',
    );
    // 1 of the 2 settings differs: the score is that fraction, and the counts
    // that make up the denominator sit beside it.
    expect(screen.getByText('50%')).toBeDefined();
    expect(screen.getByTestId('drift-modified').textContent).toContain('~1');
    expect(screen.getByTestId('drift-unchanged').textContent).toContain('=1');
    expect(screen.getByTestId('compare-page')).toBeDefined();
  });

  it('should report a tab whose channel answered with nothing usable', () => {
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    // The envelope arrives, but carries no comparable setting.
    mockQueryData['compare:drift'] = {
      drift: { items: [], totalChecked: 0, driftCount: 0, matchCount: 0, missingCount: 0 },
    };
    render(<ComparePage />);

    fireEvent.click(screen.getByTestId('page-tab-drift'));

    // "No drift detected" would be a claim about two orgs nothing compared.
    expect(screen.getByTestId('compare-drift-error')).toBeDefined();
    expect(screen.getByText('compare:drift returned no settings to compare')).toBeDefined();
    expect(screen.queryByTestId('settings-drift')).toBeNull();
    expect(screen.queryByText('No drift detected')).toBeNull();
  });

  it('counts the components it did not compare apart from the changes, and says why', () => {
    mockCompareMutationState = {
      ...mockCompareMutationState,
      data: {
        ...RESULT_WITH_TABS,
        summary: {
          totalItems: 30,
          added: 0,
          removed: 0,
          modified: 1,
          unchanged: 4,
          notCompared: 25,
          byType: {},
        },
        content: {
          compared: 5,
          notCompared: { unreadable: 2, read_failed: 0, over_budget: 23 },
          budget: { components: 500, seconds: 90 },
        },
      },
    };
    render(<ComparePage />);

    expect(screen.getByTestId('compare-summary-not-compared').textContent).toBe('?25 Not compared');
    expect(screen.getByTestId('compare-coverage-compared').textContent).toBe(
      'Content compared for 5 of the 30 components both orgs hold.',
    );
    expect(screen.getByTestId('compare-coverage-over-budget')).toBeDefined();
    expect(screen.getByTestId('compare-coverage-unreadable')).toBeDefined();
  });

  it('shows no not-compared count when every component both orgs hold was compared', () => {
    mockCompareMutationState = { ...mockCompareMutationState, data: RESULT_WITH_TABS };
    render(<ComparePage />);

    expect(screen.queryByTestId('compare-summary-not-compared')).toBeNull();
    expect(screen.getByTestId('compare-coverage-compared').textContent).toBe(
      'Content compared for 92 of the 92 components both orgs hold.',
    );
  });

  it('scores no risk for components it did not compare', () => {
    mockCompareMutationState = {
      ...mockCompareMutationState,
      data: {
        ...RESULT_WITH_TABS,
        summary: {
          totalItems: 1,
          added: 0,
          removed: 0,
          modified: 0,
          unchanged: 0,
          notCompared: 1,
          byType: {},
        },
        content: {
          compared: 0,
          notCompared: { unreadable: 0, read_failed: 0, over_budget: 1 },
          budget: { components: 500, seconds: 90 },
        },
        diffs: [
          {
            componentType: 'ApexTrigger',
            fullName: 'OnAccount',
            status: 'not_compared',
            notComparedReason: 'over_budget',
            severity: 'info',
            deployable: false,
          },
        ],
      },
    };
    render(<ComparePage />);

    expect(screen.getByTestId('risk-score-value').textContent).toBe('0');
    // Nothing is listed as a change, and nothing is called safe.
    expect(screen.queryByTestId('diff-group-Apex Code')).toBeNull();
    expect(screen.getByTestId('deployment-advice').textContent).not.toContain('Safe to deploy');
  });

  it('should display error from bridge mutation', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: null,
      loading: false,
      error: 'Compare failed',
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    expect(screen.getByTestId('compare-error')).toBeDefined();
    expect(screen.getByText('Compare failed')).toBeDefined();
  });
});
