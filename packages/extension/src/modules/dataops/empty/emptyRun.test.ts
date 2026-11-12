import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryEmptyOrg, SALES, emptySalesSpecs } from '../../../test/memoryEmptyOrg.js';
import { EmptyJournalStore, newEmptyRunId, type EmptyJournal } from './emptyJournal.js';
import { emptyPasses, emptyStatusOf, madeBeforeCondition } from './emptyRun.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = '00D000000000001AAA';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandforge-empty-run-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A run's journal on `org`'s clock, of `passes`, as a preview would have confirmed them. */
async function journalOf(
  org: MemoryEmptyOrg,
  passes: Array<{ objectApiName: string; records?: number; sent?: number }>,
  deleteMode: 'recycle' | 'hard' = 'recycle',
  toDraftAlong: Array<{ objectApiName: string; condition?: string }> = [],
): Promise<EmptyJournal> {
  const at = new Date(org.nowMs);
  return new EmptyJournalStore(root).begin(ORG, {
    runId: newEmptyRunId(at),
    orgName: 'dev',
    startedAt: at.toISOString(),
    readAt: at.toISOString(),
    previewId: 'ep-1',
    mode: 'objects',
    deleteMode,
    request: { mode: 'objects', objects: passes.map((pass) => pass.objectApiName) },
    passes,
    toDraftAlong,
    beforeParent: [],
  });
}

