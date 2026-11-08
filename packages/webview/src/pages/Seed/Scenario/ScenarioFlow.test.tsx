import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type {
  BaseMessage,
  SalesforceOrg,
  SeedExecutionResult,
  SeedScenarioPreparation,
} from '@sandforge/shared';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { ScenarioFlow } from './ScenarioFlow';
import { useOrgStore } from '../../../stores/useOrgStore';

function sent(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sent(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${Math.random()}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SCRATCH',
  username: 'dev@example.com',
  orgType: 'Scratch',
  status: 'connected',
} as unknown as SalesforceOrg;

const PREPARATION: SeedScenarioPreparation = {
  options: { seed: 1, caseStatus: { open: 'Received', closed: 'Resolved' } },
  objects: [
    { objectApiName: 'Account', recordCount: 10 },
    { objectApiName: 'Contact', recordCount: 10 },
    { objectApiName: 'Case', recordCount: 30 },
    { objectApiName: 'CaseComment', recordCount: 58 },
    { objectApiName: 'Knowledge__kav', recordCount: 6, optional: true },
  ],
  tests: 14,
  caseStatusFrom: { from: 'org' },
  knowledge: { available: false, reason: 'Salesforce Knowledge is not turned on in it' },
};

function result(
  companion: NonNullable<SeedExecutionResult['scenario']>['companion'],
): SeedExecutionResult {
  return {
    templateId: 'scenario-retail-orders',
    operationId: 'run-1',
    status: 'success',
    objectResults: [
      {
        objectApiName: 'Account',
        recordsCreated: 10,
        recordsFailed: 0,
        createdIds: [],
        errors: [],
      },
      {
        objectApiName: 'Knowledge__kav',
        recordsCreated: 0,
        recordsFailed: 0,
        createdIds: [],
        errors: ['Skipped: Knowledge__kav: Salesforce Knowledge is not turned on in it.'],
        optional: true,
      },
    ],
    totalRecordsCreated: 10,
    totalRecordsFailed: 0,
    duration: 1,
    timestamp: '2026-10-28T00:00:00.000Z',
    // As the host answers an org without Knowledge: no article, none published.
    knowledge: {
      skipped: 'Skipped: Knowledge__kav: Salesforce Knowledge is not turned on in it.',
    },
    scenario: {
      packId: 'retail-orders',
      packName: RETAIL_ORDERS_PACK.name,
      tests: 14,
      openCasesWritten: 10,
      openCases: 10,
      companion,
    },
  };
}

/** The pack prepared for an org whose Knowledge base was turned on afresh: Summary alone. */
const PREPARATION_WITH_KNOWLEDGE: SeedScenarioPreparation = {
  ...PREPARATION,
  options: { ...PREPARATION.options, articleBodyField: 'Summary', articleBodyLength: 1000 },
  knowledge: { available: true, bodyFields: ['Summary'] },
};

/** A run in that org: every article written, one the org would not publish. */
function resultWithKnowledge(): SeedExecutionResult {
  const base = result({ kind: 'kept' });
  return {
    ...base,
    status: 'partial',
    objectResults: [
      base.objectResults[0],
      {
        objectApiName: 'Knowledge__kav',
        recordsCreated: 6,
        recordsFailed: 0,
        createdIds: [],
        errors: [],
        optional: true,
      },
    ],
    knowledge: {
      publish: {
        asked: 6,
        done: 5,
        notDone: [
          {
            key: 'retail-orders-article-refund',
            reason:
              'Left a draft: INSUFFICIENT_ACCESS: You do not have the permission to publish articles.',
          },
        ],
      },
      links: { asked: 20, done: 20, notDone: [] },
    },
  };
}

describe('ScenarioFlow — a scenario from its review to its test file', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: 'org-dev' });
  });

  it('reads the org before the run, says what it writes there, seeds it with what it read, and offers the test file', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    expect(sent('seed:scenario:prepare')).toEqual([]);

    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    expect(sent('seed:scenario:prepare')[0]?.payload).toEqual({
      orgId: 'org-dev',
      pack: RETAIL_ORDERS_PACK,
      seed: 1,
    });
    expect((screen.getByTestId('btn-scenario-start') as HTMLButtonElement).disabled).toBe(true);
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });

    expect(screen.getByTestId('scenario-plan').textContent).toContain('14 tests for the agent.');
    expect(screen.getByTestId('scenario-statuses').textContent).toBe(
      "Open cases are written as Received and closed ones as Resolved: the org's own statuses.",
    );
    expect(screen.getByTestId('scenario-knowledge-absent').textContent).toContain(
      'the agent will have no article to cite',
    );
    expect(sent('seed:scenario:execute')).toEqual([]);

    fireEvent.click(screen.getByTestId('btn-scenario-start'));
    expect(sent('seed:scenario:execute')[0]?.payload).toEqual({
      orgId: 'org-dev',
      pack: RETAIL_ORDERS_PACK,
      options: PREPARATION.options,
    });
    answer('seed:scenario:execute', 'seed:execute:response', result({ kind: 'kept' }));

    expect(screen.getByTestId('scenario-results-tests').textContent).toContain(
      '10 of the 10 open cases the tests are about were written.',
    );
    // The articles' card says why they were skipped: nothing more is said of them.
    expect(screen.queryByTestId('scenario-results-knowledge')).toBeNull();
    // The org's agents are read for the test file, which the run did not write.
    expect(sent('seed:scenario:agents')[0]?.payload).toEqual({ orgId: 'org-dev' });
  });

  it('says on the card of a role object what it linked to the roles the platform wrote, as the Seed results do', () => {
    // The card said it in its badge alone.
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });
    fireEvent.click(screen.getByTestId('btn-scenario-start'));
    const base = result({ kind: 'kept' });
    answer('seed:scenario:execute', 'seed:execute:response', {
      ...base,
      objectResults: [
        ...base.objectResults,
        {
          objectApiName: 'OpportunityContactRole',
          recordsCreated: 0,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
          writtenByThePlatform: { records: 1, given: 1 },
        },
      ],
    });

    expect(
      screen.getByTestId('scenario-result-written-by-the-platform-OpportunityContactRole')
        .textContent,
    ).toBe(
      '1 contact role linked to the one the platform wrote with its opportunity, for the contact ' +
        'it went in with, not written; given the fields generated for it: 1.',
    );
  });

  it('says before the run that the bodies go to Summary and the articles are published and linked, then what was, and the article left a draft in the org’s words', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', {
      preparation: PREPARATION_WITH_KNOWLEDGE,
    });

    expect(screen.getByTestId('scenario-knowledge-body').textContent).toBe(
      "This org's Knowledge has no other field for an article body: each body goes to Summary, " +
        'within its 1000 characters, every fact kept.',
    );
    expect(screen.getByTestId('scenario-knowledge-publication').textContent).toBe(
      'Once every record is written, the articles are published and each closed case is linked ' +
        "to the article that answers it: an agent's data library indexes published articles alone.",
    );
    expect(screen.queryByText(/drafts/)).toBeNull();

    fireEvent.click(screen.getByTestId('btn-scenario-start'));
    expect(sent('seed:scenario:execute')[0]?.payload).toMatchObject({
      options: { articleBodyField: 'Summary', articleBodyLength: 1000 },
    });
    answer('seed:scenario:execute', 'seed:execute:response', resultWithKnowledge());

    expect(screen.getByTestId('scenario-knowledge-published').textContent).toBe(
      'Articles published: 5 of 6' +
        'retail-orders-article-refund: Left a draft: INSUFFICIENT_ACCESS: You do not have the ' +
        'permission to publish articles.',
    );
    expect(screen.getByTestId('scenario-knowledge-linked').textContent).toBe(
      'Closed cases linked to the article that answers them: 20 of 20',
    );
    expect(screen.getByTestId('scenario-knowledge-drafts-left')).toBeTruthy();
  });

  it('asks what the org runs for a run that publishes its articles, the mute it offers planned as the run plans its own', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });

    expect(sent('seed:automation').map((m) => m.payload)).toEqual([
      {
        orgId: 'org-dev',
        objects: ['Account', 'Contact', 'Case', 'CaseComment', 'Knowledge__kav'],
        publishes: true,
      },
    ]);
  });

  it('offers both boxes on the confirmation, sends them, and names the checkpoint in the results', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });

    const toggle = screen.getByTestId('scenario-checkpoint-first-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('btn-scenario-start'));
    expect(sent('seed:scenario:execute')[0]?.payload).toMatchObject({ checkpointFirst: {} });

    answer('seed:scenario:execute', 'seed:execute:response', {
      ...result({ kind: 'kept' }),
      checkpoint: {
        state: 'taken',
        checkpointId: 'ck-20261028-000000-a1b2',
        name: 'Before Seed run 2026-10-28 00:00 UTC',
        takenAt: '2026-10-28T00:00:00.000Z',
        expiresAt: '2026-11-04T00:00:00.000Z',
        objects: ['Account'],
        records: 38,
        bytes: 2_200_000,
        requests: 68,
        added: [],
        notHeld: [{ objectApiName: 'Knowledge__kav', reason: 'Article versions are never held.' }],
      },
    });
    expect(screen.getByTestId('scenario-result-checkpoint-not-held').textContent).toContain(
      'Knowledge__kav',
    );
    expect(screen.getByTestId('scenario-result-checkpoint-action').textContent).toBe(
      'Rewind to before this run…',
    );
  });

  it('goes back from a refusal to the confirmation, where the box it names is still ticked', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });
    fireEvent.click(screen.getByTestId('scenario-checkpoint-first-toggle'));
    fireEvent.click(screen.getByTestId('btn-scenario-start'));
    answer('seed:scenario:execute', 'seed:error', {
      message: 'Refused.',
      code: 'CHECKPOINT_REFUSED',
      checkpointRefusal: 'DISK',
    });

    expect(screen.getByTestId('scenario-error').textContent).toContain(
      "This machine's disk has too little room for it.",
    );
    fireEvent.click(screen.getByTestId('btn-scenario-back-to-confirm'));
    // The org is read again for the run, as for every confirmation.
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });
    expect(
      (screen.getByTestId('scenario-checkpoint-first-toggle') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('says no test file can be written from a run that wrote no open case', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });
    fireEvent.click(screen.getByTestId('btn-scenario-start'));
    answer('seed:scenario:execute', 'seed:execute:response', result({ kind: 'none' }));

    expect(screen.getByTestId('scenario-results-no-file').textContent).toBe(
      'No open case was written: no test file can be written from this run.',
    );
    expect(sent('seed:scenario:agents')).toEqual([]);
  });

  it('seeds a drafted pack only once it is saved in the workspace', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'draft' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    const next = screen.getByTestId('btn-scenario-continue') as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('btn-scenario-save'));
    expect(sent('seed:scenario:save')[0]?.payload).toEqual({ pack: RETAIL_ORDERS_PACK });
    answer('seed:scenario:save', 'seed:scenario:save:response', {
      outcome: {
        kind: 'saved',
        path: '/ws/retail-orders.sandforge-scenario.json',
        relativePath: 'retail-orders.sandforge-scenario.json',
      },
    });

    expect(next.disabled).toBe(false);
    expect(screen.getByTestId('scenario-review').textContent).toContain(
      'From retail-orders.sandforge-scenario.json',
    );
  });

  it('names every issue of a pack the org cannot take, and starts nothing', () => {
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', {
      issues: ['options.articleBodyField: Title is not a field of Knowledge__kav'],
    });

    expect(screen.getByTestId('scenario-issues').textContent).toContain('options.articleBodyField');
    expect((screen.getByTestId('btn-scenario-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the number its draws start from Variant, says when to change it, and prepares the run with it', () => {
    // Labelled "Seed" under "Seed Retail orders", it read as the module, and
    // nothing said to change it before a second run in the same org.
    render(
      <ScenarioFlow
        picked={{ pack: RETAIL_ORDERS_PACK, source: { kind: 'built-in' } }}
        orgs={[DEV]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-scenario-continue'));
    answer('seed:scenario:prepare', 'seed:scenario:prepare:response', { preparation: PREPARATION });

    const variant = screen.getByLabelText(en.seed.scenario.confirm.variant);
    expect(variant).toBe(screen.getByTestId('scenario-seed'));
    expect(screen.queryByLabelText('Seed')).toBeNull();
    const hint = document.getElementById(variant.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(en.seed.scenario.confirm.variantHint);
    expect(screen.getByTestId('scenario-plan').textContent).toContain(
      'Checked before writing: Production Guard, storage, automation and emails, duplicate rules.',
    );

    fireEvent.change(variant, { target: { value: '2' } });
    expect(sent('seed:scenario:prepare').pop()?.payload).toMatchObject({ seed: 2 });
  });
});
