import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { forgeRunFingerprint, sameRunSetup } from './runFingerprint.js';

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

  it('is the same whether discovery counted a table empty and left it out, or found rows in it', () => {
    // The opportunities' table held rows another check put in the source,
    // none under the record cloned, when the dry run counted it; the real
    // run found it empty again.
    const holding = graph([node('Account'), node('Contact'), node('Opportunity')]);
    const empty = graph([
      node('Account'),
      node('Contact'),
      node('Opportunity', { recordCount: 0, included: false, level: 1 }),
    ]);
    expect(forgeRunFingerprint(empty, setup)).toBe(forgeRunFingerprint(holding, setup));
  });

  it('still changes with a table left out by the user, or one the source would not count', () => {
    const base = forgeRunFingerprint(graph([node('Account'), node('Contact')]), setup);
    expect(
      forgeRunFingerprint(
        graph([
          node('Account'),
          node('Contact', { recordCount: 0, included: false, leftOutByUser: true }),
        ]),
        setup,
      ),
    ).not.toBe(base);
    expect(
      forgeRunFingerprint(
        graph([
          node('Account'),
          node('Contact', {
            recordCount: 0,
            included: false,
            status: 'error',
            errors: ['Record count unavailable: INVALID_TYPE'],
          }),
        ]),
        setup,
      ),
    ).not.toBe(base);
  });
});

describe('sameRunSetup', () => {
  const empty = graph([
    node('Account'),
    node('Contact', { recordCount: 0, included: false, level: 1 }),
  ]);

  it('takes the fingerprint of the run it is asked of', () => {
    expect(sameRunSetup(forgeRunFingerprint(empty, setup), empty, setup)).toBe(true);
    expect(sameRunSetup(forgeRunFingerprint(empty, setup), empty, { ...setup, x: 1 })).toBe(false);
  });

  it('takes the fingerprint a journal kept before an empty table counted as one the run takes', () => {
    // The fingerprint of 1.52, which took the graph's own `included`.
    const before = createHash('sha256')
      .update(
        JSON.stringify({
          edges: [
            {
              relationshipName: 'Contacts',
              required: false,
              sourceObject: 'Account',
              targetObject: 'Contact',
            },
          ],
          nodes: [
            { anonymizeFields: [], included: true, objectApiName: 'Account' },
            { anonymizeFields: [], included: false, objectApiName: 'Contact' },
          ],
          setup: {
            config: { depth: 'direct', filters: { Account: "Name != 'x'" } },
            sourceOrgId: 'src',
            targetOrgId: 'tgt',
          },
        }),
      )
      .digest('hex');
    expect(before).not.toBe(forgeRunFingerprint(empty, setup));
    expect(sameRunSetup(before, empty, setup)).toBe(true);
    // Of that kind, a table that holds rows now is a table left in: not alike.
    const holding = graph([node('Account'), node('Contact')]);
    expect(sameRunSetup(before, holding, setup)).toBe(false);
  });
});
