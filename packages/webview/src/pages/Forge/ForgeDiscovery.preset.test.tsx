import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import '../../i18n';
import { ForgeDiscovery } from './ForgeDiscovery';
import { useForgeStore } from '../../stores/useForgeStore';

/**
 * A preset picked in Review — or brought back by a saved template — belongs to
 * the graph it is shown beside. The extension returns a new graph with every
 * PII field it found selected, so without this the Review tab showed the
 * preset's name over fields it never chose.
 */

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: () => <div data-testid="live-graph" />,
}));

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '003000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: true,
  skipEmpty: false,
  batchSize: 'auto',
};

/** A Contact as discovery returns it with anonymization on: every PII field selected. */
const DISCOVERED: ForgeGraph = {
  nodes: [
    {
      objectApiName: 'Contact',
      recordCount: 1,
      fieldCount: 40,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['Email', 'Title', 'Description'],
      anonymizeFields: ['Email', 'Title', 'Description'],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 30,
      estimatedSizeMB: 0,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

function discoveryAnswers(): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'discover-1',
          type: 'forge:discover:response',
          timestamp: Date.now(),
          payload: { graph: DISCOVERED },
        },
      }),
    );
  });
}

describe('ForgeDiscovery — the preset kept for the run', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setPhase('discovery');
  });

  it('narrows the discovered graph to the fields the kept preset names', () => {
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setAnonymizationPresetId('preset:gdpr-default');
    render(<ForgeDiscovery />);

    discoveryAnswers();

    expect(useForgeStore.getState().graph?.nodes[0].anonymizeFields).toEqual(['Email']);
  });

  it('leaves the graph as discovered when the run does not anonymize', () => {
    useForgeStore.getState().setConfig({ ...CONFIG, anonymizePII: false });
    useForgeStore.getState().setAnonymizationPresetId('preset:gdpr-default');
    render(<ForgeDiscovery />);

    discoveryAnswers();

    expect(useForgeStore.getState().graph?.nodes[0].anonymizeFields).toEqual([
      'Email',
      'Title',
      'Description',
    ]);
  });

  it('leaves the graph as discovered when no preset was kept', () => {
    useForgeStore.getState().setConfig(CONFIG);
    render(<ForgeDiscovery />);

    discoveryAnswers();

    expect(useForgeStore.getState().graph?.nodes[0].anonymizeFields).toHaveLength(3);
  });
});
