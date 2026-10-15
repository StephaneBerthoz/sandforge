import { describe, it, expect, vi } from 'vitest';
import type { ForgeConfig, ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';
import type { GraphDiscoveryService } from '../GraphDiscoveryService.js';
import { ForgeRehearser, type ForgeRehearserDeps } from './ForgeRehearser.js';
import type { CompositeRequestBody, CompositeSubrequest } from './compositeCalls.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A rehearsal of a clone of a person account. The platform writes the
 * account's contact itself as it takes the account; the run never sends that
 * contact, and links what names it to the one the platform wrote. Run on a
 * large client sandbox, the rehearsal sent it all the same: the target refused
 * it on its account (`Cannot select a person account`), and what hangs from
 * it was judged under that refusal.
 */

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
});
const readOnly = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: false,
  updateable: false,
  isReference: false,
});
const lookup = (name: string, target: string, settable = true): FieldInfo => ({
  name,
  queryable: true,
  createable: settable,
  updateable: settable,
  isReference: true,
  referenceTo: [target],
  nillable: true,
});

/** Both orgs' fields, as an org with person accounts describes them. */
const FIELDS: Record<string, FieldInfo[]> = {
  Account: [
    idField,
    text('Name'),
    text('LastName'),
    readOnly('IsPersonAccount'),
    lookup('PersonContactId', 'Contact', false),
  ],
  Contact: [idField, text('LastName'), lookup('AccountId', 'Account'), readOnly('IsPersonAccount')],
  Case: [idField, text('Subject'), lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
};

const PREFIX: Record<string, string> = { Account: '001', Contact: '003', Case: '500' };

/** A fake source id of `prefix` whose first twelve characters tell it apart. */
const fakeId = (prefix: string, n: number): string =>
  `${prefix}Fk${String(n).padStart(7, '0')}SrCIA`;

const PERSON = fakeId('001', 1);
const BUSINESS = fakeId('001', 2);
const PERSON_CONTACT = fakeId('003', 1);
const CONTACT = fakeId('003', 2);

/** A person account, a business account, the contact of each, the person's cases, the business contact's case. */
const SOURCE: Record<string, Record<string, unknown>[]> = {
  Account: [
    {
      Id: PERSON,
      Name: 'Jane Doe',
      LastName: 'Doe',
      IsPersonAccount: true,
      PersonContactId: PERSON_CONTACT,
    },
    { Id: BUSINESS, Name: 'Acme', LastName: null, IsPersonAccount: false, PersonContactId: null },
  ],
  Contact: [
    { Id: PERSON_CONTACT, LastName: 'Doe', AccountId: PERSON, IsPersonAccount: true },
    { Id: CONTACT, LastName: 'Roe', AccountId: BUSINESS, IsPersonAccount: false },
  ],
  Case: [
    { Id: fakeId('500', 1), Subject: 'Help', AccountId: PERSON, ContactId: PERSON_CONTACT },
    { Id: fakeId('500', 2), Subject: 'Again', AccountId: PERSON, ContactId: PERSON_CONTACT },
    { Id: fakeId('500', 3), Subject: 'Order', AccountId: BUSINESS, ContactId: CONTACT },
  ],
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 3,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const edge = (
  parent: string,
  child: string,
  relationshipName: string,
  more: Partial<ForgeGraphEdge> = {},
): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName,
  type: 'lookup',
  ...more,
});

/** The accounts, their contacts and their cases, the account's lookup at its contact one no write sets. */
const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1), node('Case', 2)],
  edges: [
    edge('Account', 'Contact', 'Contacts'),
    edge('Account', 'Case', 'Account'),
    edge('Contact', 'Case', 'Contact'),
    edge('Contact', 'Account', 'PersonContact', { settable: false }),
  ],
  totalRecords: 7,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: PERSON,
  depth: 'direct',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: true,
  batchSize: 'auto',
};

