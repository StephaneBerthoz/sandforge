import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type {
  CompareItem,
  CompareResult,
  DeploymentReport,
  OrgType,
  SalesforceOrg,
} from '@sandforge/shared';
import { DeployPanel } from './DeployPanel';
import { enrichDiffs } from './enrichDiffs';

/* ------------------------------------------------------------------ */
/* Bridge hooks                                                        */
/* ------------------------------------------------------------------ */

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: { report: DeploymentReport } | null;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
}

const mutation = (): MutationState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  reset: vi.fn(),
  requestId: null,
});

let validation: MutationState;
let deployment: MutationState;
const asked: Array<{ type: string; timeoutMs?: number }> = [];

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { timeoutMs?: number }) => {
    asked.push({ type, timeoutMs: options?.timeoutMs });
    return type === 'compare:deploy' ? deployment : validation;
  },
}));

let progressById: Record<string, unknown> = {};
vi.mock('../../hooks/useOperationProgress', () => ({
  useOperationProgress: () => ({ getProgress: (id: string) => progressById[id] }),
}));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const org = (id: string, alias: string, orgType: OrgType): SalesforceOrg => ({
  id,
  alias,
  username: `${alias.toLowerCase()}@example.com`,
  instanceUrl: `https://${alias.toLowerCase()}.example.com`,
  orgId: `00D${id}`,
  orgType,
  authMethod: 'oauth_web',
  safetyTier: orgType === 'Sandbox' ? OrgSafetyTier.LOW : OrgSafetyTier.CRITICAL,
  appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '66.0', edition: 'Developer Edition', features: [] },
  status: 'connected',
  lastConnected: '2026-09-01T00:00:00Z',
  tags: [],
});

const ORGS = [org('org-1', 'Uat', 'Sandbox'), org('org-2', 'Dev', 'Sandbox')];

const item = (overrides: Partial<CompareItem> & Pick<CompareItem, 'fullName'>): CompareItem => ({
  componentType: 'ApexClass',
  status: 'modified',
  severity: 'warning',
  deployable: true,
  ...overrides,
});

const DIFFS: CompareItem[] = [
  item({ fullName: 'Invoicing', status: 'modified' }),
  item({ fullName: 'Greeting', componentType: 'CustomLabel', status: 'removed' }),
  item({ fullName: 'Legacy', status: 'added' }),
  item({ fullName: 'ns__Engine', status: 'not_compared', notComparedReason: 'unreadable' }),
  item({ fullName: 'Admin', componentType: 'Profile', status: 'modified' }),
  item({ fullName: 'Same', status: 'unchanged' }),
];

const result = (diffs: CompareItem[] = DIFFS): CompareResult => ({
  configId: 'cfg-1',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  mode: 'metadata',
  summary: {
    totalItems: diffs.length,
    added: 1,
    removed: 1,
    modified: 2,
    unchanged: 1,
    notCompared: 1,
    byType: {},
  },
  content: {
    compared: 3,
    notCompared: { unreadable: 1, read_failed: 0, over_budget: 0 },
    budget: { components: 500, seconds: 90 },
  },
  diffs,
  timestamp: '2026-09-01T10:00:00Z',
  duration: 1000,
});

const validated = (overrides: Partial<DeploymentReport> = {}): DeploymentReport => ({
  deployId: '0Af000000000001',
  checkOnly: true,
  status: 'Succeeded',
  success: true,
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  testLevel: 'RunLocalTests',
  runTests: [],
  components: [{ componentType: 'ApexClass', fullName: 'Invoicing', outcome: 'changed' }],
  counts: {
    componentsTotal: 1,
    componentsDeployed: 1,
    componentErrors: 0,
    testsTotal: 3,
    testsCompleted: 3,
    testErrors: 0,
  },
  testFailures: [],
  coverageWarnings: [],
  ...overrides,
});

function renderPanel(orgs: SalesforceOrg[] = ORGS, diffs: CompareItem[] = DIFFS) {
  const compared = result(diffs);
  return render(<DeployPanel result={compared} report={enrichDiffs(compared.diffs)} orgs={orgs} />);
}