describe('emptyPasses', () => {
  it('reads each pass at its turn, writes its ids and every answer to the journal', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(
      org,
      [
        { objectApiName: 'Case', records: 1 },
        { objectApiName: 'Account', records: 2 },
        { objectApiName: 'Contact', records: 3, sent: 1 },
      ],
      'recycle',
      [{ objectApiName: 'Order', condition: 'AccountId != null' }],
    );
    const outcome = await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
    });

    expect(outcome.status).toBe('success');
    expect(outcome.passes.map((pass) => [pass.objectApiName, pass.planned, pass.deleted])).toEqual([
      ['Case', 1, 1],
      ['Account', 2, 2],
      ['Contact', 1, 1],
    ]);
    const kinds: string[] = [];
    for await (const line of journal.lines()) kinds.push(line.kind);
    expect(kinds).toEqual([
      'head',
      'attempt',
      'spooled',
      'settled',
      'spooled',
      'settled',
      'spooled',
      'settled',
    ]);
  });

  it('leaves an account its activated order refuses, when the orders going along are not set back to Draft', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Case', records: 1 },
      { objectApiName: 'Account', records: 2 },
    ]);
    const outcome = await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
    });

    expect(outcome.status).toBe('partial');
    expect(org.live('Account')).toEqual([SALES.account1]);
    expect(outcome.passes[1].reasons.join(' ')).toContain('active orders');
  });

  it('never reads the standard price book, nor what was made after the preview', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [{ objectApiName: 'Pricebook2', records: 1 }]);
    org.advance(2_000);
    org.addNow('Pricebook2', { Id: '01s000000000009AAA', IsStandard: false });
    const query = vi.spyOn(org, 'query');
    // The order of the custom book names it: blocked, refused.
    await emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: false });

    expect(query.mock.calls[0][0]).toMatch(
      /^SELECT Id FROM Pricebook2 WHERE \(\(IsStandard = false\) AND \(CreatedDate < 2026-11-12T10:00:00Z\)\)$/,
    );
    expect(org.live('Pricebook2')).toContain(SALES.standardBook);
    expect(org.live('Pricebook2')).toContain('01s000000000009AAA');
  });

  it('reads whole, and says so, an object whose records have no CreatedDate', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    org.memory.missingFields.set('Contact', new Set(['CreatedDate']));
    const journal = await journalOf(org, [{ objectApiName: 'Contact', records: 3 }]);
    const outcome = await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
    });

    expect(outcome.status).toBe('success');
    expect(outcome.notes[0]).toMatch(/^Contact has no CreatedDate: its records were read whole/);
    expect(org.live('Contact')).toEqual([]);
  });

  it('stops before deleting a record of a pass that reads more than the preview counted', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Case', records: 1 },
      { objectApiName: 'Contact', records: 2 },
    ]);
    const outcome = await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
    });

    expect(outcome.changed?.code).toBe('ORG_CHANGED');
    expect(outcome.changed?.message).toContain('Contact now holds 3 records to delete');
    expect(outcome.status).toBe('partial');
    expect(org.live('Contact')).toHaveLength(3);
  });

  it('stops when the journal cannot be written, so that its Undo misses nothing', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Contact', records: 3 },
      { objectApiName: 'Opportunity', records: 2 },
    ]);
    vi.spyOn(journal, 'settled').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    const outcome = await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
    });

    expect(outcome.notes.join(' ')).toContain('ENOSPC');
    expect(org.live('Opportunity')).toHaveLength(2);
  });

  it('refuses to take up a pass whose ids are no longer as they were written, and says the emptying set out to act on them', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Contact', records: 3 },
      { objectApiName: 'Opportunity', records: 2 },
    ]);
    const stop = new AbortController();
    org.beforeDelete = (_via, objectApiName) => {
      if (objectApiName === 'Opportunity') stop.abort();
    };
    await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
      signal: stop.signal,
    });
    await journal.ended('cancelled', [], new Date());
    org.beforeDelete = undefined;
    writeFileSync(join(journal.idsDirOf(1, 'Opportunity'), 'Opportunity.ids'), 'not an id\n');

    await expect(
      emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: true }),
    ).rejects.toThrow(
      'The Opportunity records an emptying sets out to act on are not as they were written.',
    );
  });

  it('takes up a stopped run without sending again what the journal names settled', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Contact', records: 3 },
      { objectApiName: 'Opportunity', records: 2 },
    ]);
    const stop = new AbortController();
    org.beforeDelete = (_via, objectApiName) => {
      if (objectApiName === 'Opportunity') stop.abort();
    };
    const first = await emptyPasses({
      org: { deletion: org, ids: org },
      journal,
      resumed: false,
      signal: stop.signal,
    });
    expect(first.status).toBe('cancelled');
    expect(org.live('Contact')).toEqual([]);
    await journal.ended('cancelled', first.passes, new Date());

    org.beforeDelete = undefined;
    const sentBefore = org.sent.length;
    const second = await emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: true });

    expect(second.status).toBe('success');
    expect(org.live('Opportunity')).toEqual([]);
    const resent = org.sent.slice(sentBefore).flatMap((sent) => sent.ids);
    expect(resent.filter((id) => id.startsWith('003'))).toEqual([]);
  });
});

describe('madeBeforeCondition and emptyStatusOf', () => {
  it('leaves out what was made in the second of the preview, and after it', () => {
    expect(madeBeforeCondition('2026-11-12T10:00:00.731Z')).toBe(
      'CreatedDate < 2026-11-12T10:00:00Z',
    );
    expect(() => madeBeforeCondition('yesterday')).toThrow(RangeError);
  });

  it('says partial when some records stay, failure when none went, cancelled when stopped', () => {
    const pass = {
      objectApiName: 'Account',
      planned: 2,
      deleted: 0,
      gone: 0,
      refused: 0,
      reasons: [],
    };
    expect(emptyStatusOf([{ ...pass, deleted: 2 }], false, undefined)).toBe('success');
    expect(emptyStatusOf([{ ...pass, deleted: 1, refused: 1 }], false, undefined)).toBe('partial');
    expect(emptyStatusOf([{ ...pass, refused: 2 }], false, undefined)).toBe('failure');
    expect(emptyStatusOf([{ ...pass, deleted: 1, notReached: 1 }], true, undefined)).toBe(
      'cancelled',
    );
    expect(emptyStatusOf([pass], true, 'FEATURENOTENABLED')).toBe('failure');
  });
});
