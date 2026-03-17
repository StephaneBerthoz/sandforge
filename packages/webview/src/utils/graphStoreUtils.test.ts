import { describe, it, expect } from 'vitest';
import { updateGraphNodeStatus, updateGraphNodeProgress } from './graphStoreUtils';

interface TestNode {
  objectApiName: string;
  status: string;
  progress: number;
  successCount: number;
}

const makeNodes = (): TestNode[] => [
  { objectApiName: 'Account', status: 'pending', progress: 0, successCount: 0 },
  { objectApiName: 'Contact', status: 'pending', progress: 0, successCount: 0 },
  { objectApiName: 'Opportunity', status: 'pending', progress: 0, successCount: 0 },
];

describe('updateGraphNodeStatus', () => {
  it('updates status of the matching node', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeStatus(nodes, 'Contact', 'completed');
    expect(result[1]!.status).toBe('completed');
    expect(result[1]!.progress).toBe(0); // preserved
  });

  it('updates status and progress when progress is provided', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeStatus(nodes, 'Account', 'running', 50);
    expect(result[0]!.status).toBe('running');
    expect(result[0]!.progress).toBe(50);
  });

  it('preserves progress when progress is undefined', () => {
    const nodes = [
      { objectApiName: 'Account', status: 'running', progress: 75, successCount: 0 },
    ];
    const result = updateGraphNodeStatus(nodes, 'Account', 'completed');
    expect(result[0]!.progress).toBe(75);
  });

  it('does not mutate non-matching nodes', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeStatus(nodes, 'Contact', 'completed', 100);
    expect(result[0]).toEqual(nodes[0]);
    expect(result[2]).toEqual(nodes[2]);
  });

  it('returns a new array reference', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeStatus(nodes, 'Account', 'running');
    expect(result).not.toBe(nodes);
  });

  it('leaves array unchanged when objectName does not match', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeStatus(nodes, 'Lead', 'completed');
    expect(result).toEqual(nodes);
  });

  it('handles empty array', () => {
    const result = updateGraphNodeStatus([], 'Account', 'running');
    expect(result).toEqual([]);
  });
});

describe('updateGraphNodeProgress', () => {
  it('updates progress and counter field of the matching node', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeProgress(nodes, 'Account', 80, 'successCount', 42);
    expect(result[0]!.progress).toBe(80);
    expect(result[0]!.successCount).toBe(42);
  });

  it('does not mutate non-matching nodes', () => {
    const nodes = makeNodes();
    const result = updateGraphNodeProgress(nodes, 'Account', 80, 'successCount', 42);
    expect(result[1]).toEqual(nodes[1]);
    expect(result[2]).toEqual(nodes[2]);
  });
});
