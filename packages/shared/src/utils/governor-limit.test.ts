import { describe, expect, it } from 'vitest';

import {
  GOVERNOR_LIMIT,
  NOT_A_BATCH_LIMIT,
  automationOf,
  limitCauseOf,
  limitIn,
} from './governor-limit.js';

/** The message the 116 `Provenance__c` of a real removal were refused with, as Salesforce wrote it. */
const INCIDENT =
  'SSC_TRG_Provenance: execution of BeforeDelete\n\ncaused by: System.LimitException: Too many SOQL queries: 101\n\nClass.SSC_ProvenanceHandler.beforeDelete: line 42, column 1\nTrigger.SSC_TRG_Provenance: line 5, column 1';

describe('limitIn', () => {
  it('tells the real incident under DELETE_FAILED, as describeError writes it', () => {
    expect(limitIn([`DELETE_FAILED: ${INCIDENT}`])).toBe('Too many SOQL queries');
  });

  it('tells the real incident under CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', () => {
    const text = `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${INCIDENT.replace('BeforeDelete', 'BeforeInsert')}`;
    expect(limitIn([text])).toBe('Too many SOQL queries');
  });

  it('reads the message over several lines, and in a Bulk job’s sf__Error', () => {
    expect(limitIn([INCIDENT])).toBe('Too many SOQL queries');
    const sfError = `DELETE_FAILED:${INCIDENT}:--`;
    expect(limitIn([sfError])).toBe('Too many SOQL queries');
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
      expect(limitIn([`CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: Acme_Trigger: ${text}`])).toBe(phrase);
    }
  });

  it('tells a Flow refused for a limit, under CANNOT_EXECUTE_FLOW_TRIGGER', () => {
    const flow =
      'CANNOT_EXECUTE_FLOW_TRIGGER: We can’t save this record because the “Provenance after delete” process failed. Give your Salesforce admin these details. Too many SOQL queries: 101';
    expect(limitIn([flow])).toBe('Too many SOQL queries');
  });

  it('gives System.LimitException when the text names no limit, whatever the case', () => {
    expect(limitIn(['UNKNOWN_EXCEPTION: system.limitexception: something else'])).toBe(
      'System.LimitException',
    );
    expect(limitIn(['too many soql queries: 101'])).toBe('Too many SOQL queries');
  });

  it('finds the limit in any of the row’s texts', () => {
    expect(limitIn(['REQUIRED_FIELD_MISSING: Name', `DELETE_FAILED: ${INCIDENT}`])).toBe(
      'Too many SOQL queries',
    );
  });

  it('tells none of the refusals a smaller call does not cure', () => {
    const notLimits = [
      'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
      'STORAGE_LIMIT_EXCEEDED: storage limit exceeded',
      'LIMIT_EXCEEDED: Maximum number of records exceeded',
      'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record or 1 records: 001xx000003DGb2AAG',
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: The phone must be in the format +33 1 23 45 67 89',
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: Acme_Trigger: maximum trigger depth exceeded',
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
    expect(
      limitIn([
        `DELETE_FAILED: ${INCIDENT}`,
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: Maximum trigger depth exceeded',
      ]),
    ).toBeUndefined();
  });
});

describe('GOVERNOR_LIMIT and NOT_A_BATCH_LIMIT', () => {
  it('match unanchored, in the middle of a message', () => {
    expect(GOVERNOR_LIMIT.test(`DELETE_FAILED: ${INCIDENT}`)).toBe(true);
    expect(GOVERNOR_LIMIT.test('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')).toBe(
      false,
    );
    expect(
      NOT_A_BATCH_LIMIT.test('caused by: System.LimitException: Maximum stack depth reached'),
    ).toBe(true);
    expect(NOT_A_BATCH_LIMIT.test(INCIDENT)).toBe(false);
  });
});

describe('automationOf', () => {
  it('names the trigger and the event of the real incident', () => {
    expect(automationOf(`DELETE_FAILED: ${INCIDENT}`)).toEqual({
      automation: 'SSC_TRG_Provenance',
      event: 'before delete',
    });
  });

  it('names a managed package’s trigger with its namespace', () => {
    expect(
      automationOf(
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: acme.AccountTrigger: execution of AfterInsert caused by: System.LimitException: Apex CPU time limit exceeded',
      ),
    ).toEqual({ automation: 'acme.AccountTrigger', event: 'after insert' });
    expect(automationOf('acme__Sync_Trigger: execution of AfterUndelete')).toEqual({
      automation: 'acme__Sync_Trigger',
      event: 'after undelete',
    });
  });

  it('falls back on the line of the stack that names the trigger, with no event', () => {
    expect(
      automationOf(
        'System.LimitException: Too many SOQL queries: 101\nTrigger.Contact_Trigger: line 5, column 1',
      ),
    ).toEqual({ automation: 'Contact_Trigger' });
  });

  it('names no one when the message names no trigger', () => {
    expect(
      automationOf('UNKNOWN_EXCEPTION: System.LimitException: Too many SOQL queries: 101'),
    ).toBeUndefined();
    expect(automationOf('')).toBeUndefined();
  });
});

describe('limitCauseOf', () => {
  it('gives the limit and the trigger the texts name', () => {
    expect(limitCauseOf([`DELETE_FAILED: ${INCIDENT}`])).toEqual({
      limit: 'Too many SOQL queries',
      automation: 'SSC_TRG_Provenance',
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
