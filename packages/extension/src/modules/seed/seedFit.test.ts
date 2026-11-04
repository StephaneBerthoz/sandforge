import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  BYTES_PER_MB,
  SALES_CLOUD_STARTER,
  SERVICE_CLOUD_STARTER,
  mutePlanOf,
  plannedChildCount,
  type ForgeTargetAutomation,
  type ForgeTargetFlow,
  type SeedObjectConfig,
  type SeedRelation,
  type SeedTemplate,
} from '@sandforge/shared';

import { fitBudgetOf, roomBytesOf, type FitBudget } from '../forge/fitBudget.js';
import { seedRequestsEstimate, seedStorageBytes } from './seedStorage.js';
import {
  fitSeedTemplate,
  fittedTemplate,
  seedAuditFitOf,
  seedCountsAt,
  seedFitProposalOf,
  seedRoomOf,
  seedWritesOf,
  seedWritesOfObjects,
} from './seedFit.js';

const KB = 1024;

/** The budget of a Developer Edition that says it has all of its 5 MB left, and its day of requests. */
function developerEdition(): FitBudget {
  const budget = fitBudgetOf({
    storage: { maxMB: 5, remainingMB: 5 },
    api: { max: 15_000, remaining: 15_000 },
  });
  if ('unread' in budget) throw new Error('read');
  return budget;
}

/** A budget of exactly `bytes`, with `runRequests` when given. */
function budgetOf(bytes: number, runRequests?: number): FitBudget {
  return {
    bytes,
    terms: { remainingMB: 500, maxMB: 500, share: 0.8, roundingMB: 0.5, limitedBy: 'storage' },
    ...(runRequests !== undefined ? { runRequests } : {}),
  };
}

const NO_ROOM = { perRecord: [], notCounted: [] };

/** What a template takes once given `counts`, the room under its records included. */
function bytesAt(
  template: SeedTemplate,
  counts: ReadonlyMap<string, number>,
  room: Parameters<typeof roomBytesOf>[0] = NO_ROOM,
): number {
  const fitted = {
    ...template,
    objects: template.objects.map((o) => ({
      ...o,
      recordCount: counts.get(o.objectApiName) ?? o.recordCount,
    })),
  };
  return seedStorageBytes(fitted, []) + roomBytesOf(room, (name) => counts.get(name) ?? 0);
}

/** An object of a template, `count` records of it. */
function object(objectApiName: string, recordCount: number, rows?: number): SeedObjectConfig {
  return {
    objectApiName,
    recordCount,
    fieldRules: [],
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
    ...(rows !== undefined
      ? { rows: Array.from({ length: rows }, (_, i) => ({ key: `r${i}`, values: {} })) }
      : {}),
  };
}

/** A template of these objects and relations. */
function templateOf(objects: SeedObjectConfig[], relations: SeedRelation[] = []): SeedTemplate {
  return {
    id: 'fit-test',
    name: 'fit test',
    description: '',
    version: 1,
    strategy: 'faker',
    objects,
    relations,
    tags: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

/** A relation of `child` under the records the seed writes of `parent`. */
function under(
  child: string,
  parent: string,
  distribution: SeedRelation['distribution'],
  parents: SeedRelation['parents'] = { kind: 'generated' },
): SeedRelation {
  return {
    childObject: child,
    lookupField: `${parent}Id`,
    parentObject: parent,
    parents,
    distribution,
  };
}

/** A flow of the target, read with its start condition, creating nothing unless told. */
function flow(overrides: Partial<ForgeTargetFlow>): ForgeTargetFlow {
  return {
    apiName: 'Flow',
    label: 'Flow',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/**
 * A target whose account flow creates a Task under each account inserted
 * unless its user holds the bypass, whose article flow creates a Task under
 * each article updated, and whose account update flow creates another.
 */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Knowledge__kav'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        flow({
          apiName: 'Account_Follow_Up',
          label: 'Account follow-up',
          creates: ['Task'],
          permissions: [{ name: 'Account_Bypass', bypass: true, held: false }],
        }),
        flow({
          apiName: 'Account_Review',
          label: 'Account review',
          startsOn: 'update',
          creates: ['Task'],
        }),
      ],
      triggers: [{ name: 'AccountTrigger', events: ['afterInsert'] }],
    },
    {
      objectApiName: 'Knowledge__kav',
      flows: [
        flow({
          apiName: 'Article_Published',
          label: 'Article published',
          startsOn: 'update',
          creates: ['Task'],
        }),
      ],
      triggers: [],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  bypassGrants: [
    {
      permission: 'Account_Bypass',
      permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
    },
  ],
  requests: 1,
};

