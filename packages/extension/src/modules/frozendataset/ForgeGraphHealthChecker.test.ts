import { describe, expect, it } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeGraphHealthChecker } from './ForgeGraphHealthChecker.js';

function makeNode(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 0,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

function graphWith(nodes: ForgeGraphNode[], truncated = false): ForgeGraph {
  return {
    nodes,
    edges: [],
    totalRecords: nodes.reduce((n, node) => n + node.recordCount, 0),
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
    truncated,
  };
}

const ROOT_ID = '001A000000aaaaA';

describe('ForgeGraphHealthChecker', () => {
  it('is healthy when discovery reaches every expected object, untruncated', async () => {
    const checker = new ForgeGraphHealthChecker(
      { discover: async () => graphWith([makeNode('Account', 1), makeNode('Contact', 2)]) },
      'org1',
      { rootObject: 'Account', expectedObjects: ['Account', 'Contact'] },
    );
    const health = await checker.check(ROOT_ID);
    expect(health.healthy).toBe(true);
  });

  it('is lame when the graph is truncated or an expected object is missing', async () => {
    const truncated = new ForgeGraphHealthChecker(
      {
        discover: async () => graphWith([makeNode('Account', 1), makeNode('Contact', 2)], true),
      },
      'org1',
      { rootObject: 'Account', expectedObjects: ['Contact'] },
    );
    expect((await truncated.check(ROOT_ID)).healthy).toBe(false);

    const missing = new ForgeGraphHealthChecker(
      { discover: async () => graphWith([makeNode('Account', 1)]) },
      'org1',
      { rootObject: 'Account', expectedObjects: ['Contact'] },
    );
    const health = await missing.check(ROOT_ID);
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('Contact');
  });

  it('optionally requires non-empty expected objects', async () => {
    const checker = new ForgeGraphHealthChecker(
      { discover: async () => graphWith([makeNode('Account', 1), makeNode('Contact', 0)]) },
      'org1',
      { rootObject: 'Account', expectedObjects: ['Contact'], requireNonEmptyObjects: true },
    );
    const health = await checker.check(ROOT_ID);
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('no records');
  });

  it('is lame (not crashed) when discovery throws', async () => {
    const checker = new ForgeGraphHealthChecker(
      {
        discover: async () => {
          throw new Error('org timeout');
        },
      },
      'org1',
      { rootObject: 'Account', expectedObjects: [] },
    );
    const health = await checker.check(ROOT_ID);
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('org timeout');
  });
});
