import { describe, it, expect } from 'vitest';
import { placeholderId, type RehearsedRow } from './RehearsalWriter.js';
import { familyOf } from './rehearsalSample.js';
import {
  COLLECTIONS_PER_CALL,
  ROWS_PER_COLLECTION,
  compositeBody,
  planCalls,
  readCompositeAnswer,
  verdictsOf,
  type PlannedCall,
} from './compositeCalls.js';

const PREFIX: Record<string, string> = { Account: '001', Contact: '003', Opportunity: '006' };

function row(seq: number, objectApiName: string, fields: Record<string, unknown>): RehearsedRow {
  return {
    seq,
    objectApiName,
    fields,
    placeholderId: placeholderId(PREFIX[objectApiName] ?? 'a0X', seq),
  };
}

const rowOfIn =
  (rows: readonly RehearsedRow[]) =>
  (value: unknown): RehearsedRow | undefined =>
    rows.find((r) => r.placeholderId === value);

/** A chain of `depth` rows, each naming the one before it. */
function chain(depth: number): RehearsedRow[] {
  const rows: RehearsedRow[] = [];
  for (let seq = 0; seq < depth; seq++) {
    rows.push(
      row(seq, 'Account', seq === 0 ? { Name: 'A' } : { ParentId: rows[seq - 1].placeholderId }),
    );
  }
  return rows;
}

const API = '/services/data/v66.0';
const HEADERS = { 'Sforce-Duplicate-Rule-Header': 'allowSave=true', 'Sforce-Auto-Assign': 'FALSE' };

const HALTED = {
  body: [{ errorCode: 'PROCESSING_HALTED', message: 'The transaction was rolled back.' }],
  httpStatusCode: 400,
};
const NOT_FOUND = {
  body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }],
  httpStatusCode: 404,
  referenceId: 'rollback',
};

