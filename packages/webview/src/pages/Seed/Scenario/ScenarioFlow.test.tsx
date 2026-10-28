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
});
