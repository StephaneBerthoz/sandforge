/**
 * What a rewind's estimate says it sends the org, against what the rewind
 * sends, on an org shaped as the one live gate G-D2 rewound.
 *
 * The gate took a checkpoint of every object of a scratch org, 204 of them,
 * seven holding records, then made an account, a contact and a case, under
 * which the org posted a feed item. The command line's preview estimated 287
 * requests; its rewind deleted the three, the feed item with them, read the
 * org again with nothing differing, and sent 155. Two parts of the figure
 * were never sent:
 *
 * - the removal's check of what depends on a record reads the relationships
 *   to an object a person works in only, where the estimate counted every
 *   one the three objects' describes list, their history, sharing rows and
 *   feed among them. The memory org's describes had listed none, and sent
 *   what was estimated;
 * - a rewind from the preview read in the same command, as the command
 *   line's is (`reusesPreview`), reads no fresh diff: the preview's own
 *   figure prices one that reads the org again, as the panel's does.
 *
 * The org is rebuilt from the figures the gate kept: 204 objects, seven of
 * them holding records, the three objects' relationships to one another, the
 * feed item's outside the checkpoint, and their history, sharing rows and
 * feed, which the org's global describe lists without a page layout. What
 * the org's automation was read with is counted as the preview counted it,
 * six requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import type { MemoryChild } from '../../test/memoryRemovalOrg.js';
import {
  COLLEAGUE,
  PREVIEWED,
  REWOUND,
  SINCE,
  STAMP_FIELDS,
  T0,
  RewindTestOrg,
  automationOf,
  clock,
  id,
  removeTaken,
  request,
  resultOf,
  spent,
  taken,
  writable,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { paced } from '../../test/runnerPace.js';
import { workedObjects } from '../dataops/RecordRemoval.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { diffEstimate, relationshipsOf, rewindEstimate } from './rewindEstimate.js';
import { rewindOrg } from './rewindOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

// ─── The org ─────────────────────────────────────────────────────────────────

/** The checkpoint's objects beside the three the gate made records of. */
const OTHERS = Array.from({ length: 201 }, (_, n) => `Object${String(n + 1).padStart(3, '0')}__c`);

/** Of them, those holding a record at the checkpoint: seven held records, an account and a case among them. */
const HELD_OTHERS = OTHERS.slice(0, 5);

/** The objects the checkpoint holds, as a checkpoint of every object held 204. */
const OBJECTS = ['Account', 'Contact', 'Case', ...OTHERS];

const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
  Case: [
    ...STAMP_FIELDS,
    writable('Subject'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    writable('ContactId', 'reference', { referenceTo: ['Contact'] }),
  ],
  // Left out of a checkpoint, as Chatter posts are: Salesforce brings a post
  // back only with what it was posted on.
  FeedItem: [
    ...STAMP_FIELDS,
    writable('Body'),
    writable('ParentId', 'reference', { referenceTo: ['Case'] }),
  ],
  ...Object.fromEntries(OTHERS.map((name) => [name, [...STAMP_FIELDS, writable('Name')]])),
};

/** An object's history, sharing rows and feed: its describe lists them, deleted along with it. */
const bookkeepingOf = (object: string, field: string): MemoryChild[] =>
  ['History', 'Share', 'Feed'].map((kind) => ({
    childSObject: `${object}${kind}`,
    field,
    cascadeDelete: true,
  }));

/**
 * An account's contacts go with it and its cases hold it; a contact's cases
 * hold it; a case's feed items go with it. Each lists its history, sharing
 * rows and feed besides.
 */
const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
    ...bookkeepingOf('Account', 'AccountId'),
  ],
  Contact: [
    { childSObject: 'Case', field: 'ContactId', restrictedDelete: true },
    ...bookkeepingOf('Contact', 'ContactId'),
  ],
  Case: [
    { childSObject: 'FeedItem', field: 'ParentId', cascadeDelete: true },
    ...bookkeepingOf('Case', 'CaseId'),
  ],
};