const pick = (key: string) => fireEvent.click(screen.getByTestId(`deploy-pick-${key}`));
const validateButton = () => screen.getByTestId('deploy-validate-btn') as HTMLButtonElement;

beforeEach(() => {
  validation = mutation();
  deployment = mutation();
  asked.length = 0;
  progressById = {};
});

describe('DeployPanel', () => {
  it('offers what the source can carry, marked new or different, with its risk', () => {
    renderPanel();

    const list = screen.getByTestId('deploy-candidate-list');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByTestId('deploy-pick-ApexClass:Invoicing')).toBeDefined();
    expect(screen.getByTestId('deploy-pick-CustomLabel:Greeting')).toBeDefined();
    expect(list.textContent).toContain('Differs');
    expect(list.textContent).toContain('New');
    expect(list.textContent).toMatch(/(Low|Medium|High|Critical) risk/);
    // Nothing is picked until the user picks it.
    expect(screen.getByTestId('deploy-candidates').textContent).toContain('0 of 2 picked');
  });

  it('says of each other change why it cannot be deployed from this comparison', () => {
    renderPanel();

    expect(screen.getByTestId('deploy-not-deployable').textContent).toContain(
      '3 components cannot be deployed from this comparison',
    );
    expect(screen.getByTestId('deploy-reason-only_in_target').textContent).toContain('Legacy');
    expect(screen.getByTestId('deploy-reason-only_in_target').textContent).toContain(
      'destructive change',
    );
    expect(screen.getByTestId('deploy-reason-unreadable').textContent).toContain('ns__Engine');
    expect(screen.getByTestId('deploy-reason-permissions_in_part').textContent).toContain('Admin');
    expect(screen.getByTestId('deploy-not-deployable').textContent).not.toContain('Same');
  });

  it('validates the components picked, with the tests the risk card advises for Apex', () => {
    renderPanel();
    expect(validateButton().disabled).toBe(true);

    pick('ApexClass:Invoicing');
    expect(screen.getByTestId('deploy-tests-advised')).toBeDefined();
    expect(
      (screen.getByTestId('deploy-test-level-RunLocalTests') as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(validateButton());

    expect(validation.mutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      components: [{ componentType: 'ApexClass', fullName: 'Invoicing' }],
      testLevel: 'RunLocalTests',
    });
    expect(deployment.reset).toHaveBeenCalled();
  });

  it('runs no tests for components that hold no Apex, unless told to', () => {
    renderPanel();

    pick('CustomLabel:Greeting');
    fireEvent.click(validateButton());

    expect(validation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ testLevel: 'NoTestRun' }),
    );
    expect(screen.queryByTestId('deploy-tests-advised')).toBeNull();
  });

  it('names the test classes typed, and will not validate without a valid one', () => {
    renderPanel();
    pick('ApexClass:Invoicing');
    fireEvent.click(screen.getByTestId('deploy-test-level-RunSpecifiedTests'));

    expect(validateButton().disabled).toBe(true);
    expect(screen.getByText('Name at least one test class.')).toBeDefined();

    fireEvent.change(screen.getByTestId('deploy-test-names'), {
      target: { value: 'InvoicingTest, bad-name' },
    });
    expect(validateButton().disabled).toBe(true);
    expect(screen.getByText('Not a class name: bad-name')).toBeDefined();

    fireEvent.change(screen.getByTestId('deploy-test-names'), {
      target: { value: 'InvoicingTest BillingTest' },
    });
    fireEvent.click(validateButton());

    expect(validation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        testLevel: 'RunSpecifiedTests',
        runTests: ['InvoicingTest', 'BillingTest'],
      }),
    );
  });

  it('picks every deployable component at once, and none', () => {
    renderPanel();

    fireEvent.click(screen.getByTestId('deploy-pick-all'));
    expect(screen.getByTestId('deploy-candidates').textContent).toContain('2 of 2 picked');

    fireEvent.click(screen.getByTestId('deploy-pick-none'));
    expect(screen.getByTestId('deploy-candidates').textContent).toContain('0 of 2 picked');
  });

  it.each([
    ['a production org', org('org-2', 'Dev', 'Production')],
    ['an org it cannot tell is a sandbox', { ...org('org-2', 'Dev', 'Sandbox'), orgType: '' }],
  ])('refuses %s as the target before anything is sent', (_what, target) => {
    renderPanel([ORGS[0], target as SalesforceOrg]);

    expect(screen.getByTestId('deploy-target-refused').textContent).toContain(
      'SandForge deploys to sandboxes only',
    );
    pick('ApexClass:Invoicing');
    expect(validateButton().disabled).toBe(true);
    fireEvent.click(validateButton());
    expect(validation.mutate).not.toHaveBeenCalled();
  });

  it('deploys a successful validation once its target is typed, naming the validation only', () => {
    validation.data = { report: validated() };
    const { rerender } = renderPanel();
    pick('ApexClass:Invoicing');
    fireEvent.click(validateButton());
    // The answer arrives for what was sent.
    const compared = result();
    rerender(<DeployPanel result={compared} report={enrichDiffs(compared.diffs)} orgs={ORGS} />);

    fireEvent.click(screen.getByTestId('deploy-deploy-btn'));
    expect(screen.getByTestId('danger-title').textContent).toBe('Deploy to Dev');
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(deployment.mutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(deployment.mutate).toHaveBeenCalledWith({
      validationId: '0Af000000000001',
      targetOrgId: 'org-2',
    });
  });

  it('offers no deployment once what is picked has changed since the validation', () => {
    validation.data = { report: validated() };
    renderPanel();
    pick('ApexClass:Invoicing');
    fireEvent.click(validateButton());
    expect(screen.getByTestId('deploy-deploy-btn')).toBeDefined();

    pick('CustomLabel:Greeting');

    expect(screen.queryByTestId('deploy-deploy-btn')).toBeNull();
    expect(screen.getByTestId('deploy-validation-stale')).toBeDefined();
  });

  it('offers no deployment of a validation that failed', () => {
    validation.data = { report: validated({ success: false, status: 'Failed' }) };
    renderPanel();
    pick('ApexClass:Invoicing');
    fireEvent.click(validateButton());

    expect(screen.queryByTestId('deploy-deploy-btn')).toBeNull();
    expect(screen.getByTestId('deploy-validation-report-verdict').textContent).toContain(
      'The validation failed in Dev',
    );
  });

  it('says where the run stands, from the progress of its own request', () => {
    validation.loading = true;
    validation.requestId = 'req-7';
    progressById = {
      'req-7': {
        operationId: 'req-7',
        percentage: 25,
        processedRecords: 3,
        totalRecords: 12,
        currentStep: 'tests',
      },
    };
    renderPanel();

    expect(screen.getByTestId('deploy-progress').textContent).toBe(
      'Running the Apex tests: 3 of 12',
    );
  });

  it('waits on the orgs, not on the page, for as long as the extension follows them', () => {
    renderPanel();

    const validateTimeout = asked.find((a) => a.type === 'compare:validate-deployment')?.timeoutMs;
    const deployTimeout = asked.find((a) => a.type === 'compare:deploy')?.timeoutMs;
    // Two retrievals of five minutes and a deployment of thirty, and a minute's margin.
    expect(validateTimeout).toBe(41 * 60_000);
    expect(deployTimeout).toBe(31 * 60_000);
  });

  it('shows what went wrong with a validation, and the deployment report once deployed', () => {
    validation.error = 'Operation blocked by Production Guard: deploy is not allowed';
    deployment.data = {
      report: validated({ checkOnly: false, deployId: '0Af000000000002' }),
    };
    renderPanel();

    expect(screen.getByTestId('deploy-validation-error').textContent).toContain(
      'Operation blocked by Production Guard',
    );
    expect(screen.getByTestId('deploy-deployment-report-verdict').textContent).toBe(
      'Deployed to Dev.',
    );
  });

  it('says so when nothing the comparison found can be deployed', () => {
    renderPanel(ORGS, [item({ fullName: 'Legacy', status: 'added' })]);

    expect(screen.getByTestId('deploy-none-deployable')).toBeDefined();
    expect(validateButton().disabled).toBe(true);
  });
});
