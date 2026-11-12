import { describe, expect, it } from 'vitest';

import {
  GOVERNOR_LIMIT,
  NOT_A_BATCH_LIMIT,
  automationOf,
  limitCauseOf,
  limitIn,
} from './governor-limit.js';

/**
 * What a trap org answered every row of an insert of 200, and every record of
 * a delete of 116, its trigger running a query per record: the same code and
 * message for both.
 */
const REFUSED = 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY';
const LIMIT_MESSAGE = 'Ledger_Trigger: System.LimitException: Too many SOQL queries: 101';
const LIVE = `${REFUSED}: ${LIMIT_MESSAGE}`;

/** What the same trap org answered a row whose trigger looped past the CPU limit. */
const CPU = `${REFUSED}: Ledger_Trigger: System.LimitException: Apex CPU time limit exceeded`;

/**
 * The longer form, with the event and the stack, that a removal was reported
 * refused with: kept read, though no org of ours has answered it yet.
 */
const WITH_STACK =
  'Ledger_Trigger: execution of BeforeDelete\n\ncaused by: System.LimitException: Too many SOQL queries: 101\n\nClass.LedgerHandler.beforeDelete: line 42, column 1\nTrigger.Ledger_Trigger: line 5, column 1';

describe('limitIn', () => {
  it('tells what a trap org answered an insert and a delete refused for a limit', () => {
    expect(limitIn([LIVE])).toBe('Too many SOQL queries');
    expect(limitIn([CPU])).toBe('Apex CPU time limit exceeded');
  });

  it('reads the longer form over several lines, under any code', () => {
    expect(limitIn([WITH_STACK])).toBe('Too many SOQL queries');
    expect(limitIn([`DELETE_FAILED: ${WITH_STACK}`])).toBe('Too many SOQL queries');
    expect(limitIn(['caused by: System.LimitException: Too many\nSOQL   queries: 101'])).toBe(
      'Too many SOQL queries',
    );
  });

  it('names every limit a smaller call cures', () => {
    const cases: Array<[string, string]> = [
      ['System.LimitException: Apex CPU time limit exceeded', 'Apex CPU time limit exceeded'],
      ['System.LimitException: Too many DML statements: 151', 'Too many DML statements'],
      ['System.LimitException: Too many DML rows: 10001', 'Too many DML rows'],
      ['System.LimitException: Too many query rows: 50001', 'Too many query rows'],
      ['System.LimitException: Apex heap size too large: 6291556', 'Apex heap size too large'],
      ['System.LimitException: Too many future calls: 51', 'Too many future calls'],
      ['System.LimitException: Too many SOSL queries: 21', 'Too many SOSL queries'],
      [
        'System.LimitException: Too many queueable jobs added to the queue: 51',
        'Too many queueable jobs added',
      ],
    ];
    for (const [text, phrase] of cases) {
      expect(limitIn([`${REFUSED}: Acme_Trigger: ${text}`])).toBe(phrase);
    }
  });

  it('tells a Flow refused for a limit, under CANNOT_EXECUTE_FLOW_TRIGGER', () => {
    const flow =
      'CANNOT_EXECUTE_FLOW_TRIGGER: We can’t save this record because the “Ledger after delete” process failed. Give your Salesforce admin these details. Too many SOQL queries: 101';
    expect(limitIn([flow])).toBe('Too many SOQL queries');
  });

  it('gives System.LimitException when the text names no limit, whatever the case', () => {
    expect(limitIn(['UNKNOWN_EXCEPTION: system.limitexception: something else'])).toBe(
      'System.LimitException',
    );
    expect(limitIn(['too many soql queries: 101'])).toBe('Too many SOQL queries');
  });

  it('finds the limit in any of the row’s texts', () => {
    expect(limitIn(['REQUIRED_FIELD_MISSING: Name', LIVE])).toBe('Too many SOQL queries');
  });

  it('tells none of the refusals a smaller call does not cure', () => {
    const notLimits = [
      'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
      'STORAGE_LIMIT_EXCEEDED: storage limit exceeded',
      'LIMIT_EXCEEDED: Maximum number of records exceeded',
      'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record or 1 records',
      // What a trigger that calls addError on one row answers, live: that
      // row alone is refused, the others go in.
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: The phone must be in the format +33 1 23 45 67 89',
      `${REFUSED}: Acme_Trigger: maximum trigger depth exceeded`,
    ];
    for (const text of notLimits) expect(limitIn([text])).toBeUndefined();
    expect(limitIn([])).toBeUndefined();
  });

  it('leaves a trigger’s recursion out even when Salesforce calls it a LimitException', () => {
    expect(
      limitIn([
        'Acme_Trigger: execution of AfterUpdate caused by: System.LimitException: Maximum stack depth reached: 1001',
      ]),
    ).toBeUndefined();
    expect(limitIn([LIVE, `${REFUSED}: Maximum trigger depth exceeded`])).toBeUndefined();
  });
});

