import { describe, expect, it } from 'vitest';
import type { ForgeSweepResult } from '@sandforge/shared';

import { removalOrg } from '../../modules/forge/ForgeRunRemoval.js';
import { LATE_WITHIN_MS } from '../../modules/forge/sweepTies.js';
import type { SweepInput } from '../../modules/forge/ForgeRunSweep.js';
import type { SyncRunKept } from '../../modules/sync/SyncRunCreations.js';
import { tiedTargetOrg, type TiedRow } from '../../test/tiedTargetOrg.js';
import {
  keptRunOf,
  OTHER_RUN_LEEWAY_MS,
  otherRunsInSweep,
  removalBeganOf,
  removalSweepOf,
  sweepOrgOf,
  sweepRefusalCode,
  withoutPlatformCopies,
  type RemovalSweepRequest,
} from './removalSweep.js';

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const USER = id('005', 1);
const CONTACT = id('003', 1);
const TASK = id('00T', 1);
const FIRST_WRITE = '2026-10-15T09:00:00.000Z';
const LAST_WRITE = '2026-10-15T09:05:00.000Z';
const DURING = '2026-10-15T09:04:58.000+0000';

const rec = (recordId: string, by: string, created: string, lookups = {}): TiedRow => ({
  Id: recordId,
  Name: recordId,
  CreatedById: by,
  CreatedDate: created,
  LastModifiedDate: created,
  LastModifiedById: by,
  SystemModstamp: created,
  ...lookups,
});

/** The target after a run that created a contact, and the task its flow opened on it. */
function orgAfterRun() {
  const org = tiedTargetOrg(USER);
  org.shape('Contact', { children: [{ childSObject: 'Task', field: 'WhoId' }] });
  org.shape('Task', { references: { WhoId: ['Contact'] } });
  org.add('Contact', rec(CONTACT, USER, DURING));
  org.add('Task', rec(TASK, USER, DURING, { WhoId: CONTACT }));
  return org;
}

const INPUT: SweepInput = {
  writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
  created: [{ objectApiName: 'Contact', ids: [CONTACT] }],
  remap: new Set([CONTACT.slice(0, 15)]),
  automation: { creates: [] },
  runUserId: USER,
  ties: {},
};

function requestOf(
  org: ReturnType<typeof orgAfterRun>,
  overrides: Partial<RemovalSweepRequest> = {},
): RemovalSweepRequest & {
  recorded: Array<[ForgeSweepResult, string | undefined]>;
  kept: Array<ReadonlySet<string>>;
} {
  const recorded: Array<[ForgeSweepResult, string | undefined]> = [];
  const kept: Array<ReadonlySet<string>> = [];
  return {
    input: async () => INPUT,
    org: sweepOrgOf(org.conn as never, 'test'),
    options: { includeChanged: false, removalSpans: [] },
    guard: {
      check: () => ({
        allowed: true,
        requiresConfirmation: false,
        warnings: [],
        impactSummary: '',
      }),
      confirmIfNeeded: async () => true,
    } as never,
    guardOf: { orgId: 'org-1', orgTier: 'development', operation: 'delete', module: 'forge' },
    onGuardDecision: (result, guard) => {
      recorded.push([result, guard]);
    },
    keepMade: async (made) => {
      kept.push(made);
    },
    ...overrides,
    recorded,
    kept,
  };
}