/** The objects no person works in that the three list, as a scratch org's global describe lists them. */
const BOOKKEEPING = Object.values(CHILDREN)
  .flat()
  .map(({ childSObject }) => childSObject)
  .filter((name) => !(name in FIELDS));

/** Requests the read of the org's automation took, as the gate's preview counted them. */
const AUTOMATION_REQUESTS = 6;

/** The org of the gate: its global describe lists the objects no one works in, with no page layout. */
class GateOrg extends RewindTestOrg {
  /** Every statement it was asked as a query of its own. */
  readonly statements: string[] = [];

  override async describeGlobal(): Promise<unknown> {
    const answer = (await super.describeGlobal()) as { sobjects: unknown[] };
    return {
      sobjects: [
        ...answer.sobjects,
        ...BOOKKEEPING.map((name) => ({
          name,
          label: name,
          queryable: true,
          createable: name.endsWith('Share'),
          updateable: false,
          deletable: false,
          layoutable: false,
        })),
      ],
    };
  }

  override async query(
    soql: string,
    options?: { scanAll?: boolean },
  ): ReturnType<RewindTestOrg['query']> {
    this.statements.push(soql);
    return super.query(soql, options);
  }
}

/**
 * The checkpoint of the gate taken, then an account, a contact and a case
 * made by a colleague, a feed item under the case, and the preview read: as
 * the panel reads it, or as a host that rewinds from it as read
 * (`reusesPreview`) does.
 */
async function gate(reusesPreview = false): Promise<{
  t: Taken & { org: GateOrg };
  preview: { diff: RewindDiff; estimate: { apiRequests: number } };
}> {
  const org = new GateOrg({ fields: FIELDS, children: CHILDREN });
  const t = await taken(
    (o) => {
      o.add('Account', { Id: id('001', 1), Name: 'Held' });
      o.add('Case', { Id: id('500', 1), Subject: 'Held one' });
      o.add('Case', { Id: id('500', 2), Subject: 'Held two' });
      HELD_OTHERS.forEach((name, n) => o.add(name, { Id: id(`a0${n}`, 1), Name: 'Held' }));
    },
    org,
    OBJECTS,
  );
  clock.now = SINCE;
  org.add('Account', { Id: id('001', 9), Name: 'Made since', LastModifiedById: COLLEAGUE });
  org.add('Contact', { Id: id('003', 9), LastName: 'Made since', LastModifiedById: COLLEAGUE });
  org.add('Case', { Id: id('500', 9), Subject: 'Made since', LastModifiedById: COLLEAGUE });
  org.add('FeedItem', { Id: id('0D5', 9), ParentId: id('500', 9), LastModifiedById: COLLEAGUE });
  clock.now = PREVIEWED;
  const preview = await previewCheckpoint(
    {
      org,
      store: t.store,
      readAutomation: automationOf({ requests: AUTOMATION_REQUESTS }),
    },
    { ...request(t), ...(reusesPreview ? { reusesPreview } : {}) },
  );
  if (!preview.previewed) throw new Error(preview.refusal.message);
  return { t: { ...t, org }, preview };
}

