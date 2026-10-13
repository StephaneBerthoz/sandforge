import { describe, it, expect, vi } from 'vitest';
import type { ForgeRehearsalProgress } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import type { RehearsalWriter } from './RehearsalWriter.js';
import type { CompositeRequestBody } from './compositeCalls.js';
import {
  RehearsalCancelledError,
  RehearsalNotRolledBackError,
  rehearse,
  type RehearsalDeps,
} from './rehearse.js';

const PREFIX: Record<string, string> = { Account: '001', Contact: '003', Opportunity: '006' };

/** A refusal: a status code alone, given as its message too, or the error as the platform words it. */
type Refusal = string | { statusCode: string; message: string; fields?: string[] };

/**
 * What the target says of a row: `created` holds the rows its call created
 * before it, with their new ids, as a unique index sees them.
 */
type Rule = (
  objectApiName: string,
  record: Record<string, unknown>,
  created: ReadonlyArray<{ record: Record<string, unknown>; id: string }>,
) => Refusal | undefined;

/** An 18-character id of the object whose key prefix starts `id15`, its checksum right. */
function idOf(id15: string): string {
  const id = canonicalRecordId(id15);
  if (id === undefined) throw new Error(`${id15} is no id`);
  return id;
}

/** What the target says of an update of a record a call created, by its id. */
type UpdateRule = (
  objectApiName: string,
  recordId: string,
  fields: Record<string, unknown>,
) => string | undefined;

/**
 * A target that answers a composite call as the platform does, all or none:
 * each Collections request creates its rows one by one, a reference reads an
 * earlier request's new ids, each update of a record the call created after
 * them is applied, and the first request that refuses a row, or the first
 * update refused, stops the call — it keeps its verdict, every other
 * subrequest is stopped. When nothing is refused, every request is stopped
 * and the closing update fails on its own. `commits` makes the closing update
 * succeed instead.
 */
function fakeTarget(rule: Rule, commits = false, updateRule: UpdateRule = () => undefined) {
  const calls: CompositeRequestBody[] = [];
  let next = 0;
  const halted = {
    body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }],
    httpStatusCode: 400,
  };
  const composite = vi.fn(async (body: CompositeRequestBody) => {
    calls.push(body);
    const results = new Map<string, Array<{ id?: string; success: boolean }>>();
    const resolve = (value: unknown): unknown => {
      const ref = typeof value === 'string' ? /^@\{(rows\d+)\[(\d+)\]\.id\}$/.exec(value) : null;
      return ref ? results.get(ref[1])?.[Number(ref[2])]?.id : value;
    };
    const collections = body.compositeRequest.slice(0, -1);
    const answers: unknown[] = [];
    const created: Array<{ record: Record<string, unknown>; id: string }> = [];
    let stoppedAt = -1;
    for (const [index, sub] of collections.entries()) {
      if (sub.method === 'PATCH') {
        const [, type = '', record = ''] = /\/sobjects\/(\w+)\/(.+)$/.exec(sub.url) ?? [];
        const fields = Object.fromEntries(
          Object.entries(sub.body as Record<string, unknown>).map(([f, v]) => [f, resolve(v)]),
        );
        const refusal = updateRule(type, String(resolve(record)), fields);
        if (refusal) {
          stoppedAt = index;
          answers.push({
            body: [{ errorCode: refusal, message: refusal, fields: Object.keys(fields) }],
            httpStatusCode: 400,
          });
          break;
        }
        answers.push(commits ? { body: null, httpStatusCode: 204 } : halted);
        continue;
      }
      const records = (sub.body as { records: Array<Record<string, unknown>> }).records;
      const outcomes = records.map((record) => {
        const resolved: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(record)) resolved[field] = resolve(value);
        const type = (record.attributes as { type: string }).type;
        const refusal = rule(type, resolved, created);
        if (refusal) {
          const error =
            typeof refusal === 'string'
              ? { statusCode: refusal, message: refusal, fields: [] }
              : { fields: [], ...refusal };
          return { success: false, errors: [error] };
        }
        const id = idOf(`${PREFIX[type] ?? 'a0X'}${String(++next).padStart(12, '0')}`);
        created.push({ record: resolved, id });
        return { id, success: true, errors: [] };
      });
      results.set(sub.referenceId, outcomes);
      if (outcomes.some((o) => !o.success)) {
        stoppedAt = index;
        answers.push({ body: outcomes, httpStatusCode: 200, referenceId: sub.referenceId });
        break;
      }
      answers.push(commits ? { body: outcomes, httpStatusCode: 200 } : halted);
    }
    while (answers.length < collections.length) answers.push(halted);
    if (stoppedAt !== -1) {
      for (let i = 0; i < stoppedAt; i++) answers[i] = halted;
      answers.push(halted);
    } else {
      answers.push(
        commits
          ? { body: null, httpStatusCode: 204 }
          : { body: [{ errorCode: 'NOT_FOUND', message: 'not found' }], httpStatusCode: 404 },
      );
    }
    return { compositeResponse: answers };
  });
  return { composite, calls };
}

