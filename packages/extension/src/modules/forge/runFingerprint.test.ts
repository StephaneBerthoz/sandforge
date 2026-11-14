import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { forgeRunFingerprint, sameRunSetup, sampleFingerprintOf } from './runFingerprint.js';

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

describe('the fingerprint of a sample of the whole org', () => {
  const whole = graph([node('Account'), node('Contact')]);
  /** The panel's setup: the run's config, a sample in it. */
  const panel = (sample: unknown) => ({ ...setup, config: { ...setup.config, sample } });

  it('is the same for options left at their default or given at it, and objects asked whole in any order', () => {
    expect(
      forgeRunFingerprint(whole, panel({ withinMB: 3, whole: ['Region__c', 'Country__c'] })),
    ).toBe(
      forgeRunFingerprint(
        whole,
        panel({
          withinMB: 3,
          seed: 1,
          draw: 'uniform',
          parents: 'all',
          children: 100,
          floor: 1,
          whole: ['Country__c', 'Region__c', 'Country__c'],
        }),
      ),
    );
  });

  it('changes with the seed, the draw, the bounds, the parents, the children, the floor and the objects asked whole', () => {
    const base = forgeRunFingerprint(whole, panel({ withinMB: 3 }));
    for (const other of [
      { withinMB: 3, seed: 2 },
      { withinMB: 3, draw: 'recent' },
      { withinMB: 4 },
      { withinMB: 3, maxTotal: 500 },
      { withinMB: 3, parents: 'required' },
      { withinMB: 3, children: 'all' },
      { withinMB: 3, floor: 0 },
      { withinMB: 3, whole: ['Region__c'] },
    ]) {
      expect(forgeRunFingerprint(whole, panel(other))).not.toBe(base);
    }
  });

  // A plan replayed is the same plan wherever its folder is: the run is
  // fingerprinted by its ids, never by where they were read from.
  it('changes with the plan a run replays, by its SHA-256, never with its path', () => {
    const at = (plan: string, planSha256: string) =>
      forgeRunFingerprint(whole, panel({ withinMB: 3, plan, planSha256 }));

    expect(at('/home/a/forge-samples/x', 'a'.repeat(64))).toBe(
      at('/tmp/copied/plan', 'a'.repeat(64)),
    );
    expect(at('/home/a/forge-samples/x', 'a'.repeat(64))).not.toBe(
      at('/home/a/forge-samples/x', 'b'.repeat(64)),
    );
    expect(
      forgeRunFingerprint(whole, panel({ withinMB: 3, plan: '/home/a/forge-samples/x' })),
    ).toBe(forgeRunFingerprint(whole, panel({ withinMB: 3 })));
  });

  it('reads a sample at the top of the setup, as the command line gives it, as the panel’s', () => {
    expect(
      forgeRunFingerprint(whole, { ...setup, sample: { seed: 1, plan: '/a', planSha256: 'c' } }),
    ).toBe(
      forgeRunFingerprint(whole, { ...setup, sample: sampleFingerprintOf({ plan: '/b' }, 'c') }),
    );
    expect(sampleFingerprintOf(undefined)).toBeUndefined();
  });

  it('keeps the fingerprint of a run of every record as it was', () => {
    expect(forgeRunFingerprint(whole, panel(undefined))).toBe(forgeRunFingerprint(whole, setup));
    expect(sameRunSetup(forgeRunFingerprint(whole, setup), whole, panel(undefined))).toBe(true);
  });
});