describe('seedCountsAt', () => {
  it('keeps the share of a root, at least one, and no more children than the parents kept hold', () => {
    const counts = seedCountsAt(SALES_CLOUD_STARTER, 0.242);
    expect(Object.fromEntries(counts)).toEqual({
      Product2: 12,
      PricebookEntry: 12,
      Account: 121,
      Contact: 242,
      Opportunity: 484,
      OpportunityLineItem: 968,
    });
    // A child is held to its parents: 0.243 of 1,000 contacts is 243, two for each of 121 accounts 242.
    expect(seedCountsAt(SALES_CLOUD_STARTER, 0.2429).get('Contact')).toBe(242);
    expect(Object.values(Object.fromEntries(seedCountsAt(SALES_CLOUD_STARTER, 0.0001)))).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  it('caps an object and makes its children follow it, the share taken of what the caps leave', () => {
    const capped = seedCountsAt(SALES_CLOUD_STARTER, 1, { objects: { Account: 10 } });
    expect(Object.fromEntries(capped)).toMatchObject({
      Product2: 50,
      Account: 10,
      Contact: 20,
      Opportunity: 40,
      OpportunityLineItem: 80,
    });
    expect(seedCountsAt(SALES_CLOUD_STARTER, 0.5, { all: 100 }).get('Account')).toBe(50);
  });

  it('says caps that fit held the counts, and a template that fits as it is cut nothing', () => {
    const roomy = budgetOf(500 * BYTES_PER_MB);
    const capped = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget: roomy,
      room: NO_ROOM,
      ask: { caps: { objects: { Account: 10 } } },
    });
    expect(capped).toMatchObject({ heldBy: 'caps', records: 50 + 50 + 10 + 20 + 40 + 80 });
    expect(
      fitSeedTemplate({
        template: SALES_CLOUD_STARTER,
        personObjects: [],
        budget: roomy,
        room: NO_ROOM,
        ask: { caps: { all: 100_000 } },
      }).heldBy,
    ).toBe('whole');
  });
});