/** A run that would create these rows, object by object, each naming the ones before as the `link` says. */
function preparing(
  plan: Array<{
    object: string;
    rows: Array<Record<string, unknown>>;
    parentField?: string;
    parentIndex?: (i: number) => number;
  }>,
  updates = 0,
): (writer: RehearsalWriter) => Promise<void> {
  return async (writer) => {
    let previous: string[] = [];
    for (const step of plan) {
      const rows = step.rows.map((fields, i) =>
        step.parentField
          ? { ...fields, [step.parentField]: previous[step.parentIndex?.(i) ?? 0] }
          : fields,
      );
      const results = await writer.insertRecords('target', step.object, rows);
      previous = results.map((r) => r.id);
    }
    if (updates > 0) {
      await writer.updateRecords(
        'target',
        'Account',
        Array.from({ length: updates }, () => ({})),
      );
    }
  };
}

function deps(
  over: Partial<RehearsalDeps> & Pick<RehearsalDeps, 'prepare' | 'composite'>,
): RehearsalDeps {
  return {
    keyPrefixOf: async (object) => PREFIX[object] ?? null,
    apiPath: '/services/data/v66.0',
    writeHeaders: { 'Sforce-Auto-Assign': 'FALSE' },
    confirm: async () => {},
    ...over,
  };
}

const lastNameRequired: Rule = (type, record) =>
  type === 'Contact' && !record['LastName'] ? 'REQUIRED_FIELD_MISSING' : undefined;

