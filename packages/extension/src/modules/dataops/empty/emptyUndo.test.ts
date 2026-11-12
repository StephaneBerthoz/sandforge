import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryEmptyOrg, SALES, emptySalesSpecs } from '../../../test/memoryEmptyOrg.js';
import { EmptyJournalStore, newEmptyRunId, type EmptyJournal } from './emptyJournal.js';
import { emptyPasses } from './emptyRun.js';
import { undoEmpty } from './emptyUndo.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = '00D000000000001AAA';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandforge-empty-undo-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function journalOf(
  org: MemoryEmptyOrg,
  passes: Array<{ objectApiName: string; records?: number }>,
): Promise<EmptyJournal> {
  const at = new Date(org.nowMs);
  return new EmptyJournalStore(root).begin(ORG, {
    runId: newEmptyRunId(at),
    orgName: 'dev',
    startedAt: at.toISOString(),
    readAt: at.toISOString(),
    previewId: 'ep-1',
    mode: 'objects',
    deleteMode: 'recycle',
    request: { mode: 'objects', objects: passes.map((pass) => pass.objectApiName) },
    passes,
    toDraftAlong: [],
    beforeParent: [],
  });
}

describe('undoEmpty', () => {
  it('brings back the passes in the reverse of their order: a case after the account it names', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs(), {
      // Here the case comes back with its account: the org's answer either way.
      facts: { childDeletedAloneThenParentLimbo: false },
    });
    const journal = await journalOf(org, [
      { objectApiName: 'Case', records: 1 },
      { objectApiName: 'Contact', records: 3 },
    ]);
    await emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: false });
    await journal.ended('success', [], new Date());
    const undelete = vi.spyOn(org, 'undelete');

    const outcome = await undoEmpty({ org, undelete: (ids) => org.undelete(ids), journal });

    expect(outcome.status).toBe('success');
    expect(undelete.mock.calls.map((call) => call[0][0].slice(0, 3))).toEqual(['003', '500']);
    expect(org.live('Case')).toEqual([SALES.caseOfAccount2]);
  });

  it('reads, after a stop of the process, the ids of the pass its journal left unanswered', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [{ objectApiName: 'Contact', records: 3 }]);
    // The answers of the deletes never reached the journal: the process stopped.
    vi.spyOn(journal, 'settled').mockResolvedValue();
    await emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: false });
    expect(org.live('Contact')).toEqual([]);

    const outcome = await undoEmpty({ org, undelete: (ids) => org.undelete(ids), journal });

    expect(outcome.status).toBe('success');
    expect(org.live('Contact')).toHaveLength(3);
  });

  it('counts back what a parent it brought back later took back with it', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Account', records: 2 },
      { objectApiName: 'Contact', records: 3 },
    ]);
    // The account went with its contacts; the journal names one of those
    // contacts deleted too, as a pass that read it before its account went would.
    org.memory.trash('Account', SALES.account1);
    await journal.attempt(false, new Date());
    await journal.settled('Account', [SALES.account1], []);
    await journal.settled('Contact', [SALES.contact1], []);
    await journal.ended('success', [], new Date());

    const outcome = await undoEmpty({ org, undelete: (ids) => org.undelete(ids), journal });
    const contacts = outcome.objects.find((object) => object.objectApiName === 'Contact');

    // Sent first, the contact was answered not in the bin; its account then brought it back.
    expect(contacts).toMatchObject({ undeleted: 0, alreadyBack: 1, notInBin: 0 });
    expect(outcome.status).toBe('success');
    expect(org.live('Contact')).toContain(SALES.contact1);
  });

  it('stops between two calls and says what it did not reach', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [
      { objectApiName: 'Contact', records: 3 },
      { objectApiName: 'Opportunity', records: 2 },
    ]);
    await emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: false });
    const stop = new AbortController();
    const outcome = await undoEmpty({
      org,
      undelete: async (ids) => {
        stop.abort();
        return org.undelete(ids);
      },
      journal,
      signal: stop.signal,
    });

    expect(outcome.status).toBe('cancelled');
    expect(outcome.objects.find((o) => o.objectApiName === 'Contact')?.notReached).toBe(3);
    expect(org.live('Opportunity')).toHaveLength(2);
  });

  it('counts a record no read finds, in the bin or out, as not in the bin', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const journal = await journalOf(org, [{ objectApiName: 'Contact', records: 3 }]);
    await emptyPasses({ org: { deletion: org, ids: org }, journal, resumed: false });
    org.memory.purge(SALES.contactAlone);

    const outcome = await undoEmpty({ org, undelete: (ids) => org.undelete(ids), journal });

    expect(outcome.status).toBe('partial');
    expect(outcome.objects[0]).toMatchObject({ undeleted: 2, notInBin: 1 });
    expect(outcome.objects[0].reasons[0]).toContain('nor in the org');
  });
});