describe('fitSeedTemplate', () => {
  it('fits Sales Cloud Starter to a Developer Edition that says it has 5 MB left', () => {
    const fit = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget: developerEdition(),
      room: NO_ROOM,
    });

    expect(fit.proposal).toMatchObject({
      share: 0.242,
      objects: [
        { objectApiName: 'Product2', before: 50, after: 12 },
        { objectApiName: 'PricebookEntry', before: 50, after: 12 },
        { objectApiName: 'Account', before: 500, after: 121 },
        { objectApiName: 'Contact', before: 1000, after: 242 },
        { objectApiName: 'Opportunity', before: 2000, after: 484 },
        { objectApiName: 'OpportunityLineItem', before: 4000, after: 968 },
      ],
      budget: {
        remainingMB: 5,
        maxMB: 5,
        share: 0.8,
        roundingMB: 0.5,
        limitedBy: 'storage',
        automationMB: 0,
      },
    });
    expect(fit.proposal.cannotFit).toBeUndefined();
    expect(fit).toMatchObject({ heldBy: 'storage', records: 1839 });
    // 1,839 records at 2 KB: within 80 % of the 5 MB less half a MB for rounding.
    expect(fit.proposal.estimateMB * BYTES_PER_MB).toBe(1839 * 2 * KB);
    expect(fit.proposal.estimateMB).toBeLessThanOrEqual(0.8 * (5 - 0.5));
  });

  it('takes the largest share that fits: one account more, and the records no longer do', () => {
    const budget = developerEdition();
    const fit = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget,
      room: NO_ROOM,
    });
    const kept = fit.proposal.objects.find((o) => o.objectApiName === 'Account')?.after ?? 0;
    const at = (accounts: number) =>
      bytesAt(SALES_CLOUD_STARTER, seedCountsAt(SALES_CLOUD_STARTER, accounts / 500));

    expect(at(kept)).toBeLessThanOrEqual(budget.bytes);
    expect(at(kept + 1)).toBeGreaterThan(budget.bytes);
  });

  it('keeps room for what the flows that still run create, and none for what the mute keeps quiet', () => {
    const budget = developerEdition();
    const writes = seedWritesOf(SALES_CLOUD_STARTER);
    const unmuted = seedRoomOf(AUTOMATION, undefined, writes);
    const muted = seedRoomOf(AUTOMATION, mutePlanOf(AUTOMATION), writes);

    // The insert flow's Task, 2 KB under each account; the update flow fires on nothing a seed writes again.
    expect(unmuted.room.perRecord).toEqual([
      {
        objectApiName: 'Account',
        act: 'insert',
        bytes: 2 * KB,
        creates: [{ objectApiName: 'Task', by: 'Account follow-up' }],
      },
    ]);
    expect(unmuted.room.notCounted).toEqual([
      { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' },
    ]);
    expect(muted.room.perRecord).toEqual([]);

    const withRoom = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget,
      room: unmuted.room,
    });
    const counts = new Map(withRoom.proposal.objects.map((o) => [o.objectApiName, o.after]));
    // The records and the Tasks the flow creates under the accounts kept, together within the budget.
    expect(bytesAt(SALES_CLOUD_STARTER, counts, unmuted.room)).toBeLessThanOrEqual(budget.bytes);
    expect(withRoom.proposal.budget.automationMB).toBe(
      ((counts.get('Account') ?? 0) * 2 * KB) / BYTES_PER_MB,
    );
    expect(withRoom.proposal.budget.notCounted).toEqual([
      { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' },
    ]);
    const mutedFit = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget,
      room: muted.room,
    });
    expect(mutedFit.records).toBeGreaterThan(withRoom.records);
  });

  it('counts what fires on an update only for the article versions a scenario publishes', () => {
    const template = templateOf([object('Account', 10), object('Knowledge__kav', 4, 4)]);

    const seeded = seedRoomOf(AUTOMATION, undefined, seedWritesOf(template));
    expect(seeded.room.perRecord.map((r) => `${r.objectApiName} ${r.act}`)).toEqual([
      'Account insert',
    ]);
    const published = seedRoomOf(AUTOMATION, undefined, seedWritesOf(template, true));
    expect(published.room.perRecord.map((r) => `${r.objectApiName} ${r.act}`)).toEqual([
      'Account insert',
      'Knowledge__kav update',
    ]);
  });

  it('writes the objects a read names as the template that holds them writes them', () => {
    const template = templateOf([object('Account', 10), object('Knowledge__kav', 4, 4)]);
    const names = ['Account', 'Knowledge__kav'];
    for (const publishes of [false, true]) {
      const ofTemplate = seedWritesOf(template, publishes);
      const ofNames = seedWritesOfObjects(names, publishes);
      for (const name of [...names, 'Contact']) {
        for (const write of ['insert', 'update', 'delete', 'undelete'] as const) {
          expect(ofNames(name, write)).toBe(ofTemplate(name, write));
        }
      }
    }
    expect(seedWritesOfObjects(names)('Knowledge__kav', 'update')).toBe(false);
    expect(seedWritesOfObjects(names, true)('Knowledge__kav', 'update')).toBe(true);
    expect(seedWritesOfObjects(names, true)('Account', 'update')).toBe(false);
  });

  it('keeps no room, and says why, when the target’s automation could not be read', () => {
    expect(seedRoomOf({ unread: 'INVALID_SESSION_ID' }, undefined, () => true)).toEqual({
      room: { perRecord: [], notCounted: [], unread: 'INVALID_SESSION_ID' },
      unread: 'INVALID_SESSION_ID',
    });
  });

  it('says in its proposal that no room was kept when the target’s automation could not be read', () => {
    // A page given only "0 MB for its flows" would say none still running
    // creates records under them: of an automation nobody read.
    const unread = seedRoomOf({ unread: 'INVALID_SESSION_ID' }, undefined, () => true);
    const proposal = seedFitProposalOf(developerEdition(), SALES_CLOUD_STARTER, [], unread.room);
    expect(proposal).toMatchObject({
      automationUnread: 'INVALID_SESSION_ID',
      budget: { automationMB: 0 },
    });
    const read = seedRoomOf(AUTOMATION, mutePlanOf(AUTOMATION), seedWritesOf(SALES_CLOUD_STARTER));
    expect(
      seedFitProposalOf(developerEdition(), SALES_CLOUD_STARTER, [], read.room),
    ).not.toHaveProperty('automationUnread');
  });

  it('keeps rows whole, and says it cannot fit when they alone take more than the budget', () => {
    const template = templateOf(
      [object('Account', 40, 40), object('Case', 200)],
      [under('Case', 'Account', { mode: 'perParent', count: 5 })],
    );

    const fit = fitSeedTemplate({
      template,
      personObjects: [],
      budget: budgetOf(60 * 2 * KB),
      room: NO_ROOM,
    });
    expect(fit.proposal.objects).toEqual([
      { objectApiName: 'Account', before: 40, after: 40, keptWhole: 'rows' },
      { objectApiName: 'Case', before: 200, after: 20 },
    ]);

    const tooSmall = fitSeedTemplate({
      template,
      personObjects: [],
      budget: budgetOf(40 * KB),
      room: NO_ROOM,
    });
    expect(tooSmall.proposal.cannotFit).toBe(
      'the least it can be cut to — one Case and what follows it, with the 40 rows the template ' +
        'gives kept whole, 41 records — takes 0.09 MB, past the 0.04 MB that fit',
    );
    // At least one of each object.
    expect(tooSmall.proposal.objects.map((o) => o.after)).toEqual([40, 1]);

    const onlyRows = templateOf([object('Account', 40, 40)]);
    expect(
      fitSeedTemplate({
        template: onlyRows,
        personObjects: [],
        budget: budgetOf(40 * KB),
        room: NO_ROOM,
      }).proposal.cannotFit,
    ).toBe(
      'the 40 rows the template gives take 0.08 MB, past the 0.04 MB that fit, and rows are kept whole',
    );
  });

  it('says what the least it can be cut to takes and what fits with the decimals that tell them apart', () => {
    // Run with --fit-within 0.001, a seed was refused as taking "0.01 MB …
    // past the 0.01 MB that fit": both rounded up to two decimals.
    const fit = fitSeedTemplate({
      template: templateOf([object('Contact', 5000)]),
      personObjects: [],
      budget: budgetOf(KB),
      room: NO_ROOM,
    });

    expect(fit.proposal.cannotFit).toBe(
      'the least it can be cut to — one Contact and what follows it, 1 record — takes 0.002 MB, ' +
        'past the 0.001 MB that fit',
    );
  });

  it('keeps the children a relation places by key whole', () => {
    const template = templateOf(
      [object('Account', 300), object('Contact', 3, 3)],
      [under('Contact', 'Account', { mode: 'byKey' })],
    );
    const fit = fitSeedTemplate({
      template,
      personObjects: [],
      budget: budgetOf(100 * 2 * KB),
      room: NO_ROOM,
    });
    expect(fit.proposal.objects).toEqual([
      { objectApiName: 'Account', before: 300, after: 97 },
      { objectApiName: 'Contact', before: 3, after: 3, keptWhole: 'byKey' },
    ]);
  });

  it('refuses caps that leave the seed past the budget, and takes the share of what they leave when asked', () => {
    const budget = budgetOf(300 * 2 * KB);
    const caps = { objects: { Account: 100 } };

    const capped = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget,
      room: NO_ROOM,
      ask: { caps },
    });
    expect(capped.proposal.cannotFit).toBe(
      'with these caps the seed takes 3.13 MB, past the 0.59 MB that fit: lower them, or fit by share',
    );

    const both = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget,
      room: NO_ROOM,
      ask: { caps, share: true },
    });
    expect(both.proposal.cannotFit).toBeUndefined();
    expect(both.records).toBeLessThanOrEqual(300);
    expect(
      both.proposal.objects.find((o) => o.objectApiName === 'Account')?.after,
    ).toBeLessThanOrEqual(100);
  });

  it('says the requests held it when they leave less room than the storage', () => {
    // Every object past 200 records is a Bulk API job: under 200, a REST call each.
    const fit = fitSeedTemplate({
      template: SERVICE_CLOUD_STARTER,
      personObjects: [],
      budget: budgetOf(500 * BYTES_PER_MB, 9),
      room: NO_ROOM,
    });
    expect(fit.heldBy).toBe('apiRequests');
    expect(fit.requests).toBeLessThanOrEqual(9);
    const cannot = fitSeedTemplate({
      template: SERVICE_CLOUD_STARTER,
      personObjects: [],
      budget: budgetOf(500 * BYTES_PER_MB, 1),
      room: NO_ROOM,
    });
    expect(cannot.proposal.cannotFit).toMatch(
      /takes about 5 API requests, past the 1 that leave the org a tenth of its daily requests$/,
    );
    expect(cannot.heldBy).toBe('apiRequests');
  });

  it('names the requests as the bound in its proposal’s budget when they held it, the storage otherwise', () => {
    // The panel has the proposal alone, not what held it: "80 % of the 500 MB
    // the org says it has left" under a share the day's requests set was false.
    const byRequests = (runRequests: number) =>
      fitSeedTemplate({
        template: SERVICE_CLOUD_STARTER,
        personObjects: [],
        budget: budgetOf(500 * BYTES_PER_MB, runRequests),
        room: NO_ROOM,
      }).proposal.budget.limitedBy;
    expect(byRequests(9)).toBe('apiRequests');
    expect(byRequests(1)).toBe('apiRequests');
    expect(
      fitSeedTemplate({
        template: SALES_CLOUD_STARTER,
        personObjects: [],
        budget: developerEdition(),
        room: NO_ROOM,
      }).proposal.budget.limitedBy,
    ).toBe('storage');
    expect(
      fitSeedTemplate({
        template: SALES_CLOUD_STARTER,
        personObjects: [],
        budget: budgetOf(1 * KB),
        room: NO_ROOM,
      }).proposal.budget.limitedBy,
    ).toBe('storage');
  });

  it('proposes the template as it is when it fits whole', () => {
    const fit = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget: budgetOf(500 * BYTES_PER_MB),
      room: NO_ROOM,
    });
    expect(fit).toMatchObject({ heldBy: 'whole', records: 7600, proposal: { share: 1 } });
  });
});

