import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { AutopilotGraph, RecordTypeGiven } from '@sandforge/shared';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { NodeDetail } from './NodeDetail';

const GIVEN: RecordTypeGiven = {
  objectApiName: 'Opportunity',
  rows: 3,
  why: { masterInSource: 3 },
  predicted: { developerName: 'Retail', label: 'Retail', basis: 'userDefault' },
  readBack: { read: 3, types: [{ developerName: 'Retail', label: 'Retail', rows: 3 }] },
};

function graphOf(): AutopilotGraph {
  return {
    nodes: [
      {
        objectApiName: 'Opportunity',
        label: 'Opportunity',
        recordCount: 3,
        status: 'completed',
        progress: 100,
      },
    ],
    edges: [],
  } as unknown as AutopilotGraph;
}

describe('NodeDetail', () => {
  afterEach(() => useAutopilotStore.getState().reset());

  it('says the record type the target gave the node’s records, once the outcome says it', () => {
    const store = useAutopilotStore.getState();
    store.setGraph(graphOf());
    store.selectNode('Opportunity');
    render(<NodeDetail />);
    expect(screen.queryByTestId('node-record-type')).toBeNull();

    act(() => store.updateNodeOutcome('Opportunity', { recordTypeGiven: GIVEN }));

    expect(screen.getByTestId('node-record-type').textContent).toContain('Retail');
  });

  it('says how many records stayed without which lookup and why, and that they are written', () => {
    const store = useAutopilotStore.getState();
    store.setGraph(graphOf());
    store.selectNode('Opportunity');
    render(<NodeDetail />);
    expect(screen.queryByTestId('node-lookup-refusals')).toBeNull();

    act(() =>
      store.updateNodeOutcome('Opportunity', {
        lookupsFilled: 4,
        lookupRefusals: [
          {
            statusCode: 'PARENT_REFUSED',
            fields: ['Parent__c'],
            count: 2,
            message:
              'the Opportunity record its Parent__c names was refused in this run, and this ' +
              'record, written before it, keeps its Parent__c empty.',
          },
        ],
      }),
    );

    expect(screen.getByTestId('node-lookups-filled').textContent).toContain('4');
    const list = screen.getByTestId('node-lookup-refusals');
    expect(list.textContent).toContain(en.autopilot.control.lookupRefusals);
    const line = within(list).getByRole('listitem');
    expect(line.textContent).toContain('PARENT_REFUSED');
    expect(line.textContent).toContain('Parent__c');
    expect(line.textContent).toContain('2 records');
    // Not the hint of a record held back: this one went in.
    const hint = within(line).getByTestId('error-hint');
    expect(hint.textContent).toContain(en.errors.parentRefused.keptEmpty.explanation);
    expect(hint.textContent).not.toContain(en.errors.parentRefused.explanation);
  });
});
