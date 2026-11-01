import { describe, it, expect, vi } from 'vitest';
import { previewSyncRun, removeSyncRun } from './SyncRunRemoval';
import type { SyncRunKept, SyncRunRemovalState } from './SyncRunCreations';
import { MEMORY_ORG_USER, MemoryRemovalOrg } from '../../test/memoryRemovalOrg';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The preview of a run's removal reads the run as its removal reads it: the
 * span it wrote in, what its earlier removals stamped on its records and when
 * they ran. Read any other way, the preview would count as changed since the
 * run what the removal then deletes, or the other way round.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const A1 = fakeId('001', 1);
const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);

/** Minutes before now, as the org dates a record. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A seed ten minutes ago that created an account and two contacts under it. */
function run(removal?: SyncRunRemovalState): SyncRunKept {
  return {
    runId: 'env-demo-accounts-1',
    configId: 'sandforge-seed',
    configName: 'sandforge-seed',
    sourceOrgId: 'TGT',
    targetOrgId: 'TGT',
    startedAt: minutesAgo(11),
    lastWrittenAt: minutesAgo(10),
    end: { at: minutesAgo(10), status: 'success' },
    created: [
      { objectApiName: 'Account', ids: [A1] },
      { objectApiName: 'Contact', ids: [C1, C2] },
    ],
    ...(removal ? { removal } : {}),
  };
}

/** The target as the run left it, a contact stamped five minutes ago by an earlier removal. */
function target(): { org: MemoryRemovalOrg; stamped: string } {
  const org = new MemoryRemovalOrg({
    Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }],
  });
  const at = minutesAgo(10);
  org.add('Account', { Id: A1 }, at);
  org.add('Contact', { Id: C1, AccountId: A1 }, at);
  org.add('Contact', { Id: C2, AccountId: A1 }, at);
  const stamped = minutesAgo(5);
  org.touch('Contact', C2, stamped);
  return { org, stamped };
}

describe('previewSyncRun', () => {
  it('reads a record an earlier removal stamped as no change since the run, as the removal reads it', async () => {
    const { org, stamped } = target();
    const earlier: SyncRunRemovalState = {
      removalStamps: { [C2]: stamped },
      removalSpans: [{ first: minutesAgo(6), last: minutesAgo(4), userId: MEMORY_ORG_USER }],
    };

    const previewed = await previewSyncRun({ run: run(earlier), org, includeChanged: false });

    expect(previewed.planned).toBe(3);
    expect(previewed.outcome.preview?.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', toDelete: 2, changedSince: 0 }),
      expect.objectContaining({ objectApiName: 'Account', toDelete: 1 }),
    ]);
    expect(org.deletes).toEqual([]);

    // The removal of the same run deletes what the preview said it would.
    let kept: SyncRunRemovalState = {};
    const removed = await removeSyncRun({
      run: run(earlier),
      org,
      includeChanged: false,
      store: {
        updateRemoval: async (_runId, change) => {
          kept = change(kept);
        },
      },
    });
    expect(removed.result.objects.map((o) => [o.objectApiName, o.deleted])).toEqual([
      ['Contact', 2],
      ['Account', 1],
    ]);
  });

  it('reads the same record as changed since the run when no earlier removal stamped it', async () => {
    const { org } = target();

    const previewed = await previewSyncRun({ run: run(), org, includeChanged: false });

    expect(previewed.outcome.preview?.objects[0]).toMatchObject({
      objectApiName: 'Contact',
      toDelete: 1,
      keptChanged: 1,
    });
  });

  it('names the quote lines the platform copied as the run wrote, held to the run user it is handed', async () => {
    // The run wrote the source's creator on its line item, as a run that
    // may set audit fields does: only the user it kept tells the copy.
    const opportunity = fakeId('006', 1);
    const quote = fakeId('0Q0', 1);
    const lineItem = fakeId('00k', 1);
    const quoteLine = fakeId('0QL', 1);
    const copy = fakeId('0QL', 2);
    const org = new MemoryRemovalOrg({
      Quote: [{ childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true }],
    });
    const at = minutesAgo(10);
    org.add('Opportunity', { Id: opportunity, SyncedQuoteId: quote }, at);
    org.add('Quote', { Id: quote, OpportunityId: opportunity }, at);
    org.add(
      'OpportunityLineItem',
      { Id: lineItem, OpportunityId: opportunity, CreatedById: fakeId('005', 9) },
      at,
    );
    for (const line of [quoteLine, copy]) {
      org.add(
        'QuoteLineItem',
        { Id: line, QuoteId: quote, OpportunityLineItemId: lineItem, CreatedById: MEMORY_ORG_USER },
        at,
      );
    }
    const quoteRun: SyncRunKept = {
      ...run(),
      created: [
        { objectApiName: 'QuoteLineItem', ids: [quoteLine] },
        { objectApiName: 'OpportunityLineItem', ids: [lineItem] },
        { objectApiName: 'Quote', ids: [quote] },
        { objectApiName: 'Opportunity', ids: [opportunity] },
      ],
    };

    const handed = await previewSyncRun({
      run: quoteRun,
      org,
      includeChanged: false,
      runUserId: MEMORY_ORG_USER,
    });
    const notHanded = await previewSyncRun({ run: quoteRun, org, includeChanged: false });

    const lines = (outcome: typeof handed.outcome) =>
      outcome.preview?.objects.find((object) => object.objectApiName === 'QuoteLineItem');
    expect(lines(handed.outcome)).toMatchObject({ planned: 2, platformCopies: 1, toDelete: 2 });
    expect(lines(notHanded.outcome)).toMatchObject({ planned: 1, toDelete: 1 });
    expect(lines(notHanded.outcome)?.platformCopies).toBeUndefined();
    expect(org.deletes).toEqual([]);
  });

  it('writes nothing to where the run’s removals are kept: it is handed no such place', async () => {
    const { org } = target();
    const destroy = vi.spyOn(org, 'destroy');

    const previewed = await previewSyncRun({ run: run(), org, includeChanged: true });

    expect(destroy).not.toHaveBeenCalled();
    expect(previewed.outcome.preview?.objects[0]).toMatchObject({ toDelete: 2, changedSince: 1 });
  });
});