describe('fittedTemplate', () => {
  it('gives the template the counts proposed, and leaves it as it was when nothing fits', () => {
    const fit = fitSeedTemplate({
      template: SALES_CLOUD_STARTER,
      personObjects: [],
      budget: developerEdition(),
      room: NO_ROOM,
    });
    const fitted = fittedTemplate(SALES_CLOUD_STARTER, fit.proposal);
    expect(fitted.objects.map((o) => o.recordCount)).toEqual([12, 12, 121, 242, 484, 968]);
    expect(fitted.relations).toBe(SALES_CLOUD_STARTER.relations);
    expect(fittedTemplate(SALES_CLOUD_STARTER, { ...fit.proposal, cannotFit: 'no' })).toBe(
      SALES_CLOUD_STARTER,
    );
  });
});

describe('seedAuditFitOf', () => {
  it('keeps the share, the bound asked, the records the fitted seed writes and those the template held', () => {
    expect(seedAuditFitOf({ share: 0.242, before: 7600 }, 1839)).toEqual({
      module: 'seed',
      share: 0.242,
      kept: 1839,
      inSource: 7600,
    });
    expect(seedAuditFitOf({ share: 0.5, withinMB: 3, before: 100 }, 50)).toEqual({
      module: 'seed',
      share: 0.5,
      withinMB: 3,
      kept: 50,
      inSource: 100,
    });
  });

  it('keeps nothing of a seed not fitted, nor of a fit that says the template held fewer than it writes', () => {
    expect(seedAuditFitOf(undefined, 1839)).toBeUndefined();
    expect(seedAuditFitOf({ share: 0.5, before: 10 }, 11)).toBeUndefined();
    expect(seedAuditFitOf({ share: 1, before: 11 }, 11)).toMatchObject({ kept: 11, inSource: 11 });
  });
});

