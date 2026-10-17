import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autopilotCreated,
  changedRows,
  fieldsChecksum,
  frozenCreated,
  frozenLoadCounts,
  frozenPreviewCounts,
  idCount,
  postedError,
  postedOf,
  seedCreated,
  seedPlanned,
  seedWrittenAgain,
  soqlDate,
  windowAround,
} from './canary-steps.mjs';

const ACCOUNT_1 = '001000000000001AAA';
const CONTACT_1 = '003000000000001AAA';
const CONTACT_2 = '003000000000002AAA';
const CONTACT_3 = '003000000000003AAA';

test('reads the last message of a type among the ones a command posted', () => {
  const doc = {
    posted: [
      { type: 'frozen:select:progress', payload: { phase: 'axis' } },
      { type: 'frozen:select:response', payload: { selection: { combinations: [] } } },
      { type: 'frozen:select:response', payload: { selection: { combinations: [{}] } } },
    ],
  };
  assert.equal(postedOf(doc, 'frozen:select:response').payload.selection.combinations.length, 1);
  assert.equal(postedOf(doc, 'frozen:load:response'), undefined);
  assert.equal(postedOf(undefined, 'frozen:load:response'), undefined);
});

test('says the first error a command posted, with its code', () => {
  const doc = {
    posted: [
      { type: 'frozen:config:save:response', payload: {} },
      { type: 'frozen:load:error', payload: { message: 'The target refused it', code: 'GUARD' } },
      { type: 'dataops:error', payload: { message: 'later' } },
    ],
  };
  assert.equal(postedError(doc), 'frozen:load:error: The target refused it [GUARD]');
  assert.equal(postedError({ posted: [{ type: 'frozen:load:response' }] }), undefined);
});

test("maps a Frozen load's created records to their target ids, per object, in write order", () => {
  const created = frozenCreated({
    mapping: { 'acc-1': ACCOUNT_1, 'con-1': CONTACT_1, 'con-2': CONTACT_2, 'con-3': CONTACT_3 },
    created: [
      { objectApiName: 'Account', referenceIds: ['acc-1'] },
      { objectApiName: 'Contact', referenceIds: ['con-1', 'con-unmapped'] },
      { objectApiName: 'Contact', referenceIds: ['con-2'] },
      { objectApiName: 'Case', referenceIds: [] },
    ],
  });
  assert.deepEqual(
    [...created],
    [
      ['Account', [ACCOUNT_1]],
      ['Contact', [CONTACT_1, CONTACT_2]],
    ],
  );
  // con-3 was linked, not created: the removal leaves it, and so does the count.
  assert.equal(idCount(created), 3);
  assert.equal(frozenCreated(undefined).size, 0);
});

test('adds up what a Frozen dry run would insert, link and leave unsent', () => {
  assert.deepEqual(
    frozenPreviewCounts({
      perObject: [
        { fromFiles: 1, toInsert: 1, reusedByKeys: 0, reusedFromCatalog: 0, notSent: 0 },
        { fromFiles: 40, toInsert: 36, reusedByKeys: 2, reusedFromCatalog: 1, notSent: 1 },
      ],
    }),
    { fromFiles: 41, toInsert: 37, toLink: 3, notSent: 1 },
  );
});

test('tells a record a Frozen load held back for a refused parent from one the target refused', () => {
  const counts = frozenLoadCounts({
    perObject: [
      {
        objectApiName: 'Account',
        fromFiles: 2,
        inserted: 1,
        reused: 0,
        failed: [{ referenceId: 'acc-2', errors: ['REQUIRED_FIELD_MISSING: Name'] }],
      },
      {
        objectApiName: 'Contact',
        fromFiles: 5,
        inserted: 3,
        reused: 1,
        writtenWithoutFields: { rows: 2, fields: [] },
        failed: [
          {
            referenceId: 'con-5',
            errors: ['PARENT_REFUSED: the Account record its AccountId names was refused'],
          },
        ],
      },
      {
        objectApiName: 'Case',
        fromFiles: 1,
        inserted: 0,
        reused: 0,
        // Refused for itself as well: not held back.
        failed: [
          { referenceId: 'case-1', errors: ['PARENT_REFUSED: …', 'FIELD_CUSTOM_VALIDATION'] },
        ],
      },
    ],
  });
  assert.deepEqual(counts, {
    fromFiles: 8,
    inserted: 4,
    withoutFields: 2,
    linked: 1,
    refused: 2,
    heldBack: 1,
  });
});

