import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ForgeUndoObjectResult } from '@sandforge/shared';
import { nodeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';
import type { RemovalPreviewObject } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  laterPartsOf,
  machineSpanOf,
  mergedPreviewObjects,
  mergedUndoObjects,
  runPartsOf,
  spansOf,
  stillLeft,
  type RunPart,
} from './cloneRunParts';

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const at = (time: string): string => `2026-10-01T${time}.000Z`;

describe('the parts of a run cut and taken up, read from its journal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clone-run-parts-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function journal(lines: unknown[]): string {
    const path = join(dir, 'run.ndjson');
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
    return path;
  }

  it('says what each part created, linked to, wrote beyond its records, and when it ran', async () => {
    const path = journal([
      { run: { journalId: 'run', targetOrgId: '00D000000000002AAA', startedAt: at('10:00:00') } },
      { part: { n: 0, startedAt: at('10:00:00') } },
      ['x', '0.1', 'Opportunity', at('10:00:02'), ['Name'], [[id('006', 1), 'f']], []],
      ['c', id('006', 1), id('006', 901), 'Opportunity'],
      ['a', '0.1'],
      { end: { status: 'cancelled', forgeId: 'run#0', at: at('10:00:05') } },
      { part: { n: 1, startedAt: at('10:02:00') } },
      ['e', id('01s', 1), id('01s', 901), ''],
      ['x', '1.1', 'Quote', at('10:02:01'), ['Name'], [[id('0Q0', 1), 'f']], []],
      ['c', id('0Q0', 1), id('0Q0', 901), 'Quote'],
      ['a', '1.1'],
      ['p', id('006', 901), 'SyncedQuoteId'],
      ['e', id('00K', 1), id('00K', 901), 'OpportunityContactRole'],
      ['g', 'Order', id('801', 901)],
      'not a line the journal writes',
      ['x', '1.2', 'OpportunityLineItem', at('10:02:03'), ['Name'], [[id('00k', 1), 'f']], []],
    ]);

    const parts = await runPartsOf(path, nodeRunJournal(dir));

    expect(parts).toEqual([
      {
        part: 0,
        created: [{ objectApiName: 'Opportunity', ids: [id('006', 901)] }],
        linked: [],
        wrote: [],
        startedAt: at('10:00:00'),
        endedAt: at('10:00:05'),
      },
      {
        part: 1,
        created: [{ objectApiName: 'Quote', ids: [id('0Q0', 901)] }],
        // The standard price book, matched, names no object: not the run's to read.
        linked: [id('00K', 901)],
        wrote: [id('006', 901), id('801', 901)],
        startedAt: at('10:02:00'),
        // A part killed as it wrote: its last call.
        endedAt: at('10:02:03'),
      },
    ]);
  });

  it('ends a part killed once its Bulk API job was closed no earlier than the job, read back since', async () => {
    // Killed as the org said the job closed; the job wrote its cases for 30
    // seconds more, and the resume kept when it ended, on the org's clock
    // and on this machine's, before its own part began.
    const path = journal([
      { run: { journalId: 'run', targetOrgId: '00D000000000002AAA', startedAt: at('16:05:15') } },
      { part: { n: 0, startedAt: at('16:05:15') } },
      ['c', id('001', 1), id('001', 901), 'Account'],
      ['x', '0.6', 'Case', at('16:07:00'), ['Status'], [[id('500', 1), 'f', '', 'k']], []],
      ['j', '0.6', '750000000000001AAA'],
      ['d', '0.6', '750000000000001AAA', '2026-11-13T16:07:33.000Z', at('16:07:31')],
      ['c', id('500', 1), id('500', 901), 'Case', 'found-owed'],
      ['a', '0.6'],
      { part: { n: 1, startedAt: at('16:20:00') } },
    ]);

    const [cut] = await runPartsOf(path, nodeRunJournal(dir));

    expect(cut).toMatchObject({ part: 0, startedAt: at('16:05:15'), endedAt: at('16:07:31') });
    expect(machineSpanOf(cut)).toMatchObject({ runRecordedAt: new Date(at('16:07:31')) });
  });

  it('reads no parts of a journal that is not there, or not a run', async () => {
    expect(await runPartsOf(join(dir, 'none.ndjson'), nodeRunJournal(dir))).toEqual([]);
    expect(await runPartsOf(journal([{ not: 'a run' }]), nodeRunJournal(dir))).toEqual([]);
  });
});

