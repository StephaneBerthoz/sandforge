import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type {
  RunCheckpointTaken,
  SeedExecutionResult,
  SeedObjectResult,
  SeedTemplate,
} from '@sandforge/shared';
import i18n from '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { developerOrg, productionOrg } from '../Checkpoint/testing/checkpointFixtures';
import { SeedResultsStep } from './SeedResultsStep';

const saveTemplateMutate = vi.hoisted(() => vi.fn());
const openRecordMutate = vi.hoisted(() => vi.fn());
const fileSaveMutate = vi.hoisted(() => vi.fn());
const saveTemplateState = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  loading: false,
  /** Whether a file save is waiting on the host's dialog. */
  saving: false,
  /** Use the real request hook, answered through window messages. */
  real: false,
}));

vi.mock('../../hooks/useBridgeMutation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useBridgeMutation')>();
  return {
    useBridgeMutation: (...args: Parameters<typeof actual.useBridgeMutation>) => {
      if (saveTemplateState.real) return actual.useBridgeMutation(...args);
      if (args[0] === 'seed:open-record') {
        return {
          mutate: openRecordMutate,
          data: null,
          loading: false,
          error: null,
          reset: vi.fn(),
          requestId: null,
        };
      }
      // The export goes through `file:save`, the template through its own route.
      if (args[0] === 'file:save') {
        return {
          mutate: fileSaveMutate,
          data: null,
          loading: saveTemplateState.saving,
          error: null,
          reset: vi.fn(),
          requestId: null,
        };
      }
      return {
        mutate: saveTemplateMutate,
        data: saveTemplateState.data,
        loading: saveTemplateState.loading,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    },
  };
});

const mockVSCodeApi = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => mockVSCodeApi,
  useVSCodeApi: () => mockVSCodeApi,
}));

function seedTemplate(): SeedTemplate {
  return {
    id: 'tpl-run',
    name: 'seed-from-ui',
    description: 'Seed from SandForge UI',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Contact',
        recordCount: 10,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [],
      },
    ],
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function objectResult(overrides: Partial<SeedObjectResult> = {}): SeedObjectResult {
  return {
    objectApiName: 'Contact',
    recordsCreated: 10,
    recordsFailed: 0,
    createdIds: [],
    errors: [],
    ...overrides,
  };
}