test('counts what a Seed run planned per object, written and refused alike', () => {
  const result = {
    objectResults: [
      { objectApiName: 'Account', recordsCreated: 2, recordsFailed: 0, createdIds: [ACCOUNT_1] },
      {
        objectApiName: 'Contact',
        recordsCreated: 2,
        recordsFailed: 1,
        createdIds: [CONTACT_1, CONTACT_2],
      },
      { objectApiName: 'Case', recordsCreated: 0, recordsFailed: 0, createdIds: [] },
    ],
  };
  assert.deepEqual(seedPlanned(result), { Account: 2, Contact: 3, Case: 0 });
  assert.deepEqual(
    [...seedCreated(result)],
    [
      ['Account', [ACCOUNT_1]],
      ['Contact', [CONTACT_1, CONTACT_2]],
    ],
  );
});

test('reads the rows a Seed run wrote again without a refused field from its notes, not its refusals', () => {
  assert.equal(
    seedWrittenAgain({
      objectResults: [
        {
          objectApiName: 'Contact',
          errors: [
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX.',
            '3 record(s) written again without the fields the target refused them on: Phone.',
          ],
        },
        {
          objectApiName: 'Account',
          errors: ['1 record(s) written again without the fields the target refused them on: Fax.'],
        },
      ],
    }),
    4,
  );
  assert.equal(seedWrittenAgain({ objectResults: [{ errors: ['Unknown insert error'] }] }), 0);
});

test('reads the ids an Autopilot run printed, and leaves out an object it created nothing of', () => {
  const created = autopilotCreated({
    created: { Lead: [CONTACT_1, CONTACT_2], Account: [], Case: 'none' },
  });
  assert.deepEqual([...created], [['Lead', [CONTACT_1, CONTACT_2]]]);
  assert.equal(autopilotCreated({}).size, 0);
});

const FIELDS = ['FirstName', 'Email', 'Phone'];

test('gives the same checksum for the same values whatever order the rows come back in', () => {
  const rows = [
    { Id: CONTACT_2, FirstName: 'Ada', Email: 'ada@example.invalid', Phone: null },
    { Id: CONTACT_1, FirstName: 'Lin', Email: 'lin@example.invalid', Phone: '+33 6 39 98 00 01' },
  ];
  assert.equal(fieldsChecksum(rows, FIELDS), fieldsChecksum([...rows].reverse(), FIELDS));
  // An empty field reads as an absent one: a restore that writes back null is not a change.
  assert.equal(
    fieldsChecksum(rows, FIELDS),
    fieldsChecksum([{ ...rows[0], Phone: '' }, rows[1]], FIELDS),
  );
});

test('gives another checksum once a single value differs', () => {
  const rows = [{ Id: CONTACT_1, FirstName: 'Lin', Email: 'lin@example.invalid', Phone: null }];
  assert.notEqual(
    fieldsChecksum(rows, FIELDS),
    fieldsChecksum([{ ...rows[0], Email: 'masked@example.invalid' }], FIELDS),
  );
});

test('counts the rows whose values changed, by Id, on the named fields only', () => {
  const before = [
    { Id: CONTACT_1, FirstName: 'Lin', Email: 'lin@example.invalid', Department: 'tag' },
    { Id: CONTACT_2, FirstName: 'Ada', Email: 'ada@example.invalid', Department: 'tag' },
    { Id: CONTACT_3, FirstName: 'Eve', Email: 'eve@example.invalid', Department: 'tag' },
  ];
  const after = [
    { Id: CONTACT_1, FirstName: 'Nova', Email: 'lin@example.invalid', Department: 'tag' },
    { Id: CONTACT_2, FirstName: 'Ada', Email: 'ada@example.invalid', Department: 'other' },
    { Id: ACCOUNT_1, FirstName: 'Unknown', Email: 'x@example.invalid' },
  ];
  assert.equal(changedRows(before, after, FIELDS), 1);
});

test('widens a window around dates to whole seconds, as SOQL takes them', () => {
  assert.deepEqual(
    windowAround(
      ['2026-10-17T09:20:36.742Z', '2026-10-17T09:20:31.000Z', 'not a date'],
      1_000,
      1_000,
    ),
    { from: '2026-10-17T09:20:30Z', to: '2026-10-17T09:20:38Z' },
  );
  assert.equal(windowAround([], 1_000, 1_000), undefined);
  assert.equal(windowAround([undefined, 'never'], 1_000, 1_000), undefined);
  assert.equal(soqlDate(Date.parse('2026-10-17T09:20:36.742Z')), '2026-10-17T09:20:36Z');
});
