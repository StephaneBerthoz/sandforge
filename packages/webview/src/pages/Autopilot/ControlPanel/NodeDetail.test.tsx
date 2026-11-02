import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { AutopilotGraph, RecordTypeGiven } from '@sandforge/shared';
import '../../../i18n';
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
});
