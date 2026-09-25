import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';
import { OrgSafetyTier } from '@sandforge/shared';
import type { CloneExecutionResult, ClonePreviewResult, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../../stores/useOrgStore';
import { CloneWizard } from './CloneWizard';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const mockDescribeMutate = vi.fn();
const mockDescribeReset = vi.fn();
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();

/** What `seed:clone:describe-source` answers with, once a source is picked. */
let describedObjects: { objects: Array<{ apiName: string; label: string }> } | null = null;
/** What `seed:clone:preview` answers with, or how it fails: set by a test, dropped by a reset. */
let previewAnswer: ClonePreviewResult | null = null;
let previewFailure: string | null = null;
/** What `seed:clone:execute` answers with: set by a test, dropped by a reset. */
let executeAnswer: CloneExecutionResult | null = null;

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:clone:describe-source') {
      return {
        mutate: mockDescribeMutate,
        data: describedObjects,
        loading: false,
        error: null,
        reset: mockDescribeReset,
      };
    }
    if (type === 'seed:clone:preview') {
      return {
        mutate: mockPreviewMutate,
        data: previewAnswer,
        loading: false,
        error: previewFailure,
        reset: () => {
          mockPreviewReset();
          previewAnswer = null;
          previewFailure = null;
        },
        requestId: 'wv-preview',
      };
    }
    if (type === 'seed:clone:execute') {
      return {
        mutate: mockExecuteMutate,
        data: executeAnswer,
        loading: false,
        error: null,
        reset: () => {
          mockExecuteReset();
          executeAnswer = null;
        },
        requestId: 'wv-clone-run',
      };
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

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
  {
    id: 'org-2',
    alias: 'dev2',
    username: 'user@dev2.com',
    instanceUrl: 'https://dev2.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('CloneWizard', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    describedObjects = null;
    previewAnswer = null;
    previewFailure = null;
    executeAnswer = null;
    mockDescribeMutate.mockClear();
    mockDescribeReset.mockClear();
    mockPreviewMutate.mockClear();
    mockPreviewReset.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();
  });

  it('should render the clone wizard container', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-wizard-container')).toBeDefined();
    expect(screen.getByTestId('clone-wizard')).toBeDefined();
  });

  it('should render 4-step wizard with step indicators', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-step-indicator')).toBeDefined();
    expect(screen.getByTestId('clone-step-indicator').children.length).toBe(4);
  });

  it('should start on step 1 -- source org picker', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-source-picker')).toBeDefined();
  });

  it('should show source org select excluding target org', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    const select = screen.getByTestId('clone-source-select') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    const optionValues = options.map((o) => o.value).filter((v) => v !== '');

    // org-1 is the selected/target org, should be excluded
    expect(optionValues).not.toContain('org-1');
    expect(optionValues).toContain('org-2');
  });

  it('should disable next button when no source org is selected', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    const nextBtn = screen.getByTestId('clone-wizard-next');
    expect(nextBtn).toHaveProperty('disabled', true);
  });

  it('should render wizard with correct test ID prefix', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-wizard-back')).toBeDefined();
    expect(screen.getByTestId('clone-wizard-next')).toBeDefined();
  });

  describe('the preview, which goes from one org to the other', () => {
    /** Pick org-2 as the source, and Account on the objects step. */
    function pickSourceAndAccount(): void {
      describedObjects = { objects: [{ apiName: 'Account', label: 'Account' }] };
      fireEvent.change(screen.getByTestId('clone-source-select'), { target: { value: 'org-2' } });
      fireEvent.click(screen.getByTestId('clone-wizard-next'));
      fireEvent.click(screen.getByTestId('clone-obj-check-Account'));
    }

    it('is not sent without a target org, and the objects step says why', () => {
      // With no org selected the preview went out with an empty target, and
      // the wizard showed the bridge's refusal as it was written:
      // "Invalid payload — targetOrgId: …".
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
      render(<CloneWizard onBack={vi.fn()} />);
      pickSourceAndAccount();

      const next = screen.getByTestId('clone-wizard-next');
      expect(next).toHaveProperty('disabled', true);
      fireEvent.click(next);
      expect(mockPreviewMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId('clone-needs-both-orgs').textContent).toBe(
        en.seed.clone.wizard.needsBothOrgs,
      );
    });

    it('is sent once both orgs are there, with nothing said of a missing one', () => {
      render(<CloneWizard onBack={vi.fn()} />);
      pickSourceAndAccount();

      expect(screen.queryByTestId('clone-needs-both-orgs')).toBeNull();
      fireEvent.click(screen.getByTestId('clone-wizard-next'));
      expect(mockPreviewMutate).toHaveBeenCalledWith({
        sourceOrgId: 'org-2',
        targetOrgId: 'org-1',
        objects: [{ objectApiName: 'Account' }],
      });
    });

    it('dismisses only the banner of a failed preview: the objects stay picked', () => {
      // Dismissing the banner reset the wizard to its first step, the source
      // and the objects picked gone with it.
      const view = render(<CloneWizard onBack={vi.fn()} />);
      pickSourceAndAccount();
      fireEvent.click(screen.getByTestId('clone-wizard-next'));
      previewFailure =
        'Invoice__c could not be described in the target org: NOT_FOUND: The requested resource does not exist';
      view.rerender(<CloneWizard onBack={vi.fn()} />);
      const banner = screen.getByTestId('clone-error');

      fireEvent.click(within(banner).getByRole('button', { name: en.common.dismiss }));

      expect(screen.queryByTestId('clone-error')).toBeNull();
      expect(screen.getByTestId('clone-obj-check-Account')).toHaveProperty('checked', true);
      expect(screen.getByTestId('clone-wizard-next')).toHaveProperty('disabled', false);
    });
  });

  describe('the run, which goes by its preview', () => {
    /** Accounts of org-2, previewed for org-1. */
    const PREVIEW: ClonePreviewResult = {
      objects: [{ objectApiName: 'Account', recordCount: 3, sampleRecords: [], relationships: [] }],
      insertOrder: ['Account'],
    };

    /** What the clone of those accounts answers. */
    const RESULT: CloneExecutionResult = {
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          sourceCount: 3,
          insertedCount: 3,
          failedCount: 0,
          idMappings: [],
          errors: [],
        },
      ],
      totalSourceRecords: 3,
      totalInserted: 3,
      totalFailed: 0,
      durationMs: 1200,
    };

    /** Pick org-2 and its accounts, ask for the preview, and show its answer. */
    function previewShown(): ReturnType<typeof render> {
      const view = render(<CloneWizard onBack={vi.fn()} />);
      describedObjects = { objects: [{ apiName: 'Account', label: 'Account' }] };
      fireEvent.change(screen.getByTestId('clone-source-select'), { target: { value: 'org-2' } });
      fireEvent.click(screen.getByTestId('clone-wizard-next'));
      fireEvent.click(screen.getByTestId('clone-obj-check-Account'));
      fireEvent.click(screen.getByTestId('clone-wizard-next'));
      previewAnswer = PREVIEW;
      view.rerender(<CloneWizard onBack={vi.fn()} />);
      expect(screen.getByTestId('clone-preview-panel')).toBeDefined();
      return view;
    }

    /** Deliver the `operation:failed` the extension posts for the run. */
    function runFailed(): void {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: 'host-failed',
              type: 'operation:failed',
              timestamp: Date.now(),
              payload: {
                operationId: 'wv-clone-run',
                error: 'STORAGE_LIMIT_EXCEEDED: storage limit exceeded',
                retryable: false,
                code: 'CLONE_FAILED',
              },
            },
          }),
        );
      });
    }

    it('goes to the orgs its preview was made for, naming that preview', () => {
      previewShown();

      fireEvent.click(screen.getByTestId('clone-preview-execute'));

      expect(mockExecuteMutate).toHaveBeenCalledWith({
        sourceOrgId: 'org-2',
        targetOrgId: 'org-1',
        objects: [{ objectApiName: 'Account' }],
        previewId: 'wv-preview',
      });
    });

    it('is not sent to an org selected after the preview: the preview is dropped, the banner says why, and Next previews again', () => {
      // The target is the org selected in SandForge: selected after the
      // preview, another org took the run the preview was made for.
      previewShown();

      act(() => {
        useOrgStore.setState({ selectedOrgId: 'org-3' });
      });

      expect(screen.queryByTestId('clone-preview-execute')).toBeNull();
      expect(screen.getByTestId('clone-error').textContent).toContain(
        en.seed.clone.wizard.targetChanged,
      );
      expect(screen.getByTestId('clone-obj-check-Account')).toHaveProperty('checked', true);
      expect(mockExecuteMutate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('clone-wizard-next'));
      expect(mockPreviewMutate).toHaveBeenLastCalledWith({
        sourceOrgId: 'org-2',
        targetOrgId: 'org-3',
        objects: [{ objectApiName: 'Account' }],
      });
    });

    it('runs the clone on Next from its preview, and shows it running', () => {
      // Next went on to an empty execute step, and nothing was run.
      previewShown();

      fireEvent.click(screen.getByTestId('clone-wizard-next'));

      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('clone-executing')).toBeDefined();
    });

    it('stays on a run while it runs: neither Back nor the steps leave it', () => {
      previewShown();
      fireEvent.click(screen.getByTestId('clone-preview-execute'));

      expect(screen.getByTestId('clone-wizard-back')).toHaveProperty('disabled', true);
      fireEvent.click(screen.getByTestId('clone-step-preview'));
      fireEvent.click(screen.getByTestId('clone-step-objects'));

      expect(screen.getByTestId('clone-executing')).toBeDefined();
      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      expect(mockPreviewMutate).toHaveBeenCalledTimes(1);
    });

    it('shows a finished run again on Next from its preview, without running it twice', () => {
      const view = previewShown();
      fireEvent.click(screen.getByTestId('clone-preview-execute'));
      executeAnswer = RESULT;
      view.rerender(<CloneWizard onBack={vi.fn()} />);
      expect(screen.getByTestId('clone-results-panel')).toBeDefined();

      fireEvent.click(screen.getByTestId('clone-step-preview'));
      expect(screen.getByTestId('clone-preview-panel')).toBeDefined();
      fireEvent.click(screen.getByTestId('clone-wizard-next'));

      expect(screen.getByTestId('clone-results-panel')).toBeDefined();
      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
    });

    it('dismisses only the banner of a failed run: its preview stays, to run again', () => {
      previewShown();
      fireEvent.click(screen.getByTestId('clone-preview-execute'));
      runFailed();
      const banner = screen.getByTestId('clone-error');
      expect(banner.textContent).toContain(en.seed.clone.error.CLONE_FAILED);

      fireEvent.click(within(banner).getByRole('button', { name: en.common.dismiss }));

      expect(screen.queryByTestId('clone-error')).toBeNull();
      expect(screen.getByTestId('clone-preview-panel')).toBeDefined();
      fireEvent.click(screen.getByTestId('clone-preview-execute'));
      expect(mockExecuteMutate).toHaveBeenCalledTimes(2);
    });
  });
});
