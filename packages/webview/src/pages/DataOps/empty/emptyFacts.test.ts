import { describe, expect, it } from 'vitest';
import {
  NO_BOXES,
  asksBox,
  countShown,
  emptyHistoryOf,
  emptySize,
  holdingRefusals,
  holdsRecords,
  leftOutByReason,
  notPickable,
  undoableRun,
} from './emptyFacts';
import { RUN_ID, auditEntry } from './testing/emptyAnswers';

const refusal = (code: string) => ({ code, message: `${code} said` });

describe('holdingRefusals', () => {
  it('lifts what fires, which the preview lists and the confirmation accepts', () => {
    expect(holdingRefusals([refusal('AUTOMATION_NOT_ACCEPTED')], NO_BOXES)).toEqual([]);
  });

  it('lifts the emails and the records no undo brings back only once their box is ticked', () => {
    const refusals = [refusal('EMAILS_NOT_ACCEPTED'), refusal('NO_UNDO')];
    expect(holdingRefusals(refusals, NO_BOXES).map((r) => r.code)).toEqual([
      'EMAILS_NOT_ACCEPTED',
      'NO_UNDO',
    ]);
    expect(
      holdingRefusals(refusals, { ...NO_BOXES, acceptEmails: true }).map((r) => r.code),
    ).toEqual(['NO_UNDO']);
    expect(
      holdingRefusals(refusals, { ...NO_BOXES, acceptEmails: true, acceptNoUndo: true }),
    ).toEqual([]);
  });

  it('lifts the people at work only once the box that lets their work go is ticked', () => {
    const refusals = [refusal('PEOPLE_ACTIVE')];
    expect(holdingRefusals(refusals, NO_BOXES).map((r) => r.code)).toEqual(['PEOPLE_ACTIVE']);
    expect(holdingRefusals(refusals, { ...NO_BOXES, acceptPeopleActive: true })).toEqual([]);
    expect(asksBox(refusals, 'acceptPeopleActive')).toBe(true);
  });

  it('holds every other refusal whatever is ticked', () => {
    const refusals = ['OPEN_RUN', 'API_BUDGET', 'EMAILS_EXCEEDED', 'MUTE_REFUSED', 'RUN_WRITING'];
    expect(
      holdingRefusals(refusals.map(refusal), {
        acceptEmails: true,
        acceptNoUndo: true,
        acceptPeopleActive: true,
      }).map((r) => r.code),
    ).toEqual(refusals);
  });

  it('offers a box only where a refusal names it', () => {
    expect(asksBox([refusal('NO_UNDO')], 'acceptNoUndo')).toBe(true);
    expect(asksBox([refusal('NO_UNDO')], 'acceptEmails')).toBe(false);
  });
});

describe('counts', () => {
  it('reads a count, a bound on one, or none with the org words', () => {
    expect(countShown({ records: 4 })).toEqual({ kind: 'exact', records: 4 });
    expect(countShown({ records: 4, atMost: true })).toEqual({ kind: 'atMost', records: 4 });
    expect(countShown({ records: 4, atLeast: true })).toEqual({ kind: 'atLeast', records: 4 });
    expect(countShown({ unread: 'QUERY_TIMEOUT' })).toEqual({
      kind: 'unread',
      reason: 'QUERY_TIMEOUT',
    });
  });

  it('never reads a table the org would not count as an empty one', () => {
    expect(holdsRecords({ unread: 'refused' })).toBe(true);
    expect(holdsRecords({ records: 0 })).toBe(false);
  });

  it('says the size short of what was not counted', () => {
    expect(emptySize({ total: { records: 10, objects: 2, uncounted: ['Case'] } })).toEqual({
      records: 10,
      objects: 2,
      atLeast: true,
    });
  });
});