describe('what a removal of one part is handed of the others', () => {
  const part = (n: number, fields: Partial<RunPart> = {}): RunPart => ({
    part: n,
    created: [],
    linked: [],
    wrote: [],
    startedAt: at(`10:0${n * 2}:00`),
    endedAt: at(`10:0${n * 2}:05`),
    ...fields,
  });

  it('dates a part by its lines, on this machine clock, for its removal to end it with its last write as the org dated it', () => {
    expect(machineSpanOf(part(1))).toEqual({
      runRecordedAt: new Date(at('10:02:05')),
      runDurationMs: 5_000,
      endedByItsWrites: true,
    });
    expect(machineSpanOf(part(1, { endedAt: undefined }))).toBeUndefined();
  });

  it('names the later parts that wrote to or linked records, and none before', () => {
    const parts = [
      part(0, { wrote: [id('006', 1)] }),
      part(1, { wrote: [id('006', 2)], linked: [id('00K', 2)] }),
      part(2),
      part(3, { wrote: [id('006', 3)], endedAt: undefined }),
    ];

    expect(laterPartsOf(parts, 0)).toEqual([
      {
        span: { runRecordedAt: new Date(at('10:02:05')), runDurationMs: 5_000 },
        wrote: [id('006', 2)],
        linked: [id('00K', 2)],
      },
    ]);
    expect(laterPartsOf(parts, 1)).toEqual([]);
  });

  it('keeps of a plan what the run still has in the org, by either length of id', () => {
    const plan = [
      { objectApiName: 'Opportunity', ids: [id('006', 1), id('006', 2)] },
      { objectApiName: 'Account', ids: [id('001', 1)] },
    ];

    expect(stillLeft(plan, undefined)).toEqual(plan);
    expect(stillLeft(plan, [id('006', 2).slice(0, 15)])).toEqual([
      { objectApiName: 'Opportunity', ids: [id('006', 2)] },
    ]);
    expect(stillLeft(plan, [])).toEqual([]);
  });

  it('lists every removal span once, in the order they ran', () => {
    const first = { first: at('11:00:00'), last: at('11:00:20'), userId: '005000000000001AAA' };
    const second = { first: at('12:00:00'), last: at('12:00:20'), userId: '005000000000001' };

    expect(
      spansOf([second], undefined, [first, { ...second, userId: '005000000000001AAA' }]),
    ).toEqual([first, second]);
  });
});

describe('the results of the removals of several parts, said as one', () => {
  const result = (
    objectApiName: string,
    fields: Partial<ForgeUndoObjectResult> = {},
  ): ForgeUndoObjectResult => ({
    objectApiName,
    planned: 1,
    deleted: 1,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    unchecked: [],
    reasons: [],
    ...fields,
  });

  it('counts an object two removals took records of once, with both counts', () => {
    expect(
      mergedUndoObjects(
        [result('PricebookEntry', { planned: 2, deleted: 2 }), result('Quote')],
        [
          result('PricebookEntry', {
            planned: 2,
            deleted: 0,
            keptDependents: 2,
            heldBy: ['OpportunityLineItem'],
            reasons: ['held'],
            notVisible: 1,
          }),
          result('Opportunity'),
        ],
      ),
    ).toEqual([
      result('PricebookEntry', {
        planned: 4,
        deleted: 2,
        keptDependents: 2,
        heldBy: ['OpportunityLineItem'],
        reasons: ['held'],
        notVisible: 1,
      }),
      result('Quote'),
      result('Opportunity'),
    ]);
  });

  it('counts a preview of an object two previews read once, with both counts', () => {
    const preview = (
      objectApiName: string,
      fields: Partial<RemovalPreviewObject> = {},
    ): RemovalPreviewObject => ({
      objectApiName,
      planned: 1,
      toDelete: 1,
      alreadyGone: 0,
      changedSince: 0,
      keptChanged: 0,
      changedBy: {},
      undeletable: 0,
      notVisible: 0,
      unread: 0,
      reasons: [],
      ...fields,
    });

    expect(
      mergedPreviewObjects(
        [preview('Contact', { changedSince: 1, keptChanged: 1, toDelete: 0, changedBy: { u: 1 } })],
        [preview('Contact', { changedBy: {} }), preview('Account')],
      ),
    ).toEqual([
      preview('Contact', {
        planned: 2,
        toDelete: 1,
        changedSince: 1,
        keptChanged: 1,
        changedBy: { u: 1 },
      }),
      preview('Account'),
    ]);
  });
});