/** The rewind of the gate, from a fresh read of the org or from the preview as read. */
async function rewind(
  t: Taken & { org: GateOrg },
  diff: RewindDiff,
  reuses: boolean,
): Promise<ReturnType<typeof resultOf>> {
  clock.now = Math.max(clock.now, REWOUND);
  t.org.ticking = true;
  const read = await t.store.read(t.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  try {
    return resultOf(
      await rewindOrg(
        {
          org: t.org,
          undelete: (ids) => t.org.undelete(ids),
          store: t.store,
          readAutomation: automationOf({ requests: AUTOMATION_REQUESTS }),
        },
        {
          ...request(t),
          checkpoint: read.checkpoint,
          previewId: diff.previewId,
          ...(reuses ? { reusesPreview: diff } : {}),
          acceptAutomation: false,
          acceptNoUndo: false,
          acceptRecreate: false,
          // The gate's checkpoint held every object, whose rewind deletes what
          // hangs from what it deletes: one of picked objects, once accepted.
          acceptOutside: true,
          acceptUnseen: false,
        },
      ),
    );
  } finally {
    t.org.ticking = false;
  }
}

/** What the gate's rewind left: the three records and the feed item in the recycle bin. */
function expectRewound(t: Taken & { org: GateOrg }, result: ReturnType<typeof resultOf>): void {
  expect(result.status).toBe('success');
  expect(result.passes).toBe(1);
  expect(
    result.deleted.map(({ objectApiName, deleted }) => [objectApiName, deleted]).sort(),
  ).toEqual([
    ['Account', 1],
    ['Case', 1],
    ['Contact', 1],
  ]);
  expect(t.org.all('FeedItem')).toEqual([]);
  expect(t.org.inBin('FeedItem').map((row) => row.Id)).toEqual([id('0D5', 9)]);
}

// ─── What it sends ───────────────────────────────────────────────────────────

describe('what a rewind sends against its estimate, on the org of gate G-D2', () => {
  it(
    'sends what its preview estimated when it reads the org again, as the panel’s rewind does, reading none of the relationships to an object no person works in',
    async () => {
      const { t, preview } = await gate();
      expect(preview.diff.objects.map(({ objectApiName }) => objectApiName).sort()).toEqual([
        'Account',
        'Case',
        'Contact',
      ]);
      expect(preview.diff.described).toEqual({ first: 3, later: 0 });
      const asked = spent(t.org);
      const from = t.org.statements.length;

      const result = await rewind(t, preview.diff, false);

      expectRewound(t, result);
      // The automation is read through the host's own reader, never the org.
      expect(result.apiRequests.used).toBe(spent(t.org) - asked + AUTOMATION_REQUESTS);
      expect(result.apiRequests.used).toBe(preview.estimate.apiRequests);
      const kept = t.org.statements
        .slice(from)
        .filter((soql) => BOOKKEEPING.some((name) => soql.includes(` FROM ${name} `)));
      expect(kept).toEqual([]);
    },
    paced(60_000),
  );

  it(
    'sends what the estimate of a rewind from the preview it acts on counts, as the command line’s does: no fresh read, which the preview’s own figure prices',
    async () => {
      const { t, preview } = await gate();
      const inCheckpoint = new Set(OBJECTS.map((name) => name.toLowerCase()));
      const worked = new Set((await workedObjects(t.org)).keys());
      const relationships = new Map(
        await Promise.all(
          ['Account', 'Contact', 'Case'].map(
            async (name) =>
              [
                name,
                relationshipsOf(await t.org.describe(name), { inCheckpoint, worked }),
              ] as const,
          ),
        ),
      );
      const input = {
        objects: t.checkpoint.objects,
        diff: preview.diff,
        automationRequests: AUTOMATION_REQUESTS,
        relationships,
      };
      const estimate = rewindEstimate({ ...input, reusesPreview: true });
      const asked = spent(t.org);

      const result = await rewind(t, preview.diff, true);

      expectRewound(t, result);
      expect(result.apiRequests.used).toBe(spent(t.org) - asked + AUTOMATION_REQUESTS);
      expect(result.apiRequests.used).toBe(estimate.apiRequests);
      expect(preview.estimate.apiRequests - result.apiRequests.used).toBe(
        diffEstimate(input).apiRequests,
      );
    },
    paced(60_000),
  );

  it(
    'says in the preview of a rewind that acts on it as read what that rewind sends, as the command line and a pipeline’s Rewind step rewind: the gate’s preview counted a fresh read the command line never made',
    async () => {
      const { t, preview } = await gate(true);
      const asked = spent(t.org);

      const result = await rewind(t, preview.diff, true);

      expectRewound(t, result);
      expect(result.apiRequests.used).toBe(spent(t.org) - asked + AUTOMATION_REQUESTS);
      expect(result.apiRequests.used).toBe(preview.estimate.apiRequests);
    },
    paced(60_000),
  );
});
