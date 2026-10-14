import { describe, expect, it } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { forgeRunFingerprint } from './runFingerprint.js';

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
    ...overrides,
  };
}

function graph(nodes: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes,
    edges: [
      {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'lookup',
      },
    ],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

const setup = {
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  config: { depth: 'direct', filters: { Account: "Name != 'x'" } },
};

describe('forgeRunFingerprint', () => {
  it('is the same for the same setup, whatever the order of its keys and what discovery counted', () => {
    const a = forgeRunFingerprint(graph([node('Account'), node('Contact')]), setup);
    const b = forgeRunFingerprint(
      graph([node('Contact', { recordCount: 99, status: 'done' }), node('Account')]),
      {
        config: { filters: { Account: "Name != 'x'" }, depth: 'direct' },
        targetOrgId: 'tgt',
        sourceOrgId: 'src',
      },
    );
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
  });

  it('changes with an object left out, a field anonymized, a filter, or another target', () => {
    const base = forgeRunFingerprint(graph([node('Account'), node('Contact')]), setup);
    expect(
      forgeRunFingerprint(graph([node('Account'), node('Contact', { included: false })]), setup),
    ).not.toBe(base);
    expect(
      forgeRunFingerprint(
        graph([node('Account'), node('Contact', { anonymizeFields: ['Email'] })]),
        setup,
      ),
    ).not.toBe(base);
    expect(
      forgeRunFingerprint(graph([node('Account'), node('Contact')]), {
        ...setup,
        config: { ...setup.config, filters: { Account: "Name = 'x'" } },
      }),
    ).not.toBe(base);
    expect(
      forgeRunFingerprint(graph([node('Account'), node('Contact')]), {
        ...setup,
        targetOrgId: 'other',
      }),
    ).not.toBe(base);
  });
});
