import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { BaseMessage } from '@sandforge/shared';
import '../../i18n';
import { ReviewWholeOrgNotes, personalFieldsAsIs } from './ReviewWholeOrgNotes';
import { useAppStore } from '../../stores/useAppStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { wholeOrgGraph } from './testing/wholeOrg';

/* ---- Bridge double: what the notes post, and a way to answer it ---- */
const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

/** The messages posted of `type`. */
function sent(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage }).payload)
    .filter((message) => message.type === type) as Array<
    BaseMessage & { payload: Record<string, unknown> }
  >;
}

/** The extension answering the last `forge:target-records:request`. */
function answer(type: string, payload: Record<string, unknown>): void {
  const [request] = sent('forge:target-records:request').slice(-1);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: 'host-1', type, timestamp: Date.now(), correlationId: request.id, payload },
      }),
    );
  });
}

describe('personalFieldsAsIs', () => {
  it('lists every personal field of the objects written while nothing is anonymized', () => {
    expect(personalFieldsAsIs(wholeOrgGraph(), false)).toEqual([
      { objectApiName: 'Account', fields: ['Phone'] },
      { objectApiName: 'Contact', fields: ['Email', 'Phone', 'Birthdate'] },
      { objectApiName: 'Lead', fields: ['Email'] },
    ]);
  });

  it('leaves out the fields anonymized, and the objects the run does not write', () => {
    const graph = wholeOrgGraph();
    graph.nodes[1] = { ...graph.nodes[1], anonymizeFields: ['Email', 'Phone'] };
    graph.nodes[2] = { ...graph.nodes[2], included: false };

    expect(personalFieldsAsIs(graph, true)).toEqual([
      { objectApiName: 'Account', fields: ['Phone'] },
      { objectApiName: 'Contact', fields: ['Birthdate'] },
    ]);
    // Anonymize off: what a node selects anonymizes nothing.
    expect(personalFieldsAsIs(graph, false).map((o) => o.objectApiName)).toEqual([
      'Account',
      'Contact',
    ]);
  });
});

describe('ReviewWholeOrgNotes', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  function renderNotes(anonymizePII = false): void {
    render(
      <ReviewWholeOrgNotes
        graph={wholeOrgGraph()}
        anonymizePII={anonymizePII}
        targetOrgId="org-tgt"
        target="uat"
      />,
    );
  }

  it('says before Execute how many personal fields go in as they are, and lists them by object', () => {
    renderNotes();

    expect(screen.getByTestId('review-personal-as-is').textContent).toBe(
      '5 personal fields, on 3 objects, go into uat as the source holds them, not anonymized. Turn them into fiction on the Anonymization row.',
    );
    expect(screen.getByTestId('review-personal-as-is').id).toBe('review-personal-as-is');
    expect(screen.getByTestId('review-personal-as-is-list').textContent).toContain(
      'Contact: Email, Phone, Birthdate',
    );
  });

  it('says every personal field is anonymized when none goes as it is', () => {
    const graph = wholeOrgGraph();
    graph.nodes = graph.nodes.map((node) => ({ ...node, anonymizeFields: [...node.piiFields] }));
    render(<ReviewWholeOrgNotes graph={graph} anonymizePII targetOrgId="org-tgt" target="uat" />);

    expect(screen.getByTestId('review-personal-as-is').textContent).toBe(
      'Every personal field discovery found is anonymized.',
    );
    expect(screen.queryByTestId('review-personal-as-is-list')).toBeNull();
  });

  it('asks once what the target holds of every object of the graph', () => {
    renderNotes();

    expect(sent('forge:target-records:request').map((m) => m.payload)).toEqual([
      { targetOrgId: 'org-tgt', objectApiNames: ['Account', 'Contact', 'Lead', 'Opportunity'] },
    ]);
  });

  it('says what the target holds already of the objects copied, and where to empty them first', () => {
    renderNotes();
    answer('forge:target-records:response', {
      targetOrgId: 'org-tgt',
      objects: [
        { objectApiName: 'Contact', records: 1_500 },
        { objectApiName: 'Account', records: 20 },
        // Not copied by this run: said nowhere.
        { objectApiName: 'Case', records: 900 },
      ],
    });

    expect(screen.getByTestId('review-target-holds-some').textContent).toBe(
      'uat already holds about 1,520 records of 2 of these objects. The run adds its own beside them, it does not replace them, and a unique field or a duplicate rule may refuse some.',
    );
    expect(screen.getByTestId('review-target-holds-empty-first').textContent).toBe(
      'To start from an empty target, empty these objects first in DataOps → Cleanup → Empty objects, then discover the org again here.',
    );
    expect(screen.getByTestId('review-target-holds').textContent).not.toContain('Case');
  });

  it('opens DataOps on Cleanup for the target, the objects it holds already picked', () => {
    renderNotes();
    answer('forge:target-records:response', {
      targetOrgId: 'org-tgt',
      objects: [
        { objectApiName: 'Contact', records: 1_500 },
        { objectApiName: 'Account', records: 20 },
      ],
    });

    fireEvent.click(screen.getByTestId('review-target-holds-empty-first-btn'));

    expect(useAppStore.getState().currentRoute).toBe('dataops');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'dataops',
      targetOrgId: 'org-tgt',
      emptyObjects: ['Contact', 'Account'],
    });
    // The org picked on one page is the org picked on all of them.
    expect(useOrgStore.getState().selectedOrgId).toBe('org-tgt');
  });

  it('says the target holds none of them when its counts say so', () => {
    renderNotes();
    answer('forge:target-records:response', { targetOrgId: 'org-tgt', objects: [] });

    expect(screen.getByTestId('review-target-holds-none').textContent).toBe(
      'uat holds no record of the objects the run copies, as its record counts say.',
    );
    expect(screen.queryByTestId('review-target-holds-empty-first')).toBeNull();
  });

  // A read that failed is not a target that holds nothing.
  it('says the read failed rather than an empty target', () => {
    renderNotes();
    answer('forge:target-records:error', {
      message: 'INVALID_SESSION_ID',
      code: 'TARGET_RECORDS_ERROR',
      retryable: true,
    });

    expect(screen.getByTestId('review-target-holds-failed').textContent).toBe(
      'What uat already holds of these objects could not be read: INVALID_SESSION_ID',
    );
    expect(screen.queryByTestId('review-target-holds-none')).toBeNull();
  });
});