describe('what is left out', () => {
  it('groups the objects left out by reason, in the order given', () => {
    expect(
      leftOutByReason([
        { objectApiName: 'User', reason: 'setup' },
        { objectApiName: 'ApexClass', reason: 'metadata' },
        { objectApiName: 'Profile', reason: 'setup' },
      ]),
    ).toEqual([
      {
        reason: 'setup',
        objects: [
          { objectApiName: 'User', reason: 'setup' },
          { objectApiName: 'Profile', reason: 'setup' },
        ],
      },
      { reason: 'metadata', objects: [{ objectApiName: 'ApexClass', reason: 'metadata' }] },
    ]);
  });

  it('leaves a custom setting a pick asks for among what may be picked', () => {
    expect(
      notPickable(
        [
          { objectApiName: 'Region__c', reason: 'customSetting' },
          { objectApiName: 'User', reason: 'setup' },
        ],
        ['Account', 'region__c'],
      ),
    ).toEqual([{ objectApiName: 'User', reason: 'setup' }]);
  });
});

describe('emptyHistoryOf', () => {
  it('lists the emptyings and undos of the trail, the latest first, nothing else of DataOps', () => {
    const history = emptyHistoryOf([
      auditEntry('run', '2026-11-12T10:00:00.000Z'),
      auditEntry('undo', '2026-11-12T11:00:00.000Z'),
      { ...auditEntry('run', '2026-11-12T12:00:00.000Z'), details: { recommendation: 'stale' } },
      { ...auditEntry('run', '2026-11-12T13:00:00.000Z'), action: 'backup_create' },
    ]);
    expect(history.map((entry) => [entry.act, entry.at, entry.records])).toEqual([
      ['undo', '2026-11-12T11:00:00.000Z', 5],
      ['run', '2026-11-12T10:00:00.000Z', 5],
    ]);
  });

  it('reads an undo under its own action, and one recorded under cleanup_delete before it had one', () => {
    const history = emptyHistoryOf([
      auditEntry('undo', '2026-11-12T11:00:00.000Z'),
      { ...auditEntry('undo', '2026-11-12T12:00:00.000Z'), action: 'cleanup_delete' },
      { ...auditEntry('run', '2026-11-12T13:00:00.000Z'), action: 'empty_undo', details: {} },
    ]);
    expect(history.map((entry) => [entry.act, entry.at, entry.records])).toEqual([
      ['undo', '2026-11-12T13:00:00.000Z', 0],
      ['undo', '2026-11-12T12:00:00.000Z', 5],
      ['undo', '2026-11-12T11:00:00.000Z', 5],
    ]);
  });

  it('reads a delete for good from either detail the audit trail keeps', () => {
    const [entry] = emptyHistoryOf([
      {
        ...auditEntry('run', '2026-11-12T10:00:00.000Z'),
        details: { empty: 'run', deleteMode: 'hard' },
      },
    ]);
    expect(entry.hard).toBe(true);
  });
});

describe('undoableRun', () => {
  it('offers the last emptying that deleted something', () => {
    expect(
      undoableRun(emptyHistoryOf([auditEntry('run', '2026-11-12T10:00:00.000Z')]))?.runId,
    ).toBe(RUN_ID);
  });

  it('offers none once its undo went through, after a delete for good, or when nothing was deleted', () => {
    const run = auditEntry('run', '2026-11-12T10:00:00.000Z');
    expect(undoableRun(emptyHistoryOf([run, auditEntry('undo', '2026-11-12T11:00:00.000Z')]))).toBe(
      undefined,
    );
    expect(undoableRun(emptyHistoryOf([{ ...run, details: { ...run.details, hard: true } }]))).toBe(
      undefined,
    );
    expect(
      undoableRun(
        emptyHistoryOf([
          {
            ...run,
            objects: [{ objectApiName: 'Account', created: 0, updated: 0, deleted: 0, failed: 0 }],
          },
        ]),
      ),
    ).toBe(undefined);
  });

  it('still offers it after an undo that was refused', () => {
    const refused = {
      ...auditEntry('undo', '2026-11-12T11:00:00.000Z'),
      outcome: 'stopped' as const,
    };
    expect(
      undoableRun(emptyHistoryOf([auditEntry('run', '2026-11-12T10:00:00.000Z'), refused]))?.runId,
    ).toBe(RUN_ID);
  });
});