describe('removalSweepOf', () => {
  it('deletes through its parts, then records once what it did and keeps what it found made', async () => {
    const org = orgAfterRun();
    const request = requestOf(org);
    const sweep = await removalSweepOf(request);

    expect(await sweep.first()).toBe(true);
    expect(org.ids('Task')).toEqual([]);
    expect([...sweep.automationMade]).toEqual([TASK]);
    await sweep.afterRemoval();

    const result = await sweep.settle();
    await sweep.settle();

    expect(result.status).toBe('success');
    expect(request.recorded).toHaveLength(1);
    expect(request.recorded[0][1]).toBe('allowed');
    expect(request.kept).toHaveLength(1);
    expect([...request.kept[0]]).toEqual([TASK]);
  });

  it('deletes nothing, and says why, for a run whose input was refused', async () => {
    const org = orgAfterRun();
    const request = requestOf(org, { input: async () => ({ refused: 'The journal is gone.' }) });
    const sweep = await removalSweepOf(request);

    expect(await sweep.first()).toBe(false);
    expect(await sweep.afterRemoval()).toBe(false);

    expect(await sweep.settle()).toMatchObject({
      status: 'refused',
      refusal: 'The journal is gone.',
    });
    expect(org.deletes).toEqual([]);
    expect(request.kept).toEqual([]);
  });

  it('ends in failure, and the removal goes on, when reading what it is told throws', async () => {
    const org = orgAfterRun();
    const sweep = await removalSweepOf(
      requestOf(org, {
        input: async () => {
          throw new Error('the org did not answer');
        },
      }),
    );

    expect(await sweep.first()).toBe(false);
    expect(await sweep.settle()).toMatchObject({
      status: 'failure',
      refusal: 'the org did not answer',
    });
  });

  it('ends in failure, and the removal goes on, when one of its parts throws', async () => {
    const org = orgAfterRun();
    const request = requestOf(org, {
      guard: {
        check: () => {
          throw new Error('the guard broke');
        },
        confirmIfNeeded: async () => true,
      } as never,
    });
    const sweep = await removalSweepOf(request);

    expect(await sweep.first()).toBe(false);
    expect(await sweep.afterRemoval()).toBe(false);

    expect(await sweep.settle()).toMatchObject({ status: 'failure', refusal: 'the guard broke' });
    expect(org.deletes).toEqual([]);
    expect(request.recorded).toHaveLength(1);
  });

  it('stops at Production Guard’s refusal, deleting nothing, and records the decision', async () => {
    const org = orgAfterRun();
    const request = requestOf(org, {
      guard: {
        check: () => ({
          allowed: false,
          requiresConfirmation: false,
          blockedReason: 'a production org',
          warnings: [],
          impactSummary: '',
        }),
        confirmIfNeeded: async () => false,
      } as never,
    });
    const sweep = await removalSweepOf(request);

    await sweep.first();
    const result = await sweep.settle();

    expect(result).toMatchObject({
      status: 'refused',
      refusal: 'Operation blocked by Production Guard: a production org',
    });
    expect(org.deletes).toEqual([]);
    expect(request.recorded[0][1]).toBe('refused');
    expect(sweepRefusalCode(request.recorded[0][1] as never)).toBe('GUARD_BLOCKED');
    expect(sweepRefusalCode(undefined)).toBe('SWEEP_REFUSED');
  });
});

describe('sweepOrgOf', () => {
  it('sends the counts of a sweep to a composite, and the rest of its calls as a removal does', async () => {
    const org = orgAfterRun();
    const swept = sweepOrgOf(org.conn as never, 'test');

    await expect(
      swept.counts?.(["SELECT COUNT() FROM Task WHERE WhoId IN ('" + CONTACT + "')"]),
    ).resolves.toEqual([1]);
    expect(org.composites).toEqual([1]);
    expect(Object.keys(swept)).toEqual(
      expect.arrayContaining(Object.keys(removalOrg(org.conn as never, 'test'))),
    );
  });
});

describe('withoutPlatformCopies', () => {
  const OPPORTUNITY = id('006', 1);
  const QUOTE = id('0Q0', 1);
  const LINE_ITEM = id('00k', 1);
  const RUN_LINE = id('0QL', 1);
  const COPY = id('0QL', 2);
  const COLLEAGUES_LINE = id('0QL', 3);

  /** The target after a run that synced its quote: the platform copied its line item onto it. */
  function syncedOrg() {
    const org = tiedTargetOrg(USER);
    org.shape('Opportunity', { references: { SyncedQuoteId: ['Quote'] } });
    org.shape('Quote', { references: { OpportunityId: ['Opportunity'] } });
    org.shape('OpportunityLineItem', { references: { OpportunityId: ['Opportunity'] } });
    org.shape('QuoteLineItem', {
      references: { QuoteId: ['Quote'], OpportunityLineItemId: ['OpportunityLineItem'] },
    });
    org.add('Opportunity', rec(OPPORTUNITY, USER, DURING, { SyncedQuoteId: QUOTE }));
    org.add('Quote', rec(QUOTE, USER, DURING, { OpportunityId: OPPORTUNITY }));
    org.add('OpportunityLineItem', rec(LINE_ITEM, USER, DURING, { OpportunityId: OPPORTUNITY }));
    const line = { QuoteId: QUOTE, OpportunityLineItemId: LINE_ITEM };
    org.add(
      'QuoteLineItem',
      rec(RUN_LINE, USER, DURING, line),
      rec(COPY, USER, DURING, line),
      rec(COLLEAGUES_LINE, id('005', 2), DURING, line),
    );
    return org;
  }

  const synced: SweepInput = {
    ...INPUT,
    created: [
      { objectApiName: 'Opportunity', ids: [OPPORTUNITY] },
      { objectApiName: 'Quote', ids: [QUOTE] },
      { objectApiName: 'OpportunityLineItem', ids: [LINE_ITEM] },
      { objectApiName: 'QuoteLineItem', ids: [RUN_LINE] },
    ],
    remap: new Set([OPPORTUNITY, QUOTE, LINE_ITEM, RUN_LINE].map((key) => key.slice(0, 15))),
  };

  it('leaves the platform’s copies to the removal, and a colleague’s line to the sweep’s rules', async () => {
    const org = syncedOrg();

    const told = await withoutPlatformCopies(synced, removalOrg(org.conn as never, 'test'));

    expect(told.remap.has(COPY.slice(0, 15))).toBe(true);
    expect(told.remap.has(RUN_LINE.slice(0, 15))).toBe(true);
    expect(told.remap.has(COLLEAGUES_LINE.slice(0, 15))).toBe(false);
  });

  it('reads nothing for a run that synced no quote of its own, or the target did not date', async () => {
    const org = syncedOrg();

    expect(await withoutPlatformCopies(INPUT, removalOrg(org.conn as never, 'test'))).toBe(INPUT);
    const undated = { ...synced, writtenBetween: undefined };
    expect(await withoutPlatformCopies(undated, removalOrg(org.conn as never, 'test'))).toBe(
      undated,
    );
    expect(org.queries).toEqual([]);
  });
});