/** A random template: roots, children by count under them, children of existing parents, keyed rows. */
const templates = fc
  .array(
    fc.record({
      count: fc.integer({ min: 1, max: 3000 }),
      kind: fc.constantFrom('root', 'child', 'existing', 'rows', 'byKey'),
      distribution: fc.oneof(
        fc.record({
          mode: fc.constant('perParent' as const),
          count: fc.integer({ min: 1, max: 5 }),
        }),
        fc.record({
          mode: fc.constant('range' as const),
          min: fc.integer({ min: 0, max: 2 }),
          max: fc.integer({ min: 2, max: 4 }),
        }),
        fc.record({
          mode: fc.constant('ratio' as const),
          ratio: fc.integer({ min: 1, max: 300 }).map((n) => n / 100),
        }),
      ),
      parent: fc.nat(),
    }),
    { minLength: 1, maxLength: 7 },
  )
  .map((specs) => {
    const objects: SeedObjectConfig[] = [];
    const relations: SeedRelation[] = [];
    specs.forEach((spec, i) => {
      const name = `Obj${i}__c`;
      // A child hangs under an object before it; the first has none.
      const parent = i > 0 ? `Obj${spec.parent % i}__c` : undefined;
      if (spec.kind === 'rows' || (spec.kind === 'byKey' && parent)) {
        objects.push(object(name, Math.min(spec.count, 50), Math.min(spec.count, 50)));
        if (spec.kind === 'byKey' && parent) relations.push(under(name, parent, { mode: 'byKey' }));
        return;
      }
      if (spec.kind === 'child' && parent) {
        const parentCount = objects.find((o) => o.objectApiName === parent)?.recordCount ?? 1;
        const planned = plannedChildCount(spec.distribution, parentCount);
        objects.push(object(name, Math.max(1, Math.min(planned, 100_000))));
        relations.push(under(name, parent, spec.distribution));
        return;
      }
      if (spec.kind === 'existing' && parent) {
        objects.push(object(name, spec.count));
        relations.push(under(name, parent, spec.distribution, { kind: 'existing', limit: 10 }));
        return;
      }
      objects.push(object(name, spec.count));
    });
    return templateOf(objects, relations);
  });