/** The run's reads: the source holds {@link SOURCE}; the target holds nothing, its writers never called. */
function reads(): ForgeExecutorDeps {
  return {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return (SOURCE[object] ?? []).map((row) => ({ ...row }));
    }),
    insertRecords: vi.fn(async () => {
      throw new Error('the run’s writer was called');
    }),
    updateRecords: vi.fn(async () => {
      throw new Error('the run’s writer was called');
    }),
    describeObject: vi.fn(async (_org: string, object: string) => ({
      keyPrefix: PREFIX[object] ?? null,
      recordTypes: [],
    })),
  };
}

/** An 18-character id of the object whose prefix starts `id15`. */
function idOf(id15: string): string {
  const id = canonicalRecordId(id15);
  if (id === undefined) throw new Error(`${id15} is no id`);
  return id;
}

const HALTED = {
  body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }],
  httpStatusCode: 400,
};

/**
 * A target with person accounts, answering a composite call as the platform
 * does: an account sent with a last name and no name is a person account, and
 * the platform writes its contact with it; a contact sent under a person
 * account is refused, as the platform refuses it; a read of an account gives
 * its contact; a reference reads an earlier subrequest's answer. The first
 * refusal stops the call; with none, the closing update fails on its own.
 */
function personAccountTarget() {
  const calls: CompositeRequestBody[] = [];
  let next = 0;
  const composite = vi.fn<ForgeRehearserDeps['composite']>(async (_org, body) => {
    calls.push(body);
    const answered = new Map<string, unknown>();
    const contactOf = new Map<string, string>();
    const resolve = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      const ref = /^@\{(\w+)(?:\[(\d+)\])?\.(\w+)\}$/.exec(value);
      if (!ref) return value;
      const [, name, index, field] = ref;
      const answer = answered.get(name);
      const at = index === undefined ? answer : (answer as unknown[] | undefined)?.[Number(index)];
      return (at as Record<string, unknown> | undefined)?.[field];
    };
    const answers: unknown[] = [];
    let stopped = -1;
    const subs = body.compositeRequest.slice(0, -1);
    for (const [index, sub] of subs.entries()) {
      if (sub.method === 'GET') {
        const [, account = ''] = /\/sobjects\/Account\/([^?]+)\?/.exec(sub.url) ?? [];
        const id = String(resolve(account));
        const read = { Id: id, PersonContactId: contactOf.get(id) ?? null };
        answered.set(sub.referenceId, read);
        answers.push({ body: read, httpStatusCode: 200, referenceId: sub.referenceId });
        continue;
      }
      const records = (sub.body as { records: Array<Record<string, unknown>> }).records;
      const outcomes = records.map((record) => {
        const type = (record.attributes as { type: string }).type;
        const fields: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(record)) fields[field] = resolve(value);
        if (type === 'Contact' && contactOf.has(String(fields['AccountId']))) {
          return {
            success: false,
            errors: [
              {
                statusCode: 'INVALID_CROSS_REFERENCE_KEY',
                message: 'Cannot select a person account',
                fields: ['AccountId'],
              },
            ],
          };
        }
        const id = idOf(`${PREFIX[type]}${String(++next).padStart(12, '0')}`);
        if (type === 'Account' && typeof fields['LastName'] === 'string' && !('Name' in fields)) {
          contactOf.set(id, idOf(`003${String(++next).padStart(12, '0')}`));
        }
        return { id, success: true, errors: [] };
      });
      answered.set(sub.referenceId, outcomes);
      if (outcomes.some((outcome) => !outcome.success)) {
        stopped = index;
        answers.push({ body: outcomes, httpStatusCode: 200, referenceId: sub.referenceId });
        break;
      }
      answers.push(HALTED);
    }
    while (answers.length < subs.length) answers.push(HALTED);
    if (stopped !== -1) {
      for (let i = 0; i < stopped; i++) answers[i] = HALTED;
      answers.push(HALTED);
    } else {
      answers.push({
        body: [{ errorCode: 'NOT_FOUND', message: 'not found' }],
        httpStatusCode: 404,
      });
    }
    return { compositeResponse: answers };
  });
  return { composite, calls };
}

function rehearser(composite: ForgeRehearserDeps['composite'], run = reads()) {
  return new ForgeRehearser({
    reads: run,
    discoveryService: { personalFields: vi.fn(() => []) } as unknown as GraphDiscoveryService,
    composite,
    apiPath: async () => '/services/data/v66.0',
  });
}