describe('a rehearsal', () => {
  it('reads every row as passing when the target creates them all, in one call', async () => {
    const target = fakeTarget(lastNameRequired);
    const confirm = vi.fn(async () => {});
    const result = await rehearse(
      deps({
        prepare: preparing([
          { object: 'Account', rows: [{ Name: 'A' }] },
          {
            object: 'Contact',
            rows: [{ LastName: 'B' }, { LastName: 'C' }],
            parentField: 'AccountId',
          },
        ]),
        composite: target.composite,
        confirm,
      }),
    );
    expect(result).toMatchObject({
      gaps: [],
      rows: 3,
      sampled: 3,
      judged: 3,
      passed: 3,
      notJudged: 0,
      calls: 1,
      plannedCalls: 1,
    });
    expect(confirm).toHaveBeenCalledWith({
      rows: 3,
      sampled: 3,
      updates: [],
      calls: 1,
      maxCalls: 5,
      objects: [
        { objectApiName: 'Contact', rows: 2 },
        { objectApiName: 'Account', rows: 1 },
      ],
    });
  });

  it('turns a refused row into a gap, and keeps the rows that passed with it as passed', async () => {
    const target = fakeTarget(lastNameRequired);
    const result = await rehearse(
      deps({
        prepare: preparing([
          { object: 'Account', rows: [{ Name: 'A' }] },
          {
            object: 'Contact',
            rows: [{ LastName: 'B' }, { FirstName: 'C' }],
            parentField: 'AccountId',
          },
        ]),
        composite: target.composite,
      }),
    );
    expect(result).toMatchObject({ judged: 3, passed: 2, notJudged: 0, calls: 1 });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      id: forgeGapId(
        'rehearsal_refusal',
        'Contact',
        undefined,
        undefined,
        'REQUIRED_FIELD_MISSING',
      ),
      value: 'REQUIRED_FIELD_MISSING',
      rows: 1,
    });
  });

  it('judges no row whose parent was refused, and says why', async () => {
    const target = fakeTarget((type) =>
      type === 'Account' ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION' : undefined,
    );
    const result = await rehearse(
      deps({
        prepare: preparing([
          { object: 'Account', rows: [{ Name: 'A' }] },
          {
            object: 'Contact',
            rows: [{ LastName: 'B' }, { LastName: 'C' }],
            parentField: 'AccountId',
          },
        ]),
        composite: target.composite,
      }),
    );
    expect(result).toMatchObject({ judged: 1, passed: 0, notJudged: 2, calls: 1 });
    expect(result.notJudgedWhy).toEqual([
      { objectApiName: 'Contact', rows: 2, reason: 'parent_refused' },
    ]);
  });

  it('sends again, with their parents, the rows of the requests after the one a call stopped at', async () => {
    const target = fakeTarget(lastNameRequired);
    const result = await rehearse(
      deps({
        prepare: preparing([
          { object: 'Account', rows: [{ Name: 'A' }, { Name: 'B' }] },
          {
            object: 'Contact',
            rows: [{ FirstName: 'no last name' }, { LastName: 'C' }],
            parentField: 'AccountId',
            parentIndex: (i) => i,
          },
          {
            object: 'Opportunity',
            rows: [{ Name: 'O' }],
            parentField: 'ContactId__c',
            parentIndex: () => 1,
          },
        ]),
        composite: target.composite,
      }),
    );
    // The first call stops at the contacts; the opportunity, never tried, goes
    // again with the contact and the account it names.
    expect(result.calls).toBe(2);
    expect(result).toMatchObject({ judged: 5, passed: 4, notJudged: 0, plannedCalls: 1 });
    const second = target.calls[1].compositeRequest;
    expect(second).toHaveLength(4);
    expect((second[2].body as { records: unknown[] }).records).toEqual([
      { attributes: { type: 'Opportunity' }, Name: 'O', ContactId__c: '@{rows1[0].id}' },
    ]);
  });

  it('stops before its next call once its signal is aborted: the call sent was rolled back whole', async () => {
    const target = fakeTarget(lastNameRequired);
    const controller = new AbortController();
    // Live Operations' Cancel, as the first call is under way.
    const composite = vi.fn(async (body: CompositeRequestBody) => {
      const answer = await target.composite(body);
      controller.abort();
      return answer;
    });
    const stopped = rehearse(
      deps({
        prepare: preparing([
          { object: 'Account', rows: [{ Name: 'A' }, { Name: 'B' }] },
          {
            object: 'Contact',
            rows: [{ FirstName: 'no last name' }, { LastName: 'C' }],
            parentField: 'AccountId',
            parentIndex: (i) => i,
          },
          {
            object: 'Opportunity',
            rows: [{ Name: 'O' }],
            parentField: 'ContactId__c',
            parentIndex: () => 1,
          },
        ]),
        composite,
        signal: controller.signal,
      }),
    );

    await expect(stopped).rejects.toBeInstanceOf(RehearsalCancelledError);
    await expect(stopped).rejects.toMatchObject({ calls: 1 });
    // Uncancelled, this rehearsal sends a second call (see above).
    expect(composite).toHaveBeenCalledTimes(1);
  });

  it('sends nothing, and asks nothing, once its signal is aborted before the first call', async () => {
    const target = fakeTarget(() => undefined);
    const confirm = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();

    await expect(
      rehearse(
        deps({
          prepare: preparing([{ object: 'Account', rows: [{ Name: 'A' }] }]),
          composite: target.composite,
          confirm,
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ calls: 0 });
    expect(confirm).not.toHaveBeenCalled();
    expect(target.composite).not.toHaveBeenCalled();
  });

  it('sends nothing to the target when the user declines', async () => {
    const target = fakeTarget(lastNameRequired);
    await expect(
      rehearse(
        deps({
          prepare: preparing([{ object: 'Account', rows: [{ Name: 'A' }] }]),
          composite: target.composite,
          confirm: async () => {
            throw new Error('declined');
          },
        }),
      ),
    ).rejects.toThrow('declined');
    expect(target.composite).not.toHaveBeenCalled();
  });

  it('stops, naming the records and counting them per object, at a call the target committed', async () => {
    const target = fakeTarget(() => undefined, true);
    const committed = rehearse(
      deps({
        prepare: preparing([
          { object: 'Account', rows: [{ Name: 'A' }] },
          {
            object: 'Contact',
            rows: [{ LastName: 'B' }, { LastName: 'C' }],
            parentField: 'AccountId',
          },
        ]),
        composite: target.composite,
      }),
    );
    await expect(committed).rejects.toBeInstanceOf(RehearsalNotRolledBackError);
    const error = (await committed.catch((e: unknown) => e)) as RehearsalNotRolledBackError;
    expect(error.ids).toHaveLength(3);
    expect(error.objects).toEqual([
      { objectApiName: 'Account', created: 1 },
      { objectApiName: 'Contact', created: 2 },
    ]);
  });

  it('asks nothing and sends nothing when the run creates no row', async () => {
    const target = fakeTarget(() => undefined);
    const confirm = vi.fn(async () => {});
    const result = await rehearse(
      deps({ prepare: async () => {}, composite: target.composite, confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(target.composite).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: 0, judged: 0, calls: 0, plannedCalls: 0 });
  });

  it('never sends an update of a record the target already held, and counts it not rehearsed', async () => {
    const target = fakeTarget(() => undefined);
    const result = await rehearse(
      deps({
        prepare: async (writer) => {
          await writer.insertRecords('target', 'Account', [{ Name: 'A' }]);
          await writer.updateRecords('target', 'Account', [
            { Id: '001000000000777AAA', Rating: 'Hot' },
            {},
          ]);
        },
        composite: target.composite,
      }),
    );
    expect(result).toMatchObject({
      updates: 2,
      updatesJudged: 0,
      updatesPassed: 0,
      updatesNotRehearsed: 2,
      calls: 1,
    });
    expect(target.calls[0].compositeRequest.map((sub) => sub.referenceId)).toEqual([
      'rows0',
      'rollback',
    ]);
  });

  describe('the updates the run makes after its inserts', () => {
    /** Two accounts, the first given the second as its parent once both exist, as a second pass does. */
    const parentAfterward =
      (more: Array<Record<string, unknown>> = []) =>
      async (writer: RehearsalWriter): Promise<void> => {
        const [first, second] = await writer.insertRecords('target', 'Account', [
          { Name: 'A' },
          { Name: 'B' },
        ]);
        await writer.updateRecords('target', 'Account', [
          { Id: first.id, ParentId: second.id },
          ...more.map((fields) => ({ Id: second.id, ...fields })),
        ]);
      };

    it('sends an update in the call that creates its record, after the inserts and before the rollback', async () => {
      const target = fakeTarget(() => undefined);
      const confirm = vi.fn(async () => {});
      const result = await rehearse(
        deps({ prepare: parentAfterward(), composite: target.composite, confirm }),
      );

      expect(result).toMatchObject({
        judged: 2,
        passed: 2,
        updates: 1,
        updatesJudged: 1,
        updatesPassed: 1,
        updatesNotRehearsed: 0,
        calls: 1,
        gaps: [],
      });
      const [call] = target.calls;
      expect(call.compositeRequest.map((sub) => sub.referenceId)).toEqual([
        'rows0',
        'update0',
        'rollback',
      ]);
      expect(call.compositeRequest[1]).toMatchObject({
        method: 'PATCH',
        url: '/services/data/v66.0/sobjects/Account/@{rows0[0].id}',
        body: { ParentId: '@{rows0[1].id}' },
        httpHeaders: { 'Sforce-Auto-Assign': 'FALSE' },
      });
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ updates: [{ objectApiName: 'Account', updates: 1 }] }),
      );
    });

    it('turns an update refused into a gap of its own, the rows it updates still saving', async () => {
      const target = fakeTarget(
        () => undefined,
        false,
        (_type, _id, fields) =>
          'ParentId' in fields ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION' : undefined,
      );
      const result = await rehearse(
        deps({ prepare: parentAfterward(), composite: target.composite }),
      );

      expect(result).toMatchObject({ judged: 2, passed: 2, updatesJudged: 1, updatesPassed: 0 });
      expect(result.gaps).toEqual([
        expect.objectContaining({
          id: forgeGapId(
            'rehearsal_update_refusal',
            'Account',
            'ParentId',
            undefined,
            'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          ),
          kind: 'rehearsal_update_refusal',
          severity: 'warning',
          source: 'rehearsal',
          value: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          rows: 1,
          decisions: ['exclude_object', 'ignore'],
        }),
      ]);
      // A real run sends a refused update no more: nothing says it writes it again.
      expect(result.gaps[0].detail).not.toHaveProperty('writtenWithoutTheField');
    });

    it('sends again, in a call of their own, the updates after one refused', async () => {
      const target = fakeTarget(
        () => undefined,
        false,
        (_type, _id, fields) => (fields['Rating'] === 'Cold' ? 'INVALID_RATING' : undefined),
      );
      const result = await rehearse(
        deps({
          prepare: parentAfterward([{ Rating: 'Cold' }, { Description: 'later' }]),
          composite: target.composite,
        }),
      );

      expect(result).toMatchObject({ updates: 3, updatesJudged: 3, updatesPassed: 2, calls: 2 });
      // The second call creates the rows again and sends the update the first never tried.
      const second = target.calls[1].compositeRequest;
      expect(second.map((sub) => sub.referenceId)).toEqual(['rows0', 'update0', 'rollback']);
      expect(second[1].body).toEqual({ Description: 'later' });
    });

    it('judges no update whose record was refused', async () => {
      const target = fakeTarget((_type, record) =>
        record['Name'] === 'B' ? 'REQUIRED_FIELD_MISSING' : undefined,
      );
      const result = await rehearse(
        deps({ prepare: parentAfterward(), composite: target.composite }),
      );

      expect(result).toMatchObject({ judged: 2, passed: 1, updatesJudged: 0 });
      expect(result.updatesNotRehearsed).toBe(1);
      expect(target.calls).toHaveLength(1);
    });

    it('judges one update per object and set of fields past 19, standing for the rest', async () => {
      const target = fakeTarget(
        () => undefined,
        false,
        () => 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      );
      const result = await rehearse(
        deps({
          prepare: async (writer) => {
            const accounts = await writer.insertRecords(
              'target',
              'Account',
              Array.from({ length: 25 }, (_, i) => ({ Name: `A${i}` })),
            );
            await writer.updateRecords(
              'target',
              'Account',
              accounts.map(({ id }) => ({ Id: id, Rating: 'Hot' })),
            );
          },
          composite: target.composite,
        }),
      );

      expect(result).toMatchObject({
        updates: 25,
        updatesJudged: 1,
        updatesNotRehearsed: 0,
        calls: 1,
      });
      expect(result.gaps[0].detail?.['rowsOfTheRun']).toBe(25);
    });

    it('carries no more updates in a call than its 25 subrequests hold, and sends the rest in another', async () => {
      const target = fakeTarget(() => undefined);
      const result = await rehearse(
        deps({
          prepare: async (writer) => {
            const accounts = await writer.insertRecords(
              'target',
              'Account',
              Array.from({ length: 25 }, (_, i) => ({ Name: `A${i}` })),
            );
            // Each of its own set of fields: no update stands for another.
            await writer.updateRecords(
              'target',
              'Account',
              accounts.map(({ id }, i) => ({ Id: id, [`Field${i}__c`]: 'x' })),
            );
          },
          composite: target.composite,
        }),
      );

      expect(result).toMatchObject({ updatesJudged: 25, updatesPassed: 25, plannedCalls: 2 });
      expect(target.calls.map((call) => call.compositeRequest.length)).toEqual([25, 4]);
    });
  });

  it('judges one row per shape when the run creates more than 200, standing for the rest', async () => {
    const target = fakeTarget(lastNameRequired);
    const contacts = Array.from({ length: 300 }, (_, i) =>
      i % 3 === 0 ? { FirstName: 'x' } : { LastName: 'y' },
    );
    const result = await rehearse(
      deps({
        prepare: preparing([{ object: 'Contact', rows: contacts }]),
        composite: target.composite,
      }),
    );
    expect(result).toMatchObject({ rows: 300, sampled: 2, judged: 2, passed: 1, calls: 1 });
    expect(result.gaps[0].detail?.['rowsOfTheRun']).toBe(100);
  });

  it('says where it is: waiting on the user with the calls planned, then each call', async () => {
    const target = fakeTarget(() => undefined);
    const progress: ForgeRehearsalProgress[] = [];
    await rehearse(
      deps({
        prepare: preparing([{ object: 'Account', rows: [{ Name: 'A' }] }]),
        composite: target.composite,
        onProgress: (p) => progress.push(p),
      }),
    );
    expect(progress).toEqual([
      { phase: 'confirming', calls: 1 },
      { phase: 'rehearsing', call: 1, calls: 1 },
    ]);
  });

  it('judges no row whose chain of parents is deeper than one call holds', async () => {
    const target = fakeTarget(() => undefined);
    const result = await rehearse(
      deps({
        prepare: async (writer) => {
          let parent: string | undefined;
          for (let i = 0; i < 6; i++) {
            const [{ id }] = await writer.insertRecords('target', 'Account', [
              parent ? { ParentId: parent } : { Name: 'root' },
            ]);
            parent = id;
          }
        },
        composite: target.composite,
      }),
    );
    expect(result).toMatchObject({ sampled: 6, judged: 5, passed: 5, notJudged: 1 });
    expect(result.notJudgedWhy).toEqual([
      { objectApiName: 'Account', rows: 1, reason: 'beyond_a_call' },
    ]);
  });
  describe('a row the target refuses for a record it holds', () => {
    /** The account the target already holds, under the external id the run's account carries. */
    const HELD = idOf('001000000000777');
    const heldAs =
      (message: string): Rule =>
      (type, record) =>
        type === 'Account' && record['Ext_Id__c'] === 'X-1'
          ? { statusCode: 'DUPLICATE_VALUE', message }
          : undefined;
    const accountAndContacts = preparing([
      { object: 'Account', rows: [{ Name: 'A', Ext_Id__c: 'X-1' }] },
      {
        object: 'Contact',
        rows: [{ LastName: 'B' }, { LastName: 'C' }],
        parentField: 'AccountId',
      },
    ]);

    it('counts it linked, as the run links it, and judges its children under the record named', async () => {
      const target = fakeTarget(
        heldAs(`duplicate value found: Ext_Id__c duplicates value on record with id: ${HELD}`),
      );
      const result = await rehearse(
        deps({ prepare: accountAndContacts, composite: target.composite }),
      );

      expect(result).toMatchObject({
        rows: 3,
        judged: 3,
        passed: 2,
        linked: 1,
        notJudged: 0,
        notJudgedWhy: [],
        calls: 2,
      });
      // The second call creates the contacts alone, under the account the target holds.
      const second = target.calls[1].compositeRequest;
      expect(second.map((sub) => sub.referenceId)).toEqual(['rows0', 'rollback']);
      expect((second[0].body as { records: unknown[] }).records).toEqual([
        { attributes: { type: 'Contact' }, LastName: 'B', AccountId: HELD },
        { attributes: { type: 'Contact' }, LastName: 'C', AccountId: HELD },
      ]);
      // A warning, as the simulation reports a unique value the target holds:
      // never a blocking refusal that would have the user hold the run back.
      expect(result.gaps).toEqual([
        expect.objectContaining({
          id: forgeGapId('unique_value_collision', 'Account'),
          kind: 'unique_value_collision',
          severity: 'warning',
          defaultDecision: 'ignore',
        }),
      ]);
    });

    it('reads the record a French org names, as the run does', async () => {
      const target = fakeTarget(
        heldAs(
          `valeur en double trouvée : Ext_Id__c duplique la valeur de l'enregistrement ` +
            `ID : ${HELD}`,
        ),
      );
      const result = await rehearse(
        deps({ prepare: accountAndContacts, composite: target.composite }),
      );

      expect(result).toMatchObject({ judged: 3, passed: 2, linked: 1, notJudged: 0 });
      expect(
        (target.calls[1].compositeRequest[0].body as { records: Array<{ AccountId: unknown }> })
          .records[0].AccountId,
      ).toBe(HELD);
    });

    it('stays a refusal that holds back its children when the refusal names no record', async () => {
      // Salesforce writes <unknown> where the running user cannot see the
      // record: the run's writer links nothing, and fails the row.
      const target = fakeTarget(
        heldAs('duplicate value found: Ext_Id__c duplicates value on record with id: <unknown>'),
      );
      const result = await rehearse(
        deps({ prepare: accountAndContacts, composite: target.composite }),
      );

      expect(result).toMatchObject({ judged: 1, passed: 0, linked: 0, notJudged: 2, calls: 1 });
      expect(result.notJudgedWhy).toEqual([
        { objectApiName: 'Contact', rows: 2, reason: 'parent_refused' },
      ]);
      expect(result.gaps[0]).toMatchObject({
        id: forgeGapId('rehearsal_refusal', 'Account', undefined, undefined, 'DUPLICATE_VALUE'),
        severity: 'blocking',
      });
    });

    it('stays a refusal when the record named is of another object', async () => {
      const target = fakeTarget(
        heldAs(
          `duplicate value found: Ext_Id__c duplicates value on record with id: ${idOf('003000000000777')}`,
        ),
      );
      const result = await rehearse(
        deps({ prepare: accountAndContacts, composite: target.composite }),
      );

      expect(result).toMatchObject({ judged: 1, linked: 0, notJudged: 2 });
    });

    it('links a row to the row of its call that holds the same value, and judges its children under that one', async () => {
      // Two accounts of the run carry one external id: the real run writes the
      // first, and links the second to it. The record the refusal names was
      // created by the call, and rolled back with it.
      const target = fakeTarget((type, record, created) => {
        if (type !== 'Account') return undefined;
        const twin = created.find((c) => c.record['Ext_Id__c'] === record['Ext_Id__c']);
        return twin
          ? {
              statusCode: 'DUPLICATE_VALUE',
              message: `duplicate value found: Ext_Id__c duplicates value on record with id: ${twin.id}`,
            }
          : undefined;
      });
      const result = await rehearse(
        deps({
          prepare: preparing([
            {
              object: 'Account',
              rows: [
                { Name: 'A', Ext_Id__c: 'X-1' },
                { Name: 'A again', Ext_Id__c: 'X-1' },
              ],
            },
            {
              object: 'Contact',
              rows: [{ LastName: 'B' }],
              parentField: 'AccountId',
              parentIndex: () => 1,
            },
          ]),
          composite: target.composite,
        }),
      );

      expect(result).toMatchObject({ judged: 3, passed: 2, linked: 1, notJudged: 0, calls: 2 });
      // The contact goes again with the first account, which it now hangs from.
      const second = target.calls[1].compositeRequest;
      expect(second.map((sub) => sub.referenceId)).toEqual(['rows0', 'rows1', 'rollback']);
      expect((second[0].body as { records: unknown[] }).records).toEqual([
        { attributes: { type: 'Account' }, Name: 'A', Ext_Id__c: 'X-1' },
      ]);
      expect((second[1].body as { records: unknown[] }).records).toEqual([
        { attributes: { type: 'Contact' }, LastName: 'B', AccountId: '@{rows0[0].id}' },
      ]);
    });

    it('sends no update of the record it is linked to, which the run never writes', async () => {
      const target = fakeTarget(
        heldAs(`duplicate value found: Ext_Id__c duplicates value on record with id: ${HELD}`),
      );
      const result = await rehearse(
        deps({
          prepare: async (writer) => {
            const [account] = await writer.insertRecords('target', 'Account', [
              { Name: 'A', Ext_Id__c: 'X-1' },
            ]);
            await writer.insertRecords('target', 'Contact', [
              { LastName: 'B', AccountId: account.id },
            ]);
            await writer.updateRecords('target', 'Account', [{ Id: account.id, Rating: 'Hot' }]);
          },
          composite: target.composite,
        }),
      );

      expect(result).toMatchObject({ judged: 2, linked: 1, updatesJudged: 0 });
      expect(result.updatesNotRehearsed).toBe(1);
      // The first call carried it, stopped at the account before it was
      // tried; the call that judges the contact carries it no more.
      expect(target.calls).toHaveLength(2);
      expect(target.calls[1].compositeRequest.map((sub) => sub.referenceId)).toEqual([
        'rows0',
        'rollback',
      ]);
    });
  });
});