describe('otherRunsInSweep', () => {
  const written = { first: FIRST_WRITE, last: LAST_WRITE };
  const first = Date.parse(FIRST_WRITE);
  const last = Date.parse(LAST_WRITE);

  it('names the runs that wrote while the run did, or in the span after it read for what came late', () => {
    const during = { ids: ['a'], from: first + 1_000, to: first + 2_000 };
    const late = { ids: ['b'], from: last + LATE_WITHIN_MS - 1_000, to: last + LATE_WITHIN_MS };

    expect(otherRunsInSweep(written, [during, late])).toEqual([{ ids: ['a'] }, { ids: ['b'] }]);
  });

  it('leaves out the runs that wrote well before or after, and leaves room for this machine’s clock', () => {
    const before = { ids: ['a'], from: first - 3_600_000, to: first - 3_500_000 };
    const after = {
      ids: ['b'],
      from: last + LATE_WITHIN_MS + OTHER_RUN_LEEWAY_MS + 1_000,
      to: last + LATE_WITHIN_MS + OTHER_RUN_LEEWAY_MS + 2_000,
    };
    const close = { ids: ['c'], from: first - 30_000, to: first - 20_000 };

    expect(otherRunsInSweep(written, [before, after, close])).toEqual([{ ids: ['c'] }]);
  });

  it('counts no run with no record or no date, and none of a run the target did not date', () => {
    const empty = { ids: [], from: first, to: last };
    const undated = { ids: ['a'], from: Number.NaN, to: Number.NaN };

    expect(otherRunsInSweep(written, [empty, undated])).toEqual([]);
    expect(otherRunsInSweep(undefined, [{ ids: ['a'], from: first, to: last }])).toEqual([]);
  });
});

describe('removalBeganOf', () => {
  it('gives the earliest removal that wrote, past a date that does not read', () => {
    expect(
      removalBeganOf([
        { first: '2026-10-16T10:00:00.000Z' },
        { first: 'not a date' },
        { first: '2026-10-15T10:00:00.000Z' },
      ]),
    ).toBe('2026-10-15T10:00:00.000Z');
    expect(removalBeganOf([])).toBeUndefined();
    expect(removalBeganOf(undefined)).toBeUndefined();
  });
});

describe('keptRunOf', () => {
  const kept = (over: Partial<SyncRunKept>): SyncRunKept =>
    ({ runId: 'r', startedAt: FIRST_WRITE, created: [], ...over }) as SyncRunKept;

  it('names what a run created and wrote over, from its first write to its last', () => {
    expect(
      keptRunOf(
        kept({
          firstWrittenAt: FIRST_WRITE,
          lastWriteAt: LAST_WRITE,
          created: [{ objectApiName: 'Contact', ids: ['a'] }],
          overwritten: [{ objectApiName: 'Account', ids: ['b'] }] as SyncRunKept['overwritten'],
        }),
      ),
    ).toEqual({ ids: ['a', 'b'], from: Date.parse(FIRST_WRITE), to: Date.parse(LAST_WRITE) });
  });

  it('falls back on when the run began and ended, and on its start for a run that never ended', () => {
    expect(keptRunOf(kept({ end: { at: LAST_WRITE, status: 'success' } }))).toMatchObject({
      from: Date.parse(FIRST_WRITE),
      to: Date.parse(LAST_WRITE),
    });
    expect(keptRunOf(kept({}))).toMatchObject({
      from: Date.parse(FIRST_WRITE),
      to: Date.parse(FIRST_WRITE),
    });
  });
});