describe('GOVERNOR_LIMIT and NOT_A_BATCH_LIMIT', () => {
  it('match unanchored, in the middle of a message', () => {
    expect(GOVERNOR_LIMIT.test(LIVE)).toBe(true);
    expect(GOVERNOR_LIMIT.test('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')).toBe(
      false,
    );
    expect(
      NOT_A_BATCH_LIMIT.test('caused by: System.LimitException: Maximum stack depth reached'),
    ).toBe(true);
    expect(NOT_A_BATCH_LIMIT.test(WITH_STACK)).toBe(false);
  });
});

describe('automationOf', () => {
  it('names the trigger of what a trap org answered, with no event since it says none', () => {
    expect(automationOf(LIVE)).toEqual({ automation: 'Ledger_Trigger' });
    expect(automationOf(LIMIT_MESSAGE)).toEqual({ automation: 'Ledger_Trigger' });
    expect(automationOf(CPU)).toEqual({ automation: 'Ledger_Trigger' });
  });

  it('names the trigger and the event of the longer form', () => {
    expect(automationOf(`DELETE_FAILED: ${WITH_STACK}`)).toEqual({
      automation: 'Ledger_Trigger',
      event: 'before delete',
    });
  });

  it('names a managed package’s trigger with its namespace', () => {
    expect(
      automationOf(
        `${REFUSED}: acme.AccountTrigger: execution of AfterInsert caused by: System.LimitException: Apex CPU time limit exceeded`,
      ),
    ).toEqual({ automation: 'acme.AccountTrigger', event: 'after insert' });
    expect(automationOf('acme__Sync_Trigger: execution of AfterUndelete')).toEqual({
      automation: 'acme__Sync_Trigger',
      event: 'after undelete',
    });
    expect(automationOf(`${REFUSED}: acme.Ledger: System.LimitException: Too many`)).toEqual({
      automation: 'acme.Ledger',
    });
  });

  it('falls back on the line of the stack that names the trigger, with no event', () => {
    expect(
      automationOf(
        'System.LimitException: Too many SOQL queries: 101\nTrigger.Contact_Trigger: line 5, column 1',
      ),
    ).toEqual({ automation: 'Contact_Trigger' });
  });

  it('never takes a status code, or the words before the exception, for a trigger', () => {
    expect(
      automationOf('UNKNOWN_EXCEPTION: System.LimitException: Too many SOQL queries: 101'),
    ).toBeUndefined();
    expect(automationOf('caused by: System.LimitException: Too many SOQL queries')).toBeUndefined();
    expect(automationOf('')).toBeUndefined();
  });
});

describe('limitCauseOf', () => {
  it('gives the limit and the trigger the texts name', () => {
    expect(limitCauseOf([LIVE])).toEqual({
      limit: 'Too many SOQL queries',
      automation: 'Ledger_Trigger',
    });
    expect(limitCauseOf([`DELETE_FAILED: ${WITH_STACK}`])).toEqual({
      limit: 'Too many SOQL queries',
      automation: 'Ledger_Trigger',
      event: 'before delete',
    });
  });

  it('gives the limit alone when no trigger is named, and nothing when no limit is', () => {
    expect(limitCauseOf(['UNKNOWN_EXCEPTION: Apex CPU time limit exceeded'])).toEqual({
      limit: 'Apex CPU time limit exceeded',
    });
    expect(
      limitCauseOf(['Acme_Trigger: execution of BeforeInsert caused by: boom']),
    ).toBeUndefined();
  });
});
