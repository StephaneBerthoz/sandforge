import { describe, it, expect, vi } from 'vitest';
import type { ForgeRehearsalProgress } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import type { RehearsalWriter } from './RehearsalWriter.js';
import type { CompositeRequestBody } from './compositeCalls.js';
import { RehearsalNotRolledBackError, rehearse, type RehearsalDeps } from './rehearse.js';

const PREFIX: Record<string, string> = { Account: '001', Contact: '003', Opportunity: '006' };

type Rule = (objectApiName: string, record: Record<string, unknown>) => string | undefined;

/**
 * A target that answers a composite call as the platform does, all or none:
 * each Collections request creates its rows one by one, a reference reads an
 * earlier request's new ids, and the first request that refuses a row stops
 * the call — it keeps its rows' verdicts, every other subrequest is stopped.
 * When no row is refused, every request is stopped and the closing update
 * fails on its own. `commits` makes the closing update succeed instead.
 */
function fakeTarget(rule: Rule, commits = false) {
  const calls: CompositeRequestBody[] = [];
  let next = 0;
  const halted = {
    body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }],
    httpStatusCode: 400,
  };
  const composite = vi.fn(async (body: CompositeRequestBody) => {
    calls.push(body);
    const results = new Map<string, Array<{ id?: string; success: boolean }>>();
    const collections = body.compositeRequest.slice(0, -1);
    const answers: unknown[] = [];
    let stoppedAt = -1;
    for (const [index, sub] of collections.entries()) {
      const records = (sub.body as { records: Array<Record<string, unknown>> }).records;
      const outcomes = records.map((record) => {
        const resolved: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(record)) {
          const ref =
            typeof value === 'string' ? /^@\{(rows\d+)\[(\d+)\]\.id\}$/.exec(value) : null;
          resolved[field] = ref ? results.get(ref[1])?.[Number(ref[2])]?.id : value;
        }
        const type = (record.attributes as { type: string }).type;
        const refusal = rule(type, resolved);
        return refusal
          ? { success: false, errors: [{ statusCode: refusal, message: refusal, fields: [] }] }
          : {
              id: `${PREFIX[type] ?? 'a0X'}${String(++next).padStart(15, '0')}`,
              success: true,
              errors: [],
            };
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

  it('stops, naming the records, at a call the target committed', async () => {
    const target = fakeTarget(() => undefined, true);
    await expect(
      rehearse(
        deps({
          prepare: preparing([{ object: 'Account', rows: [{ Name: 'A' }] }]),
          composite: target.composite,
        }),
      ),
    ).rejects.toBeInstanceOf(RehearsalNotRolledBackError);
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

  it('counts the updates the run makes after its inserts, which it does not send', async () => {
    const target = fakeTarget(() => undefined);
    const result = await rehearse(
      deps({
        prepare: preparing([{ object: 'Account', rows: [{ Name: 'A' }] }], 4),
        composite: target.composite,
      }),
    );
    expect(result.updatesNotRehearsed).toBe(4);
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
});