function executionResult(objectResults: SeedObjectResult[]): SeedExecutionResult {
  return {
    templateId: 'tpl-1',
    operationId: 'op-1',
    status: 'success',
    objectResults,
    totalRecordsCreated: 10,
    totalRecordsFailed: 0,
    duration: 1200,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101500-a1b2',
  name: 'Before Seed run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:00.000Z',
  expiresAt: '2026-11-08T10:15:00.000Z',
  objects: ['Account'],
  records: 38,
  bytes: 2_200_000,
  requests: 68,
  added: [],
  notHeld: [],
};

describe('SeedResultsStep', () => {
  beforeEach(() => {
    saveTemplateMutate.mockClear();
    openRecordMutate.mockClear();
    fileSaveMutate.mockClear();
    saveTemplateState.data = null;
    saveTemplateState.loading = false;
    saveTemplateState.saving = false;
    saveTemplateState.real = false;
    mockVSCodeApi.postMessage.mockClear();
  });

  describe('before it has a result', () => {
    const shown = (props: { isRunning?: boolean; stopped?: boolean }) =>
      render(
        <SeedResultsStep
          orgName="dev1"
          executionResult={undefined}
          onSeedAgain={vi.fn()}
          template={null}
          {...props}
        />,
      );

    it('says what Confirm does, where it said no data was available', () => {
      shown({});
      expect(screen.getByTestId('seed-results-waiting').textContent).toBe(
        'Nothing has been written yet: Confirm starts the seed.',
      );
      expect(screen.queryByText('No data available')).toBeNull();
    });

    it('says the run goes while it goes', () => {
      shown({ isRunning: true });
      expect(screen.getByTestId('seed-results-waiting').textContent).toBe(i18n.t('seed.running'));
    });

    it('says nothing beside the refusal of a run stopped: nothing is missing', () => {
      shown({ stopped: true });
      expect(screen.queryByTestId('seed-results-waiting')).toBeNull();
      expect(screen.queryByText('No data available')).toBeNull();
    });
  });

  it('names under the removal the checkpoint the run took, with the way to rewind to it', () => {
    useOrgStore.setState({ orgs: [developerOrg()] });
    render(
      <SeedResultsStep
        orgName="DEV-SB"
        orgId="org-dev"
        executionResult={{ ...executionResult([objectResult()]), checkpoint: TAKEN }}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByTestId('seed-result-checkpoint-taken').textContent).toContain(TAKEN.name);
    fireEvent.click(screen.getByTestId('seed-result-checkpoint-action'));
    expect(useAppStore.getState().navigationIntent).toMatchObject({
      previewCheckpointId: TAKEN.checkpointId,
      targetOrgId: 'org-dev',
    });
  });

  it('says a run that wrote nothing deleted its checkpoint', () => {
    useOrgStore.setState({ orgs: [developerOrg()] });
    render(
      <SeedResultsStep
        orgName="DEV-SB"
        orgId="org-dev"
        executionResult={{
          ...executionResult([]),
          checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
        }}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByTestId('seed-result-checkpoint-deleted').textContent).toBe(
      'The checkpoint taken before the run was deleted: the run wrote nothing.',
    );
  });

  it('offers the removal of what the run created, asking for it by the run’s id', () => {
    // The command line could take a seed back from its summary; the panel
    // offered nothing, and the records stayed in the org.
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const asked = mockVSCodeApi.postMessage.mock.calls
      .map(([envelope]) => (envelope as { payload: { type: string; payload?: unknown } }).payload)
      .filter((message) => message.type === 'seed:removal:info');
    expect(asked.map((message) => message.payload)).toEqual([{ runId: 'op-1' }]);
  });

  it('says what the run muted of the org’s automation, and nothing of a run not asked to', () => {
    const { rerender } = render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );
    expect(screen.queryByTestId('seed-result-muted')).toBeNull();

    rerender(
      <SeedResultsStep
        orgName="dev1"
        executionResult={{
          ...executionResult([objectResult()]),
          mutedAutomation: {
            state: 'muted',
            assigned: ['Trap_Bypass'],
            held: [],
            permissions: ['Trap_Bypass_Flow'],
            silenced: [
              {
                objectApiName: 'Contact',
                kind: 'workflowRule',
                name: 'Contact_Welcome',
                permission: 'Trap_Bypass_Flow',
              },
            ],
            stillRan: [],
            released: true,
          },
        }}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );
    expect(screen.getByTestId('seed-result-muted-said').textContent).toBe(
      'Trap_Bypass was assigned to the user the run wrote as in dev1, for the run alone.',
    );
    expect(screen.getByTestId('seed-result-muted-silenced-Contact').textContent).toBe(
      'Contact: Workflow rule: Contact_Welcome · bypass Trap_Bypass_Flow',
    );
  });

  it('opens first a created account in the org the run wrote to, Seed Again after it', () => {
    // The results said how many records were written and led nowhere near them.
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({ createdIds: ['003000000000001AAA'] }),
          objectResult({ objectApiName: 'Account', createdIds: ['001000000000001AAA'] }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'));
    expect(buttons.indexOf('btn-seed-open-record')).toBeLessThan(buttons.indexOf('btn-seed-again'));
    const open = screen.getByTestId('btn-seed-open-record');
    expect(open.textContent).toBe('Open a created Account in dev1');
    fireEvent.click(open);

    expect(openRecordMutate).toHaveBeenCalledWith({
      runId: 'op-1',
      recordId: '001000000000001AAA',
    });
  });

  it('opens a record of the first object that created one when the run created no account', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({ createdIds: [] }),
          objectResult({ objectApiName: 'Lead', createdIds: ['00Q000000000001AAA'] }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByTestId('btn-seed-open-record').textContent).toBe(
      'Open a created Lead in dev1',
    );
  });

  it('offers no record to open when the run listed none', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.queryByTestId('btn-seed-open-record')).toBeNull();
  });

  it('groups the refusals by reason, opens the three largest, and says what to do about the ones it knows', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({
            recordsCreated: 0,
            recordsFailed: 1_200,
            errors: [
              ...Array.from({ length: 4 }, () => 'STANDARD_PRICE_NOT_DEFINED: No standard price'),
              'A_CODE: a',
              'A_CODE: a',
              'A_CODE: a',
              'B_CODE: b',
              'B_CODE: b',
              'C_CODE: c',
            ],
          }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const open = [0, 1, 2, 3].map(
      (i) =>
        (screen.getByTestId(`seed-result-error-group-Contact-${i}`) as HTMLDetailsElement).open,
    );
    expect(open).toEqual([true, true, true, false]);
    const first = screen.getByTestId('seed-result-error-group-Contact-0');
    expect(first.textContent).toContain('4 × STANDARD_PRICE_NOT_DEFINED');
    expect(first.textContent).toContain('standard price book');
    // Ten refusals listed of the 1,200 the run counted.
    expect(screen.getByTestId('seed-result-errors-listed-Contact').textContent).toBe(
      'Grouped from the first 10 of the 1200 records refused.',
    );
  });

  describe('Take a checkpoint now', () => {
    beforeEach(() => {
      useOrgStore.setState({ orgs: [developerOrg(), productionOrg()], selectedOrgId: 'org-dev' });
      useAppStore.setState({ currentRoute: 'seed', navigationIntent: null });
    });

    it('offers, under the run’s next steps, a checkpoint of the org it filled, opening its take', () => {
      render(
        <SeedResultsStep
          orgName="DEV-SB"
          orgId="org-dev"
          executionResult={executionResult([objectResult()])}
          onSeedAgain={vi.fn()}
          template={seedTemplate()}
        />,
      );
      const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'));
      expect(buttons.indexOf('btn-seed-again')).toBeLessThan(
        buttons.indexOf('seed-checkpoint-now-action'),
      );
      expect(screen.getByTestId('seed-checkpoint-now').textContent).toContain(
        'keep DEV-SB as it is now',
      );
      fireEvent.click(screen.getByTestId('seed-checkpoint-now-action'));
      expect(useAppStore.getState().navigationIntent).toEqual({
        route: 'checkpoint',
        takeCheckpoint: true,
        targetOrgId: 'org-dev',
      });
    });

    it('offers none after a run that created nothing', () => {
      render(
        <SeedResultsStep
          orgName="DEV-SB"
          orgId="org-dev"
          executionResult={{
            ...executionResult([objectResult({ recordsCreated: 0, recordsFailed: 10 })]),
            totalRecordsCreated: 0,
          }}
          onSeedAgain={vi.fn()}
          template={seedTemplate()}
        />,
      );
      expect(screen.queryByTestId('seed-checkpoint-now')).toBeNull();
    });

    it('offers none for a production org, which a checkpoint refuses', () => {
      render(
        <SeedResultsStep
          orgName="PROD"
          orgId="org-prod"
          executionResult={executionResult([objectResult()])}
          onSeedAgain={vi.fn()}
          template={seedTemplate()}
        />,
      );
      expect(screen.queryByTestId('seed-checkpoint-now')).toBeNull();
    });
  });

  it('offers no removal for a run that created nothing', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={{
          ...executionResult([objectResult({ recordsCreated: 0, recordsFailed: 10 })]),
          totalRecordsCreated: 0,
        }}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(mockVSCodeApi.postMessage).not.toHaveBeenCalled();
  });

  it('exports, per object, the records asked for, created and failed, and the ids created', () => {
    // The button had no handler: every results step offered an export that
    // saved nothing.
    const template = seedTemplate();
    template.objects.push({ ...template.objects[0], objectApiName: 'Account', recordCount: 5 });
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({
            recordsCreated: 8,
            recordsFailed: 2,
            createdIds: ['003000000000001AAA', '003000000000002AAA'],
            truncated: true,
          }),
          objectResult({
            objectApiName: 'Account',
            recordsCreated: 5,
            createdIds: [1, 2, 3, 4, 5].map((n) => `00100000000000${n}AAA`),
          }),
        ])}
        onSeedAgain={vi.fn()}
        template={template}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-export-csv'));

    expect(fileSaveMutate).toHaveBeenCalledTimes(1);
    const sent = fileSaveMutate.mock.calls[0][0] as {
      suggestedName: string;
      content: string;
      extensions: string[];
    };
    expect(sent.suggestedName).toMatch(/^sandforge-seed-results-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(sent.extensions).toEqual(['csv']);
    expect(sent.content.split('\n')).toEqual([
      '"Object","Requested","Created","Failed","Created IDs","Created IDs not listed","Linked to a record the platform wrote"',
      // Only the first ids of a long list reach the step; the rest are counted.
      '"Contact","10","8","2","003000000000001AAA 003000000000002AAA","6","0"',
      '"Account","5","5","0","001000000000001AAA 001000000000002AAA 001000000000003AAA 001000000000004AAA 001000000000005AAA","0","0"',
    ]);
    expect(saveTemplateMutate).not.toHaveBeenCalled();
  });

  it('exports the contact roles linked to the ones the platform wrote in a last column, apart from those created', () => {
    // The file had no column for them: a role object whose roles were all
    // linked read as one that wrote nothing, 0 created and 0 failed. The
    // column goes last, so the columns before it stay where a reader finds them.
    const template = seedTemplate();
    template.objects = [
      { ...template.objects[0], objectApiName: 'Opportunity', recordCount: 3 },
      { ...template.objects[0], objectApiName: 'OpportunityContactRole', recordCount: 3 },
    ];
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({
            objectApiName: 'Opportunity',
            recordsCreated: 3,
            createdIds: [1, 2, 3].map((n) => `00600000000000${n}AAA`),
          }),
          objectResult({
            objectApiName: 'OpportunityContactRole',
            recordsCreated: 0,
            writtenByThePlatform: { records: 3, given: 3 },
          }),
        ])}
        onSeedAgain={vi.fn()}
        template={template}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-export-csv'));

    const { content } = fileSaveMutate.mock.calls[0][0] as { content: string };
    const [header, opportunities, roles] = content
      .split('\n')
      .map((line) => line.slice(1, -1).split('","'));
    expect(header.slice(0, 6)).toEqual([
      'Object',
      'Requested',
      'Created',
      'Failed',
      'Created IDs',
      'Created IDs not listed',
    ]);
    expect(header[6]).toBe('Linked to a record the platform wrote');
    expect(opportunities[6]).toBe('0');
    expect(roles).toEqual(['OpportunityContactRole', '3', '0', '0', '', '0', '3']);
  });

  it('says on the card of a role object whose roles were all linked that they were linked, not 0/0', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({ objectApiName: 'Opportunity', recordsCreated: 2 }),
          objectResult({
            objectApiName: 'OpportunityContactRole',
            recordsCreated: 0,
            writtenByThePlatform: { records: 2, given: 2 },
          }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.getByText('2 linked')).toBeTruthy();
    expect(screen.queryByText('0/0')).toBeNull();
  });

  it('leaves the requested count empty when the step has no template', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult({ createdIds: [] })])}
        onSeedAgain={vi.fn()}
        template={null}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-export-csv'));

    const { content } = fileSaveMutate.mock.calls[0][0] as { content: string };
    expect(content.split('\n')[1]).toBe('"Contact","","10","0","","10","0"');
  });

  it('cannot export twice while the host’s save dialog is open', () => {
    saveTemplateState.saving = true;
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect((screen.getByTestId('btn-export-csv') as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls a seed a cancel stopped cancelled, not partially complete, with what it created', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={{
          ...executionResult([objectResult()]),
          status: 'partial',
          cancelled: true,
        }}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const summary = screen.getByTestId('result-summary');
    expect(summary.textContent).toContain('Cancelled');
    expect(summary.textContent).not.toContain('Partially Complete');
    expect(summary.textContent).toContain('10');
  });

  it('names the fields that received generated sentences instead of AI values', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({ aiFallback: { fields: ['Description', 'Title'], reason: 'no-answer' } }),
          objectResult({ objectApiName: 'Account' }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const rows = screen.getAllByTestId('seed-result-ai-fallback');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Description, Title');
  });

  it('says a short AI answer apart from no answer', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({ aiFallback: { fields: ['Title'], reason: 'short-answer' } }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const row = screen.getByTestId('seed-result-ai-fallback');
    expect(row.textContent).toContain('Title');
    expect(row.textContent).toContain('left values out');
    expect(row.textContent).not.toContain('refused');
  });

  it('says the contact roles linked to the ones the platform wrote with their opportunity, and the target’s words for those it kept as it wrote them', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({
            objectApiName: 'OpportunityContactRole',
            recordsCreated: 1,
            writtenByThePlatform: {
              records: 2,
              given: 1,
              refusal: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: A role is set by the account team.',
            },
          }),
          objectResult({ objectApiName: 'Opportunity' }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const rows = screen.getAllByTestId('seed-result-written-by-the-platform');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe(
      '2 contact roles linked to the ones the platform wrote with their opportunity, for the ' +
        'contact each went in with, not written; given the fields generated for them: 1. ' +
        "The others stay as the platform wrote them. The target's words: " +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: A role is set by the account team.',
    );
  });

  it('says one role linked without the target’s words when it took the fields', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([
          objectResult({
            objectApiName: 'OpportunityContactRole',
            recordsCreated: 0,
            writtenByThePlatform: { records: 1, given: 1 },
          }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByTestId('seed-result-written-by-the-platform').textContent).toBe(
      '1 contact role linked to the one the platform wrote with its opportunity, for the ' +
        'contact it went in with, not written; given the fields generated for it: 1.',
    );
  });

  it('shows no fallback row when every AI field got an AI value', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.queryByTestId('seed-result-ai-fallback')).toBeNull();
  });

  it('saves the run as a template named after the objects it seeded', () => {
    // The button was inert: the route that stores a template had no sender, so
    // a configuration worth keeping had to be rebuilt by hand every time.
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-save-template'));

    expect(saveTemplateMutate).toHaveBeenCalledTimes(1);
    const saved = (saveTemplateMutate.mock.calls[0][0] as { template: Record<string, unknown> })
      .template;
    expect(saved.name).toContain('Contact');
    expect(saved.id).toBeUndefined();
    expect((saved.objects as Array<{ recordCount: number }>)[0].recordCount).toBe(10);
  });

  it('cannot save a template before a run has produced one', () => {
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={null}
      />,
    );

    expect((screen.getByTestId('btn-save-template') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the template was saved once the host confirms it', () => {
    saveTemplateState.data = { success: true, id: 'tpl-7' };
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByTestId('seed-template-saved').textContent).toContain('saved');
  });

  it('shows why the host refused to save the template', () => {
    // A refused save left the button looking as inert as before it was wired.
    saveTemplateState.real = true;
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-save-template'));
    // The removal card beside it asks what the run kept as it mounts.
    const sent = mockVSCodeApi.postMessage.mock.calls
      .map(([envelope]) => envelope as { payload: { id: string; type: string } })
      .find((envelope) => envelope.payload.type === 'seed:template:save');
    if (!sent) throw new Error('no seed:template:save was sent');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'ext-err',
            type: 'seed:error',
            timestamp: Date.now(),
            correlationId: sent.payload.id,
            payload: { message: 'Template storage is full' },
          },
        }),
      );
    });

    expect(screen.getByTestId('seed-template-save-error').textContent).toContain(
      'Template storage is full',
    );
  });

  it('cannot save the same run twice while the first save is in flight', () => {
    saveTemplateState.loading = true;
    render(
      <SeedResultsStep
        orgName="dev1"
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect((screen.getByTestId('btn-save-template') as HTMLButtonElement).disabled).toBe(true);
  });
});