describe('fitSeedTemplate — properties', () => {
  it('never takes more than the budget, never raises a count, keeps rows whole, and holds each child to its parents', () => {
    fc.assert(
      fc.property(templates, fc.integer({ min: 0, max: 20 * BYTES_PER_MB }), (template, bytes) => {
        const budget = budgetOf(bytes);
        const fit = fitSeedTemplate({ template, personObjects: [], budget, room: NO_ROOM });
        const after = new Map(fit.proposal.objects.map((o) => [o.objectApiName, o.after]));
        for (const object of template.objects) {
          const kept = after.get(object.objectApiName) ?? 0;
          expect(kept).toBeGreaterThanOrEqual(1);
          expect(kept).toBeLessThanOrEqual(object.recordCount);
          if (object.rows) expect(kept).toBe(object.recordCount);
        }
        for (const relation of template.relations ?? []) {
          if (relation.parents.kind !== 'generated' || relation.distribution.mode === 'byKey')
            continue;
          const parents = after.get(relation.parentObject) ?? 0;
          expect(after.get(relation.childObject)).toBeLessThanOrEqual(
            Math.max(1, plannedChildCount(relation.distribution, parents)),
          );
        }
        if (fit.proposal.cannotFit === undefined) {
          expect(bytesAt(template, after)).toBeLessThanOrEqual(budget.bytes);
          expect(fit.proposal.share).toBeGreaterThan(0);
          expect(fit.proposal.share).toBeLessThanOrEqual(1);
          expect(fit.requests).toBe(seedRequestsEstimate(fittedTemplate(template, fit.proposal)));
        }
      }),
      { numRuns: 300 },
    );
  });
});