describe('the calls a rehearsal packs its rows into', () => {
  it('puts a row in the same call as the rows it names, in a later request', () => {
    const account = row(0, 'Account', { Name: 'A' });
    const contact = row(1, 'Contact', { AccountId: account.placeholderId });
    const rows = [account, contact];
    const { calls, beyond } = planCalls(rows, familyOf(rows, rowOfIn(rows)));
    expect(beyond).toEqual([]);
    expect(calls).toEqual([
      {
        collections: [
          { level: 0, seqs: [0] },
          { level: 1, seqs: [1] },
        ],
      },
    ]);
  });

  it('fills one request with up to 200 rows, and opens another past it', () => {
    const rows = Array.from({ length: ROWS_PER_COLLECTION + 1 }, (_, i) =>
      row(i, 'Account', { Name: 'A' }),
    );
    const { calls } = planCalls(rows, familyOf(rows, rowOfIn(rows)));
    expect(calls).toHaveLength(1);
    expect(calls[0].collections.map((c) => c.seqs.length)).toEqual([ROWS_PER_COLLECTION, 1]);
  });

  it('mixes ten objects in a request at most, each object one chunk', () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      row(i, `Object${String(i).padStart(2, '0')}__c`, {}),
    );
    const { calls } = planCalls(rows, familyOf(rows, rowOfIn(rows)));
    expect(calls[0].collections.map((c) => c.seqs.length)).toEqual([10, 1]);
  });

  it('opens another call past five requests', () => {
    const rows = Array.from({ length: ROWS_PER_COLLECTION * COLLECTIONS_PER_CALL + 1 }, (_, i) =>
      row(i, 'Account', { Name: 'A' }),
    );
    const { calls } = planCalls(rows, familyOf(rows, rowOfIn(rows)));
    expect(calls).toHaveLength(2);
    expect(calls[0].collections).toHaveLength(COLLECTIONS_PER_CALL);
  });

  it('sends a parent again with the children a later call holds', () => {
    const account = row(0, 'Account', { Name: 'A' });
    const contacts = Array.from({ length: ROWS_PER_COLLECTION * COLLECTIONS_PER_CALL }, (_, i) =>
      row(i + 1, 'Contact', { AccountId: account.placeholderId }),
    );
    const rows = [account, ...contacts];
    const { calls } = planCalls(rows, familyOf(rows, rowOfIn(rows)));
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.collections[0].seqs).toEqual([0]);
  });

  it('leaves out a row whose chain of parents is deeper than one call holds, never its parents', () => {
    const rows = chain(COLLECTIONS_PER_CALL + 1);
    const { calls, beyond } = planCalls(rows, familyOf(rows, rowOfIn(rows)));
    expect(beyond).toEqual([COLLECTIONS_PER_CALL]);
    expect(calls.flatMap((c) => c.collections.flatMap((x) => x.seqs)).sort()).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe('the composite request of a call', () => {
  const account = row(0, 'Account', { Name: 'A', attributes: { type: 'Account', url: '/x' } });
  const contact = row(1, 'Contact', {
    LastName: 'C',
    AccountId: account.placeholderId,
    OwnerId: '005000000000001AAA',
  });
  const rows = [account, contact];
  const family = familyOf(rows, rowOfIn(rows));
  const [call] = planCalls(rows, family).calls;
  const body = compositeBody(call, family, rowOfIn(rows), API, HEADERS);

  it('is all or none, each Collections request creating its rows one by one', () => {
    expect(body.allOrNone).toBe(true);
    expect(body.compositeRequest[0]).toMatchObject({
      method: 'POST',
      url: `${API}/composite/sobjects`,
      referenceId: 'rows0',
      body: { allOrNone: false },
      httpHeaders: HEADERS,
    });
  });

  it('names each row’s object, and reads a parent’s new id from its request’s answer', () => {
    const contacts = (body.compositeRequest[1].body as { records: unknown[] }).records;
    expect(contacts).toEqual([
      {
        attributes: { type: 'Contact' },
        LastName: 'C',
        AccountId: '@{rows0[0].id}',
        OwnerId: '005000000000001AAA',
      },
    ]);
    const accounts = (body.compositeRequest[0].body as { records: unknown[] }).records;
    expect(accounts).toEqual([{ attributes: { type: 'Account' }, Name: 'A' }]);
  });

  it('ends on an update that fails: an id of record number zero, and a field no object has', () => {
    const last = body.compositeRequest[body.compositeRequest.length - 1];
    expect(last.method).toBe('PATCH');
    expect(last.url).toBe(`${API}/sobjects/Account/001000000000000AAA`);
    expect(last.body).toEqual({ SandForge_Rehearsal_Rollback__c: true });
  });

  it('refuses a row naming a record the run creates that the call does not hold', () => {
    const alone: PlannedCall = { collections: [{ level: 1, seqs: [1] }] };
    expect(() => compositeBody(alone, family, rowOfIn(rows), API, HEADERS)).toThrow(
      /does not hold/,
    );
  });
});

describe("reading a call's answer", () => {
  const call: PlannedCall = {
    collections: [
      { level: 0, seqs: [0, 1] },
      { level: 1, seqs: [2, 3] },
    ],
  };

  it('reads every row as passed when every request was stopped and the closing update failed on its own', () => {
    const answer = readCompositeAnswer(
      {
        compositeResponse: [
          { ...HALTED, referenceId: 'rows0' },
          { ...HALTED, referenceId: 'rows1' },
          NOT_FOUND,
        ],
      },
      call,
    );
    expect(answer.kind).toBe('rolled_back');
    if (answer.kind !== 'rolled_back') return;
    const verdicts = verdictsOf(call, answer.collections);
    expect([...verdicts.values()].every((v) => v.passed)).toBe(true);
    expect(verdicts.size).toBe(4);
  });

  it('reads a request whose body was lost before the one that refused a row as passed, never as failed', () => {
    const answer = readCompositeAnswer(
      {
        compositeResponse: [
          { ...HALTED, referenceId: 'rows0' },
          {
            body: [
              { id: '003000000000001AAA', success: true, errors: [] },
              {
                success: false,
                errors: [
                  {
                    statusCode: 'REQUIRED_FIELD_MISSING',
                    message: 'Champs requis manquants',
                    fields: ['LastName'],
                  },
                ],
              },
            ],
            httpStatusCode: 200,
            referenceId: 'rows1',
          },
          { ...HALTED, referenceId: 'rollback' },
        ],
      },
      call,
    );
    expect(answer.kind).toBe('rolled_back');
    if (answer.kind !== 'rolled_back') return;
    const verdicts = verdictsOf(call, answer.collections);
    expect(verdicts.get(0)).toEqual({ passed: true });
    expect(verdicts.get(1)).toEqual({ passed: true });
    expect(verdicts.get(2)).toEqual({ passed: true });
    expect(verdicts.get(3)).toEqual({
      passed: false,
      errors: [
        {
          statusCode: 'REQUIRED_FIELD_MISSING',
          message: 'Champs requis manquants',
          fields: ['LastName'],
        },
      ],
    });
  });

  it('gives the rows of the requests after the one the call stopped at no verdict', () => {
    const answer = readCompositeAnswer(
      {
        compositeResponse: [
          {
            body: [
              {
                success: false,
                errors: [{ statusCode: 'INVALID_EMAIL_ADDRESS', message: 'x', fields: ['Email'] }],
              },
              { id: '001000000000002AAA', success: true, errors: [] },
            ],
            httpStatusCode: 200,
          },
          { ...HALTED },
          { ...HALTED },
        ],
      },
      call,
    );
    if (answer.kind !== 'rolled_back') throw new Error('expected a rolled back call');
    const verdicts = verdictsOf(call, answer.collections);
    expect(verdicts.get(0)?.passed).toBe(false);
    expect(verdicts.get(1)?.passed).toBe(true);
    expect(verdicts.has(2)).toBe(false);
    expect(verdicts.has(3)).toBe(false);
  });

  it('gives every row of a request refused whole the errors it was refused with', () => {
    const answer = readCompositeAnswer(
      {
        compositeResponse: [
          {
            body: [{ errorCode: 'INVALID_FIELD', message: 'No such column', fields: [] }],
            httpStatusCode: 400,
          },
          { ...HALTED },
          { ...HALTED },
        ],
      },
      call,
    );
    if (answer.kind !== 'rolled_back') throw new Error('expected a rolled back call');
    const verdicts = verdictsOf(call, answer.collections);
    expect(verdicts.get(0)).toEqual({
      passed: false,
      errors: [{ statusCode: 'INVALID_FIELD', message: 'No such column', fields: [] }],
    });
    expect(verdicts.get(1)?.passed).toBe(false);
    expect(verdicts.has(2)).toBe(false);
  });

  it('says a call whose closing update did not fail was not rolled back, with the ids it created', () => {
    const answer = readCompositeAnswer(
      {
        compositeResponse: [
          {
            body: [
              { id: '001000000000003AAA', success: true, errors: [] },
              { id: '001000000000004AAA', success: true, errors: [] },
            ],
            httpStatusCode: 200,
          },
          {
            body: [
              { id: '003000000000005AAA', success: true, errors: [] },
              { id: '003000000000006AAA', success: true, errors: [] },
            ],
            httpStatusCode: 200,
          },
          { body: null, httpStatusCode: 204 },
        ],
      },
      call,
    );
    expect(answer).toEqual({
      kind: 'not_rolled_back',
      ids: ['001000000000003AAA', '001000000000004AAA', '003000000000005AAA', '003000000000006AAA'],
    });
  });

  it('refuses an answer that stopped at a request naming no refusal', () => {
    expect(() =>
      readCompositeAnswer(
        { compositeResponse: [{ ...HALTED }, { ...HALTED }, { ...HALTED }] },
        call,
      ),
    ).toThrow(/names no refusal/);
  });

  it('refuses an answer that is not one of this call', () => {
    expect(() => readCompositeAnswer({ compositeResponse: [NOT_FOUND] }, call)).toThrow(
      /subrequests/,
    );
    expect(() => readCompositeAnswer('nope', call)).toThrow(/no composite answer/);
    expect(() =>
      readCompositeAnswer(
        {
          compositeResponse: [
            { body: [{ id: 'x', success: true }], httpStatusCode: 200 },
            { ...HALTED },
            NOT_FOUND,
          ],
        },
        call,
      ),
    ).toThrow(/1 rows of the 2/);
  });
});