/** Each record a call created, with its object and the values sent. */
function recordsSent(calls: readonly CompositeRequestBody[]): Array<Record<string, unknown>> {
  return calls.flatMap((call) =>
    call.compositeRequest
      .filter((sub: CompositeSubrequest) => sub.method === 'POST')
      .flatMap((sub) => (sub.body as { records: Array<Record<string, unknown>> }).records),
  );
}

describe('a rehearsal of a clone of a person account', () => {
  it('leaves the person account’s contact to the platform, and judges what names it under the contact the platform wrote', async () => {
    const target = personAccountTarget();

    const result = await rehearser(target.composite).rehearse(GRAPH, CONFIG, {
      confirm: async () => {},
    });

    const sent = recordsSent(target.calls);
    // The person's contact is never sent: the business account's is.
    expect(sent.filter((r) => (r.attributes as { type: string }).type === 'Contact')).toEqual([
      expect.objectContaining({ LastName: 'Roe' }),
    ]);
    // The person's cases name the contact the call read back once the
    // account was in.
    const cases = sent.filter((r) => (r.attributes as { type: string }).type === 'Case');
    const onThePerson = cases.filter((r) => r['Subject'] !== 'Order');
    expect(onThePerson).toHaveLength(2);
    for (const row of onThePerson) {
      expect(String(row['ContactId'])).toMatch(/^@\{contact\d+\.PersonContactId\}$/);
    }
    const [call] = target.calls;
    const read = call.compositeRequest.find((sub) => sub.method === 'GET');
    expect(read?.url).toMatch(
      /^\/services\/data\/v66\.0\/sobjects\/Account\/@\{rows\d+\[\d+\]\.id\}\?fields=PersonContactId$/,
    );
    // Every row judged, none held back under a refusal no run meets.
    expect(result.notJudgedWhy).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result).toMatchObject({ rows: 6, judged: 6, passed: 6 });
  });

  it('reads the contact after the request that creates the account, and before the one that names it', async () => {
    const target = personAccountTarget();

    await rehearser(target.composite).rehearse(GRAPH, CONFIG, { confirm: async () => {} });

    const refs = target.calls[0].compositeRequest.map((sub) => sub.referenceId);
    const read = refs.findIndex((ref) => ref.startsWith('contact'));
    const accountRequest = target.calls[0].compositeRequest.findIndex(
      (sub) =>
        sub.method === 'POST' &&
        (sub.body as { records: Array<{ attributes: { type: string } }> }).records.some(
          (r) => r.attributes.type === 'Account',
        ),
    );
    const caseRequest = target.calls[0].compositeRequest.findIndex(
      (sub) =>
        sub.method === 'POST' &&
        (sub.body as { records: Array<{ attributes: { type: string } }> }).records.some(
          (r) => r.attributes.type === 'Case',
        ),
    );
    expect(read).toBeGreaterThan(accountRequest);
    expect(read).toBeLessThan(caseRequest);
    expect(refs[refs.length - 1]).toBe('rollback');
  });

  it('sends the contact of an account the target takes as a business one, as the run does', async () => {
    const run = reads();
    // The target describes no person accounts: the run writes the person as a
    // business account, and its contact as a contact of its own.
    vi.mocked(run.describeFields).mockImplementation(async (org: string, object: string) =>
      org === 'tgt' && object === 'Account'
        ? FIELDS.Account.filter((f) => f.name !== 'PersonContactId')
        : (FIELDS[object] ?? [idField]),
    );
    const target = personAccountTarget();

    const result = await rehearser(target.composite, run).rehearse(GRAPH, CONFIG, {
      confirm: async () => {},
    });

    const sent = recordsSent(target.calls);
    expect(
      sent
        .filter((r) => (r.attributes as { type: string }).type === 'Contact')
        .map((r) => r['LastName'])
        .sort(),
    ).toEqual(['Doe', 'Roe']);
    expect(target.calls.flatMap((c) => c.compositeRequest).some((s) => s.method === 'GET')).toBe(
      false,
    );
    expect(result.notJudgedWhy).toEqual([]);
  });
});
