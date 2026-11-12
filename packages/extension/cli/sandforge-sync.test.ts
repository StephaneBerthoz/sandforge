import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Connection } from 'jsforce';
import {
  parseArgs,
  buildConfig,
  buildQueryFn,
  cliFileDeps,
  contactPointLines,
  deltaLine,
  objectCountsLine,
  objectCurrencyLines,
  objectErrorLines,
  objectPriceLines,
  objectWrittenLines,
  readSavedConfig,
  recordTypeGivenOfObjectsLines,
  simulationLines,
  writeCheckLines,
} from './sandforge-sync.js';
import type { RecordTypeGiven } from '@sandforge/shared';
import { gateSyncWrite, measureSyncWrite } from '../src/modules/sync/SyncRunGate.js';

describe('what a run prints of an object', () => {
  it('prints the first refusals, and every line on what it held back', () => {
    const refusal = 'REQUIRED_FIELD_MISSING: Required fields are missing: [Region__c]';
    const held =
      'PARENT_REFUSED: 4 Contact records held back, not sent: the Account record their ' +
      'AccountId names was refused in this run, and written without it they would stand ' +
      'without their Account.';

    expect(objectErrorLines([refusal, refusal, refusal, refusal, refusal, held])).toEqual([
      refusal,
      refusal,
      refusal,
      held,
    ]);
  });

  it('counts the contact roles linked to the ones the platform wrote as linked, not skipped, as its line under it says', () => {
    // On a scratch org: "OpportunityContactRole: 0 processed, 0 succeeded, 0
    // failed, 1 skipped", over "1 record(s) linked to the contact role the
    // platform wrote with their opportunity".
    expect(
      objectCountsLine({
        objectApiName: 'OpportunityContactRole',
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 1,
        writtenByThePlatform: { records: 1, given: 1 },
      }),
    ).toBe('OpportunityContactRole: 0 processed, 0 succeeded, 0 failed, 0 skipped, 1 linked');
    // What an earlier run copied stays skipped beside them.
    expect(
      objectCountsLine({
        objectApiName: 'OpportunityContactRole',
        processed: 2,
        success: 2,
        failed: 0,
        skipped: 3,
        writtenByThePlatform: { records: 2, given: 2 },
      }),
    ).toBe('OpportunityContactRole: 2 processed, 2 succeeded, 0 failed, 1 skipped, 2 linked');
    expect(
      objectCountsLine({
        objectApiName: 'Account',
        processed: 1,
        success: 1,
        failed: 0,
        skipped: 0,
      }),
    ).toBe('Account: 1 processed, 1 succeeded, 0 failed, 0 skipped');
  });

  it('counts the records linked to one the target holds as a duplicate as linked, not skipped, as its line under it says', () => {
    // The target refused the account "DUPLICATE_VALUE: duplicate value found:
    // Ext_Id__c duplicates value on record with id: <its id>", and the run
    // linked it: the line read "1 processed, 0 succeeded, 0 failed, 1
    // skipped" over "1 record(s) linked to a record the target holds".
    expect(
      objectCountsLine({
        objectApiName: 'Account',
        processed: 3,
        success: 2,
        failed: 0,
        skipped: 1,
        linkedToExisting: { records: 1, refusal: 'DUPLICATE_VALUE: duplicate value found' },
      }),
    ).toBe('Account: 3 processed, 2 succeeded, 0 failed, 0 skipped, 1 linked');
    // Beside the contact roles the platform wrote, and what an earlier run copied.
    expect(
      objectCountsLine({
        objectApiName: 'OpportunityContactRole',
        processed: 2,
        success: 1,
        failed: 0,
        skipped: 4,
        linkedToExisting: { records: 1 },
        writtenByThePlatform: { records: 2, given: 2 },
      }),
    ).toBe('OpportunityContactRole: 2 processed, 1 succeeded, 0 failed, 1 skipped, 3 linked');
  });

  it('prints the contact roles linked to the ones the platform wrote with their opportunity, and what an update gave them', () => {
    expect(objectWrittenLines({ writtenByThePlatform: { records: 2, given: 2 } })).toEqual([
      '2 record(s) linked to the contact role the platform wrote with their opportunity, for ' +
        "its contact, not written; 2 given the source's fields they lacked.",
    ]);
    expect(
      objectWrittenLines({
        writtenByThePlatform: {
          records: 2,
          given: 1,
          refusal: '00KTGT000000001AAA: FIELD_CUSTOM_VALIDATION_EXCEPTION: A role needs a reason',
        },
      }),
    ).toEqual([
      '2 record(s) linked to the contact role the platform wrote with their opportunity, for ' +
        "its contact, not written; 1 given the source's fields it lacked, the others left as " +
        'the platform wrote them (00KTGT000000001AAA: FIELD_CUSTOM_VALIDATION_EXCEPTION: A role ' +
        'needs a reason).',
    ]);
  });

  it('prints the records written again without a field, given a lookup later or left without one, apart from its refusals', () => {
    expect(
      objectWrittenLines({
        writtenWithoutFields: {
          rows: 2,
          fields: [
            {
              field: 'Phone',
              refusedBy: 'validation-rule',
              reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be French.',
              rows: 2,
            },
          ],
        },
        lookupsSetAfter: { records: 3, fields: ['Primary_Contact__c'], after: ['Contact'] },
        lookupsLeftOut: [
          { records: 1, fields: ['Primary_Contact__c'], reason: 'parentRefused' },
          {
            records: 1,
            fields: ['ParentId'],
            reason: 'notSet',
            refusal: 'FIELD_INTEGRITY_EXCEPTION: parent loop',
          },
          { records: 2, fields: ['ParentId'], reason: 'notReached' },
        ],
      }),
    ).toEqual([
      '1 record(s) written without Primary_Contact__c: the record it names, written after ' +
        'them, was refused in this run.',
      '1 record(s) written without ParentId: the target refused setting it once the record it ' +
        'names was written (FIELD_INTEGRITY_EXCEPTION: parent loop).',
      '2 record(s) written without ParentId: the run was stopped before it was set, once the ' +
        'record it names was written.',
      '3 record(s) given Primary_Contact__c by a second write once Contact was written: the ' +
        'objects name each other, and no order writes both first.',
      '2 record(s) written again without the fields the target refused them on:',
      '  2 without Phone: a validation rule of the target refused it, ' +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be French.',
    ]);
  });

  it('prints the records linked to one the target holds, and those written without a lookup, apart from its refusals', () => {
    expect(
      objectWrittenLines({
        linkedToExisting: {
          records: 2,
          refusal: 'DUPLICATE_VALUE: duplicate value found: Code__c',
        },
        lookupsLeftOut: [
          { records: 3, fields: ['OwnerId'], reason: 'notInTarget' },
          { records: 4, fields: ['OwnerId'], reason: 'ownerRefusedEarlier' },
        ],
      }),
    ).toEqual([
      '2 record(s) linked to a record the target holds, not written: the target refused them ' +
        'as a duplicate of it (DUPLICATE_VALUE: duplicate value found: Code__c); what the run ' +
        'writes under them points at that record.',
      '3 record(s) written without OwnerId: the lookup held an id from the source org that the ' +
        'target does not have.',
      '4 record(s) written without OwnerId, left out from the start: the target refused the ' +
        'same owner earlier in this run, an id from the source org that the target does not have.',
    ]);
    expect(objectWrittenLines({})).toEqual([]);
  });

  it('names an owner the target holds inactive as what refused a record written again without it', () => {
    // Sync does not ask for this refusal itself; the line still names it when
    // a result carries it, as every refusal a written-again record can carry.
    expect(
      objectWrittenLines({
        writtenWithoutFields: {
          rows: 2,
          fields: [
            {
              field: 'OwnerId',
              rows: 2,
              refusedBy: 'inactive-owner',
              reason: 'INACTIVE_OWNER_OR_USER: operation performed with inactive user',
            },
          ],
        },
      }),
    ).toEqual([
      '2 record(s) written again without the fields the target refused them on:',
      '  2 without OwnerId: the target holds the owner it names inactive, ' +
        'INACTIVE_OWNER_OR_USER: operation performed with inactive user',
    ]);
  });

  it('prints once for the run what it did with the emails and phone numbers it wrote', () => {
    expect(
      contactPointLines({
        neutralized: true,
        fields: [{ objectApiName: 'Contact', field: 'Email', kind: 'email', values: 12 }],
        values: 12,
      }),
    ).toEqual([
      'emails and phone numbers: 12 value(s) in 1 field(s) neutralized, addresses under ' +
        ".invalid and numbers fictional, so what the target's automation sends to them reaches no one",
      '  Contact.Email  12',
    ]);
    expect(contactPointLines({ neutralized: false, fields: [], values: 0 })).toEqual([
      "emails and phone numbers: written as read (--keep-contact-points): the target's " +
        'automation may have emailed or texted the people the records name',
    ]);
    expect(contactPointLines(undefined)).toEqual([]);
  });

  it('prints every row it sent in another currency, apart from its refusals', () => {
    expect(
      objectCurrencyLines([
        {
          objectApiName: 'Opportunity',
          from: 'GBP',
          to: 'USD',
          chosenBy: 'corporate',
          rows: 1,
          fields: ['Amount'],
          datedBy: 'CloseDate',
        },
      ]),
    ).toEqual([
      "1 row(s) in GBP written in USD, the target's corporate currency, GBP not being active " +
        "there: amounts converted at the source's rates, dated by CloseDate (Amount).",
    ]);
    expect(objectCurrencyLines(undefined)).toEqual([]);
  });

  it('prints the prices it read in a currency the target lacks, apart from its refusals', () => {
    expect(
      objectPriceLines([{ from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 4 }]),
    ).toEqual([
      "4 GBP → USD: price(s) in a currency the target does not hold active replaced by the source's " +
        'own price in the currency written, for the same product and price book.',
    ]);
    expect(objectPriceLines(undefined)).toEqual([]);
  });

  it('prints the standard price book matched among those lines, not among its refusals', () => {
    expect(objectPriceLines(undefined, true)).toEqual([
      "The standard price book is matched to the target org's, never written.",
    ]);
  });
});

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-sync.ts', ...args];
}

const MINIMAL = ['--source', 'SRC', '--target', 'TGT', '--object', 'Account'];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run `parseArgs` on a line that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads the three things a run cannot do without', () => {
    const args = parseArgs(argv(...MINIMAL));
    expect(args.source).toBe('SRC');
    expect(args.target).toBe('TGT');
    expect(args.objects).toEqual([{ objectApiName: 'Account', externalIdField: undefined }]);
  });

  it('keeps the objects in the order they were given, which is the insert order', () => {
    const args = parseArgs(
      argv('--source', 'S', '--target', 'T', '--object', 'Account', '--object', 'Contact'),
    );
    expect(args.objects.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
  });

  it('reads an external Id off the object', () => {
    const args = parseArgs(
      argv('--source', 'S', '--target', 'T', '--object', 'Account:External_Id__c'),
    );
    expect(args.objects[0].externalIdField).toBe('External_Id__c');
  });

  it('refuses a line with nothing to sync', () => {
    expect(refuse('--source', 'S', '--target', 'T').code).toBe(2);
  });

  it('refuses an object name that is not one', () => {
    const { code, message } = refuse('--source', 'S', '--target', 'T', '--object', 'Account; DROP');
    expect(code).toBe(2);
    expect(message).toContain('Account; DROP');
  });

  it('refuses an object the panel refuses — User, a history, a file — before contacting any org', () => {
    for (const object of ['User', 'AccountHistory', 'ContentVersion']) {
      const { code, message } = refuse('--source', 'S', '--target', 'T', '--object', object);
      expect(code).toBe(2);
      expect(message).toContain(object);
    }
    expect(
      parseArgs(argv('--source', 'S', '--target', 'T', '--object', 'vlocity_ins__Party__c'))
        .objects,
    ).toHaveLength(1);
  });

  it('refuses a field name that is not one', () => {
    expect(refuse('--source', 'S', '--target', 'T', '--object', 'Account:9bad').code).toBe(2);
  });

  it('refuses an operation it cannot perform', () => {
    expect(refuse(...MINIMAL, '--operation', 'truncate').code).toBe(2);
  });

  it('refuses a where clause with no object in front of it', () => {
    expect(refuse(...MINIMAL, '--where', 'BillingCity = 42').code).toBe(2);
  });

  it('refuses a batch size outside what a write accepts', () => {
    expect(refuse(...MINIMAL, '--batch-size', '0').code).toBe(2);
    expect(refuse(...MINIMAL, '--batch-size', '50000').code).toBe(2);
    expect(refuse(...MINIMAL, '--batch-size', 'lots').code).toBe(2);
  });

  it('keeps the whole clause, equals signs and all', () => {
    const args = parseArgs(argv(...MINIMAL, '--where', "Account=Name = 'A=B'"));
    expect(args.where.Account).toBe("Name = 'A=B'");
  });
});

describe('a saved configuration on the command line', () => {
  /** A delta configuration of accounts, as the panel saves one. */
  const saved = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'cfg-accounts',
    name: 'Accounts',
    description: '',
    sourceOrgId: '00D000000000001AAA',
    targetOrgId: '00D000000000002AAA',
    direction: 'source_to_target',
    mode: 'delta',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        externalIdField: 'Ext_Id__c',
        where: "Ext_Id__c LIKE 'X-%'",
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [{ fieldApiName: 'Region__c', value: 'EU', overwriteExisting: true }],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    files: { maxFileSizeMB: 10, maxRunMB: 100 },
    ...overrides,
  });

  it('reads the file, the store and the two orgs, and nothing a file carries itself', () => {
    const args = parseArgs(
      argv('--config-file', 'cfg.json', '--store', 'state', '--source', 'S', '--target', 'T'),
    );
    expect(args).toMatchObject({
      configFile: 'cfg.json',
      store: 'state',
      source: 'S',
      target: 'T',
    });
    expect(args.objects).toEqual([]);
  });

  it('refuses a configuration without a store, and the settings the file carries beside it', () => {
    expect(refuse('--config-file', 'cfg.json', '--source', 'S', '--target', 'T').code).toBe(2);
    const mixed = refuse('--config-file', 'cfg.json', '--store', 'state', ...MINIMAL, '--files');
    expect(mixed.code).toBe(2);
    expect(mixed.message).toContain('--object, --files cannot be given with it');
  });

  it('refuses a store with no configuration to keep', () => {
    const { code, message } = refuse(...MINIMAL, '--store', 'state');
    expect(code).toBe(2);
    expect(message).toContain('give it with --config-file');
  });

  it('runs the configuration between the orgs of the line, with its own settings', () => {
    const read = readSavedConfig(JSON.stringify(saved()), { source: 'S', target: 'T' });
    if (!('config' in read)) throw new Error(read.refusal);
    expect(read.config).toMatchObject({
      id: 'cfg-accounts',
      sourceOrgId: 'S',
      targetOrgId: 'T',
      mode: 'delta',
      files: { maxFileSizeMB: 10, maxRunMB: 100 },
      objects: [
        {
          objectApiName: 'Account',
          externalIdField: 'Ext_Id__c',
          batchSize: 200,
          addOnFields: [{ fieldApiName: 'Region__c', value: 'EU', overwriteExisting: true }],
        },
      ],
    });
  });

  it('refuses what the panel refuses, and a configuration with no id to keep it under', () => {
    const orgs = { source: 'S', target: 'T' };
    expect(readSavedConfig('{', orgs)).toEqual({
      refusal: 'is not JSON: give a Sync configuration as the panel saves one.',
    });
    expect(readSavedConfig('[]', orgs)).toMatchObject({
      refusal: expect.stringContaining('no object'),
    });
    const inserting = saved();
    (inserting.objects as Array<Record<string, unknown>>)[0].operation = 'insert';
    expect(readSavedConfig(JSON.stringify(inserting), orgs)).toMatchObject({
      refusal: expect.stringContaining('objects.0.operation: A delta sync writes Account again'),
    });
    expect(readSavedConfig(JSON.stringify(saved({ id: undefined })), orgs)).toMatchObject({
      refusal: expect.stringContaining('names no id'),
    });
  });

  it('says how each object of a delta configuration was read, and whether its watermark moved', () => {
    expect(
      deltaLine({
        read: 'delta',
        since: '2026-10-14T08:00:00.000Z',
        changed: 2,
        deletionsChecked: false,
        deleted: 0,
        deleteFailed: 0,
        recorded: '2026-10-14T09:00:00.000Z',
      }),
    ).toBe('delta: 2 record(s) changed since 2026-10-14T08:00:00.000Z; watermark recorded');
    expect(
      deltaLine({
        read: 'full',
        reason: 'first_run',
        changed: 5,
        deletionsChecked: false,
        deleted: 0,
        deleteFailed: 0,
      }),
    ).toBe(
      'delta: read whole (first_run), 5 record(s); watermark kept as it was: the next run ' +
        'reads from the same point',
    );
  });

  it('says why the watermark of an object stayed when the run left lookups it was to set', () => {
    expect(
      deltaLine({
        read: 'delta',
        since: '2026-10-14T08:00:00.000Z',
        changed: 2,
        deletionsChecked: false,
        deleted: 0,
        deleteFailed: 0,
        lookupsOwed: 1,
      }),
    ).toBe(
      'delta: 2 record(s) changed since 2026-10-14T08:00:00.000Z; watermark kept as it was: ' +
        'the next run reads from the same point, 1 record(s) left without a lookup this run ' +
        'was to set among them',
    );
  });
});

describe('buildConfig', () => {
  it('neutralizes emails and phone numbers unless --keep-contact-points is given', () => {
    // Absent, the run neutralizes them, as the panel's run does.
    expect('keepContactPoints' in buildConfig(parseArgs(argv(...MINIMAL)))).toBe(false);
    expect(
      buildConfig(parseArgs(argv(...MINIMAL, '--keep-contact-points'))).keepContactPoints,
    ).toBe(true);
  });

  it('numbers the objects so they are written in the order asked for', () => {
    const config = buildConfig(
      parseArgs(
        argv('--source', 'S', '--target', 'T', '--object', 'Account', '--object', 'Contact'),
      ),
    );
    expect(config.objects.map((o) => o.insertOrder)).toEqual([0, 1]);
  });

  it('turns an object with an external Id into an upsert, whatever --operation said', () => {
    const config = buildConfig(
      parseArgs(
        argv(
          '--source',
          'S',
          '--target',
          'T',
          '--object',
          'Account:External_Id__c',
          '--operation',
          'insert',
        ),
      ),
    );
    // Naming a match key and then not matching on it would be two settings
    // disagreeing about the same thing.
    expect(config.objects[0].operation).toBe('upsert');
    expect(config.objects[0].externalIdField).toBe('External_Id__c');
  });

  it('leaves an object without one on the operation that was asked for', () => {
    const config = buildConfig(parseArgs(argv(...MINIMAL, '--operation', 'update')));
    expect(config.objects[0].operation).toBe('update');
  });

  it('puts each where clause on its own object and nowhere else', () => {
    const config = buildConfig(
      parseArgs(
        argv(
          '--source',
          'S',
          '--target',
          'T',
          '--object',
          'Account',
          '--object',
          'Contact',
          '--where',
          "Account=BillingCountry = 'France'",
        ),
      ),
    );
    expect(config.objects[0].where).toBe("BillingCountry = 'France'");
    expect(config.objects[1].where).toBeUndefined();
  });

  it('names the orgs the run is between', () => {
    const config = buildConfig(parseArgs(argv(...MINIMAL)));
    expect(config.sourceOrgId).toBe('SRC');
    expect(config.targetOrgId).toBe('TGT');
    expect(config.direction).toBe('source_to_target');
  });

  it("copies no file unless asked, and then with the panel's caps", () => {
    expect(buildConfig(parseArgs(argv(...MINIMAL))).files).toBeUndefined();
    expect(buildConfig(parseArgs(argv(...MINIMAL, '--files'))).files).toEqual({
      maxFileSizeMB: 10,
      maxRunMB: 100,
    });
  });
});

describe('the files a run copies', () => {
  /** A connection that answers every query with `rows`, and records what it was asked. */
  function conn(rows: Array<Record<string, unknown>>, asked: string[]): Connection {
    return {
      query: vi.fn(async (q: string) => {
        asked.push(q);
        return { records: rows, done: true, totalSize: rows.length };
      }),
      queryMore: vi.fn(),
    } as unknown as Connection;
  }

  it("asks for the ids an object's read returns, with its filter, from the source", async () => {
    const asked: string[] = [];
    const deps = cliFileDeps(
      { sourceOrgId: 'SRC', targetOrgId: 'TGT' },
      conn([{ Id: '006000000000001AAA' }], asked),
      conn([], []),
    );

    const ids = await deps.sourceIds({
      objectApiName: 'Opportunity',
      operation: 'insert',
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      batchSize: 200,
      insertOrder: 0,
      where: "Name LIKE 'SR%'",
    });

    expect(ids).toEqual(['006000000000001AAA']);
    expect(asked).toEqual(["SELECT Id FROM Opportunity WHERE Name LIKE 'SR%'"]);
  });

  it('keeps which file it copied where for the run alone', () => {
    const deps = cliFileDeps(
      { sourceOrgId: 'SRC', targetOrgId: 'TGT' },
      conn([], []),
      conn([], []),
    );
    expect(deps.store.load('cli-1')).toEqual({ kind: 'none' });

    const entry = {
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      objectApiName: 'Opportunity',
      kind: 'document' as const,
      sourceId: '069000000000001AAA',
      targetId: '069000000000009AAA',
      linked: [],
      copiedAt: '2026-10-14T08:00:00.000Z',
    };
    deps.store.record('cli-1', entry);
    deps.store.record('cli-1', { ...entry, targetId: '069000000000008AAA' });

    expect(deps.store.load('cli-1')).toEqual({
      kind: 'stored',
      map: { version: 1, entries: [{ ...entry, targetId: '069000000000008AAA' }] },
    });
  });
});

describe('the read of an object', () => {
  it('reads every page of the fields it names from the describe, never asking FIELDS(ALL)', async () => {
    // Asked by name, with no LIMIT, the fields come 2 000 records at most at
    // a time with a cursor to the rest: the command read the first page and
    // synced the object short. Asked FIELDS(ALL) with no LIMIT first, the org
    // refused the read every time.
    const NEXT = '/services/data/v66.0/query/01g000000000001-2000';
    const conn = {
      query: vi.fn(async (soql: string) => {
        if (soql.includes('FIELDS(ALL)')) throw new Error('MALFORMED_QUERY: FIELDS not supported');
        return { records: [{ Id: '001000000000001AAA' }], done: false, nextRecordsUrl: NEXT };
      }),
      queryMore: vi.fn().mockResolvedValue({ records: [{ Id: '001000000000002AAA' }], done: true }),
      sobject: () => ({
        describe: async () => ({
          fields: [
            { name: 'Id', type: 'id' },
            { name: 'Name', type: 'string' },
            { name: 'BillingAddress', type: 'address' },
          ],
        }),
      }),
    };
    const [account] = buildConfig(parseArgs(argv(...MINIMAL))).objects;

    const rows = await buildQueryFn(conn as unknown as Connection)('SRC', account);

    expect(conn.query.mock.calls).toEqual([['SELECT Id, Name FROM Account']]);
    expect(conn.queryMore).toHaveBeenCalledWith(NEXT);
    expect(rows).toEqual([{ Id: '001000000000001AAA' }, { Id: '001000000000002AAA' }]);
  });

  it('reads every field of an object too wide to name them in one query, within the URL', async () => {
    // Named in one statement, 700 fields make a URL the org refuses (414).
    const fields = [
      'Id',
      ...Array.from({ length: 700 }, (_, i) => `Custom_Field_${String(i).padStart(3, '0')}__c`),
    ];
    const ids = Array.from({ length: 300 }, (_, i) => `001${String(i).padStart(12, '0')}AAA`);
    const conn = {
      query: vi.fn(async (soql: string) => {
        if (encodeURIComponent(soql).length > 15_400)
          throw new Error('ERROR_HTTP_414: URI Too Long');
        const named = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
        const asked = new Set([...soql.matchAll(/'(001\d{12}AAA)'/g)].map((m) => m[1]));
        const records = ids
          .filter((id) => asked.size === 0 || asked.has(id))
          .map((Id) => Object.fromEntries(named.map((name) => [name, name === 'Id' ? Id : 'v'])));
        return { records, done: true };
      }),
      queryMore: vi.fn(),
      sobject: () => ({
        describe: async () => ({ fields: fields.map((name) => ({ name, type: 'string' })) }),
      }),
    };
    const [account] = buildConfig(parseArgs(argv(...MINIMAL))).objects;

    const rows = await buildQueryFn(conn as unknown as Connection)('SRC', account);

    expect(rows).toHaveLength(300);
    expect(rows[299]?.['Custom_Field_699__c']).toBe('v');
    for (const [soql] of conn.query.mock.calls) {
      expect(encodeURIComponent(soql).length).toBeLessThanOrEqual(14_000);
    }
  });

  it('reads every row of an object, not the 200 a FIELDS(ALL) query may ask for', async () => {
    // Salesforce answers FIELDS(ALL) only under a LIMIT of 200 at most. Asked
    // so, the command synced the first 200 rows of every object and said
    // nothing; the panel asks with no LIMIT and, refused, reads every row by
    // name.
    const ids = Array.from({ length: 250 }, (_, i) => ({
      Id: `001${String(i).padStart(12, '0')}AAA`,
    }));
    const NEXT = '/services/data/v66.0/query/01g000000000002-150';
    const conn = {
      query: vi.fn(async (soql: string) => {
        if (soql.includes('FIELDS(ALL)')) {
          if (!/LIMIT (\d+)$/.test(soql) || Number(/LIMIT (\d+)$/.exec(soql)?.[1]) > 200) {
            throw new Error(
              'MALFORMED_QUERY: The SOQL FIELDS function must have a LIMIT of at most 200',
            );
          }
          return { records: ids.slice(0, 200), done: true };
        }
        return { records: ids.slice(0, 150), done: false, nextRecordsUrl: NEXT };
      }),
      queryMore: vi.fn().mockResolvedValue({ records: ids.slice(150), done: true }),
      sobject: () => ({
        describe: async () => ({ fields: [{ name: 'Id', type: 'id' }] }),
      }),
    };
    const [account] = buildConfig(parseArgs(argv(...MINIMAL))).objects;

    const rows = await buildQueryFn(conn as unknown as Connection)('SRC', account);

    expect(rows).toHaveLength(250);
    expect(conn.query).not.toHaveBeenCalledWith(expect.stringContaining('LIMIT'));
  });

  it("reads a delta from its bound, with the object's filter kept whole, as the panel does", async () => {
    const conn = {
      query: vi.fn(async () => ({ records: [], done: true })),
      queryMore: vi.fn(),
      sobject: () => ({ describe: async () => ({ fields: [{ name: 'Id', type: 'id' }] }) }),
    };
    const [account] = buildConfig(
      parseArgs(argv(...MINIMAL, '--where', "Account=Type = 'A' OR Type = 'B'")),
    ).objects;

    await buildQueryFn(conn as unknown as Connection)('SRC', account, {
      changedSince: '2026-10-13T08:55:00Z',
    });

    expect(conn.query).toHaveBeenCalledWith(
      "SELECT Id FROM Account WHERE SystemModstamp > 2026-10-13T08:55:00Z AND (Type = 'A' OR Type = 'B')",
    );
  });

  it('says when a bound stopped the read, so a delta keeps its watermark', async () => {
    // A cursor that never ends: the read stops at its page bound.
    const conn = {
      query: vi.fn(async () => ({ records: [{ Id: 'a' }], done: false, nextRecordsUrl: '/next' })),
      queryMore: vi.fn(async () => ({
        records: [{ Id: 'b' }],
        done: false,
        nextRecordsUrl: '/next',
      })),
      sobject: () => ({ describe: async () => ({ fields: [{ name: 'Id', type: 'id' }] }) }),
    };
    const [account] = buildConfig(parseArgs(argv(...MINIMAL))).objects;
    const onBoundReached = vi.fn();

    await buildQueryFn(conn as unknown as Connection)('SRC', account, { onBoundReached });

    expect(onBoundReached).toHaveBeenCalledTimes(1);
  });
});

describe('what a dry run prints', () => {
  it("lists beside the prediction the target's validation rules, which it cannot evaluate", () => {
    const lines = simulationLines({
      configId: 'cli-1',
      operationId: 'sync-simulation-1',
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
      objects: [
        {
          objectApiName: 'Account',
          operation: 'insert',
          read: 652,
          insert: 652,
          update: 0,
          delete: 0,
          skipped: 0,
          refused: 0,
          conflicts: 0,
          conflictFields: [],
          notes: [],
          validationRules: [
            { name: 'Type_By_Profile', message: 'This profile creates one account type only' },
            { name: 'Siret_Format', message: 'SIRET: 14 digits', field: 'Siret__c' },
          ],
        },
      ],
      duration: 5,
      timestamp: '2026-10-16T00:00:00.000Z',
    });

    expect(lines).toEqual([
      '\nsimulation: 1 object(s), nothing written',
      '  Account (insert): 652 read, would insert 652, update 0, delete 0, skip 0, refuse 0',
      '      2 active validation rule(s) of the target, which a simulation cannot evaluate — ' +
        'a record one of them refuses is counted as written:',
      '        Type_By_Profile: This profile creates one account type only',
      '        Siret_Format (Siret__c): SIRET: 14 digits',
    ]);
  });

  it("says when the target's validation rules could not be listed", () => {
    const lines = simulationLines({
      configId: 'cli-1',
      operationId: 'sync-simulation-1',
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
      objects: [],
      duration: 5,
      timestamp: '2026-10-16T00:00:00.000Z',
      validationRulesUnread: 'INSUFFICIENT_ACCESS',
    });

    expect(lines).toContain(
      "  the target's validation rules could not be listed (INSUFFICIENT_ACCESS): any of them " +
        'may refuse a record counted as written',
    );
  });

  it('says per object what the run would do, and that nothing was written', () => {
    const lines = simulationLines({
      configId: 'cli-1',
      operationId: 'sync-simulation-1',
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
      objects: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          read: 3,
          insert: 1,
          update: 1,
          delete: 0,
          skipped: 0,
          refused: 1,
          conflicts: 0,
          conflictFields: [],
          notes: ['1 record(s) carry no value in Ext_Id__c: an upsert matches on it.'],
        },
      ],
      duration: 5,
      timestamp: '2026-10-06T00:00:00.000Z',
    });

    expect(lines).toEqual([
      '\nsimulation: 1 object(s), nothing written',
      '  Account (upsert): 3 read, would insert 1, update 1, delete 0, skip 0, refuse 1',
      '      1 record(s) carry no value in Ext_Id__c: an upsert matches on it.',
    ]);
  });

  it('says what a run that copies files would copy of them', () => {
    const lines = simulationLines({
      configId: 'cli-1',
      operationId: 'sync-simulation-1',
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
      objects: [
        {
          objectApiName: 'Opportunity',
          operation: 'insert',
          read: 3,
          insert: 3,
          update: 0,
          delete: 0,
          skipped: 0,
          refused: 0,
          conflicts: 0,
          conflictFields: [],
          notes: [],
          files: {
            copied: 3,
            versions: 0,
            bytes: 90,
            links: 0,
            unchanged: 0,
            tooLarge: 1,
            pastRunCap: 0,
            external: 0,
            recordNotWritten: 0,
            failed: 0,
          },
        },
      ],
      duration: 5,
      timestamp: '2026-10-14T00:00:00.000Z',
    });

    expect(lines).toContain(
      '      files: would copy 3, add 0 version(s), 0 unchanged, 1 skipped past the caps',
    );
  });

  it('names the conflicts of a bidirectional run, and where a simulation stopped', () => {
    const lines = simulationLines({
      configId: 'cli-1',
      operationId: 'sync-simulation-1',
      direction: 'bidirectional',
      conflictStrategy: 'target_wins',
      objects: [
        {
          objectApiName: 'Contact',
          operation: 'upsert',
          read: 2,
          insert: 0,
          update: 2,
          delete: 0,
          skipped: 0,
          refused: 0,
          conflicts: 2,
          conflictFields: ['Phone'],
          notes: [],
        },
      ],
      duration: 5,
      timestamp: '2026-10-06T00:00:00.000Z',
      error: 'INVALID_TYPE',
      failedObject: 'Case',
    });

    expect(lines).toContain(
      '  Contact (upsert): 2 read, would insert 0, update 2, delete 0, skip 0, refuse 0, 2 in conflict',
    );
    expect(lines).toContain('      differ on: Phone');
    expect(lines).toContain('  stopped at Case: INVALID_TYPE');
  });
});

describe('what a run says before its first write', () => {
  it('says what a simulation found it would write, and what of the count it would not', () => {
    const lines = writeCheckLines(
      {
        objects: [{ objectApiName: 'Contact', rows: 4 }],
        total: 4,
        notWritten: 2,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0.01 },
        emails: [],
        verdict: 'writes',
      },
      'TGT',
    );

    expect(lines[0]).toMatch(/^write gate: 2 record\(s\) to write to TGT/);
    expect(lines).toContain(
      '  of the 4 a run counts from the source, 2 would not be written: held back or refused, as ' +
        'each object says; what follows is measured on all of them',
    );
  });

  it('says of a simulation that would write none of what it counts the count it would not write', () => {
    // 34 prices whose product and book name nothing the target holds: the
    // check says nothing to write, total 0, and what it counted.
    const lines = writeCheckLines(
      {
        objects: [{ objectApiName: 'PricebookEntry', rows: 34 }],
        total: 0,
        notWritten: 34,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0.07, maxMB: 500, remainingMB: 500 },
        emails: [],
        verdict: 'nothing',
      },
      'TGT',
    );

    expect(lines.slice(0, 4)).toEqual([
      'write gate: 0 record(s) to write to TGT, about 0.07 MB of data storage',
      `  ${'PricebookEntry'.padEnd(42)}${'34'.padStart(8)}`,
      '  of the 34 a run counts from the source, 34 would not be written: held back or refused, ' +
        'as each object says; what follows is measured on all of them',
      '  data storage of TGT: 500 MB left of 500 MB',
    ]);
  });

  it('says the contact roles the platform may write with the opportunities, counted among the records to write', () => {
    // On a scratch org: "write gate: 4 record(s) … OpportunityContactRole 1",
    // and the run linked that role to the platform's and wrote none.
    const lines = writeCheckLines(
      {
        objects: [
          { objectApiName: 'Account', rows: 1 },
          { objectApiName: 'Contact', rows: 1 },
          { objectApiName: 'Opportunity', rows: 1 },
          { objectApiName: 'OpportunityContactRole', rows: 1 },
        ],
        total: 4,
        alreadyCopied: 0,
        rolesByThePlatform: 1,
        storage: { verdict: 'fits', estimateMB: 0.01 },
        emails: [],
        verdict: 'writes',
      },
      'TGT',
    );

    expect(lines[0]).toMatch(/^write gate: 4 record\(s\) to write to TGT/);
    expect(lines).toContain(
      '  of them, up to 1 OpportunityContactRole record(s) the platform writes itself with the ' +
        'opportunities the run creates, for their contact: the run links each and does not send it',
    );
  });

  it('says the contact roles the run links to the platform’s apart from the records it counts to write', () => {
    // On a scratch org: "write gate: 4 record(s) … OpportunityContactRole 1",
    // and the run wrote 3 and linked the role to the platform's.
    const lines = writeCheckLines(
      {
        objects: [
          { objectApiName: 'Account', rows: 1 },
          { objectApiName: 'Contact', rows: 1 },
          { objectApiName: 'Opportunity', rows: 1 },
        ],
        total: 3,
        alreadyCopied: 0,
        rolesLinked: 1,
        storage: { verdict: 'fits', estimateMB: 0.01 },
        emails: [],
        verdict: 'writes',
      },
      'TGT',
    );

    expect(lines[0]).toMatch(/^write gate: 3 record\(s\) to write to TGT/);
    expect(lines).toContain(
      '  not counted: 1 OpportunityContactRole record(s) the platform writes itself with the ' +
        'opportunities the run creates, for their contact: the run links each and does not send it',
    );
    expect(lines.some((line) => line.includes('of them, up to'))).toBe(false);
  });

  it('names the key of an upsert the target matches none on', () => {
    const lines = writeCheckLines(
      {
        objects: [],
        total: 0,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0 },
        emails: [],
        verdict: 'refused',
        unwritable: [{ objectApiName: 'Account', rows: 1, why: 'notAKey', key: 'Name' }],
      },
      'TGT',
    );

    expect(lines).toContain(
      '  Account: 1 record(s) TGT takes none of — its upsert matches on a field that is neither ' +
        'an External ID nor an idLookup field (Name)',
    );
  });

  it('says the contacts an account left out holds back, and counts them nowhere among the records to write', () => {
    // The run said "write gate: 4 record(s) to write … Contact 4", and would
    // have written none of them.
    const lines = writeCheckLines(
      {
        objects: [],
        total: 0,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0 },
        emails: [],
        verdict: 'refused',
        unwritable: [{ objectApiName: 'Account', rows: 2, why: 'notAKey', key: 'Name' }],
        heldBack: [
          { objectApiName: 'Contact', rows: 4, parent: 'Account', field: 'AccountId' },
          { objectApiName: 'Case', rows: 1, parent: 'Contact', field: 'ContactId' },
        ],
      },
      'TGT',
    );

    expect(lines[0]).toBe('write gate: 0 record(s) to write to TGT, about 0 MB of data storage');
    expect(lines.slice(-2)).toEqual([
      '  Contact: 4 record(s) held back, not written — their AccountId names Account records left out',
      '  Case: 1 record(s) held back, not written — their ContactId names Contact records held back',
    ]);
  });

  it('names each lookup that holds back rows of an object, with its rows', () => {
    // Named by its first row alone, a dry run said 13 prices held back by
    // Pricebook2Id where its simulation held 9 back by Product2Id.
    const lines = writeCheckLines(
      {
        objects: [],
        total: 0,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0 },
        emails: [],
        verdict: 'refused',
        unwritable: [
          { objectApiName: 'Product2', rows: 3, why: 'notAKey', key: 'Description' },
          { objectApiName: 'Pricebook2', rows: 1, why: 'notAKey', key: 'Description' },
        ],
        heldBack: [
          {
            objectApiName: 'PricebookEntry',
            rows: 13,
            parent: 'Pricebook2',
            field: 'Pricebook2Id',
            parents: [
              { parent: 'Pricebook2', field: 'Pricebook2Id', rows: 4 },
              { parent: 'Product2', field: 'Product2Id', rows: 9 },
            ],
          },
        ],
      },
      'TGT',
    );

    expect(lines.at(-1)).toBe(
      '  PricebookEntry: 13 record(s) held back, not written — 4 whose Pricebook2Id names ' +
        'Pricebook2 records left out; 9 whose Product2Id names Product2 records left out',
    );
  });

  it('lists the records per object, those left as an earlier run copied them, the storage and the emails', () => {
    expect(
      writeCheckLines(
        {
          objects: [
            { objectApiName: 'Contact', rows: 30 },
            { objectApiName: 'Account', rows: 2 },
          ],
          total: 32,
          alreadyCopied: 40,
          storage: { verdict: 'fits', estimateMB: 0.0625, maxMB: 5, remainingMB: 3 },
          emails: [
            {
              limit: 'SingleEmail',
              emails: 60,
              verdict: 'exceeds',
              remaining: 15,
              max: 15,
              objects: [{ objectApiName: 'Contact', perRecord: 2 }],
            },
          ],
          verdict: 'asks',
        },
        'TRAP',
      ),
    ).toEqual([
      'write gate: 32 record(s) to write to TRAP, about 0.07 MB of data storage',
      '  Contact                                         30',
      '  Account                                          2',
      '  not counted: 40 record(s) an earlier run of this configuration copied, still in the ' +
        'target, left as they are',
      '  data storage of TRAP: 3 MB left of 5 MB',
      '  emails: these records make TRAP send about 60 single emails (2 per Contact), more than ' +
        'the 15 of 15 it has left today',
    ]);
  });

  it('says one email of a limit in the singular', () => {
    // A sync of one contact said "about 1 single emails".
    const lines = writeCheckLines(
      {
        objects: [{ objectApiName: 'Contact', rows: 1 }],
        total: 1,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0.002, maxMB: 5, remainingMB: 3 },
        emails: [
          {
            limit: 'SingleEmail',
            emails: 1,
            verdict: 'exceeds',
            remaining: 0,
            max: 15,
            objects: [{ objectApiName: 'Contact', perRecord: 1 }],
          },
        ],
        verdict: 'asks',
      },
      'TRAP',
    );

    expect(lines).toContain(
      '  emails: these records make TRAP send about 1 single email (1 per Contact), more than ' +
        'the 0 of 15 it has left today',
    );
  });

  it('says the API requests the run takes, and each object the target takes none of', () => {
    const lines = writeCheckLines(
      {
        objects: [{ objectApiName: 'Account', rows: 40 }],
        total: 40,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0.08, maxMB: 5, remainingMB: 3 },
        emails: [],
        unwritable: [{ objectApiName: 'Case', rows: 120, why: 'notCreateable' }],
        apiRequests: { verdict: 'near', estimate: 1, remaining: 900, max: 15_000 },
        verdict: 'asks',
      },
      'TRAP',
    );

    expect(lines).toContain(
      '  API requests: about 1, of the 900 TRAP has left of its 15000 a day: it would leave less ' +
        'than a tenth of them',
    );
    expect(lines).toContain(
      '  Case: 120 record(s) TRAP takes none of — the user the run writes as may not create its records',
    );
  });

  it('says a dry run of a run past the storage would be refused, with the write order and what an earlier run copied', () => {
    const lines = simulationLines(
      {
        configId: 'cfg-1',
        operationId: 'sync-simulation-1',
        direction: 'source_to_target',
        conflictStrategy: 'source_wins',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'insert',
            read: 3,
            insert: 1,
            update: 0,
            delete: 0,
            skipped: 2,
            refused: 0,
            conflicts: 0,
            conflictFields: [],
            notes: [],
            alreadyCopied: 2,
            alreadyLinked: 1,
          },
        ],
        duration: 5,
        timestamp: '2026-10-21T00:00:00.000Z',
        writeOrder: {
          objects: ['Account', 'Contact'],
          moved: [{ objectApiName: 'Contact', after: 'Account', field: 'AccountId' }],
          cycles: [],
        },
        writeCheck: {
          objects: [{ objectApiName: 'Account', rows: 3_000 }],
          total: 3_000,
          alreadyCopied: 2,
          alreadyLinked: 1,
          storage: { verdict: 'exceeds', estimateMB: 5.86, maxMB: 5, remainingMB: 4 },
          emails: [],
          verdict: 'refused',
        },
      },
      'TRAP',
    );

    expect(lines).toContain('  write order: Account, Contact');
    expect(lines).toContain('    Contact after Account: its AccountId names one');
    expect(lines).toContain('    data storage of TRAP: 4 MB left of 5 MB: the records do not fit');
    expect(lines).toContain(
      '    a run would be refused before it writes (SYNC_STORAGE_EXCEEDED): the records do not fit',
    );
    expect(lines).toContain(
      '      2 already copied by an earlier run of this configuration, left as they are',
    );
    // A record the earlier run linked to one the target held is said linked:
    // live, a second run said "already copied" of an account the first linked.
    expect(lines).toContain(
      '      1 already linked by an earlier run of this configuration to records the target ' +
        'held, left as they are',
    );
    expect(lines).toContain(
      '    not counted: 1 record(s) an earlier run of this configuration linked to records the ' +
        'target held, left as they are',
    );
  });

  it.each([
    ['past the storage', false],
    ['with its checkpoint refused', true],
  ])(
    'names on its verdict line the code the run’s gate refuses it with first: an object the target takes none of, before a run %s',
    async (_label, checkpointRefused) => {
      // The line named the checkpoint, or the storage, while the gate refuses
      // the object the target takes none of first.
      const measured = await measureSyncWrite(
        {
          objects: [{ objectApiName: 'Account', operation: 'insert', rows: 3_000 }],
          alreadyCopied: 0,
          unwritable: [
            { objectApiName: 'Case', operation: 'insert', rows: 120, why: 'notCreateable' },
          ],
        },
        {
          readStorage: async () => ({ maxMB: 5, remainingMB: 1 }),
          readApiBudget: async () => ({ max: 15_000, remaining: 14_000 }),
          readAutomation: async () => ({
            objectsRead: ['Account'],
            objects: [],
            unread: [],
            conditionsNotRead: 0,
            conditionsBound: 25,
            requests: 0,
          }),
          readLimits: async () => ({ SingleEmail: { max: 15, remaining: 15 } }),
          readDeliverability: async () => ({ reading: { level: 'withheld' }, requests: 0 }),
          emails: { target: 'TRAP', accepted: false },
          confirmAboveRecords: 2_000,
          ...(checkpointRefused
            ? {
                checkpointFirst: {
                  scope: async () => {
                    throw new Error('the store is locked');
                  },
                  take: async () => ({ taken: false as const, stopped: true as const }),
                },
              }
            : {}),
        },
      );
      expect(measured.check.verdict).toBe('refused');
      const gate = await gateSyncWrite(measured, {
        policy: 'refuse',
        org: 'TRAP',
        orgTier: 'development',
      });
      expect(gate).toMatchObject({ go: false, code: 'SYNC_TARGET_UNWRITABLE' });

      const lines = simulationLines(
        {
          configId: 'cfg-1',
          operationId: 'sync-simulation-1',
          direction: 'source_to_target',
          conflictStrategy: 'source_wins',
          objects: [],
          duration: 5,
          timestamp: '2026-10-21T00:00:00.000Z',
          writeCheck: measured.check,
        },
        'TRAP',
        false,
        checkpointRefused ? measured.checkpointFailed : undefined,
      );

      expect(lines.filter((line) => line.includes('would be refused before it writes'))).toEqual([
        '    a run would be refused before it writes (SYNC_TARGET_UNWRITABLE): the target takes ' +
          'none of the records of an object it writes',
      ]);
    },
  );
});

describe('what a run prints of the record types the target gave', () => {
  /** What a run with the opportunity on Master of the scratch source says of it. */
  const given = (over: Partial<RecordTypeGiven> = {}): RecordTypeGiven => ({
    objectApiName: 'Opportunity',
    rows: 1,
    why: { masterInSource: 1 },
    predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
    ...over,
  });

  /** A simulation of one object, its line of the record types given as told. */
  const simulation = (recordTypeGiven?: RecordTypeGiven) => ({
    configId: 'cli-1',
    operationId: 'sync-simulation-1',
    direction: 'source_to_target' as const,
    conflictStrategy: 'source_wins' as const,
    objects: [
      {
        objectApiName: 'Opportunity',
        operation: 'insert' as const,
        read: 1,
        insert: 1,
        update: 0,
        delete: 0,
        skipped: 0,
        refused: 0,
        conflicts: 0,
        conflictFields: [],
        notes: [],
        ...(recordTypeGiven ? { recordTypeGiven } : {}),
      },
    ],
    duration: 5,
    timestamp: '2026-11-01T00:00:00.000Z',
  });

  it('says in a dry run the type the target would give, and why, after the objects', () => {
    const lines = simulationLines(simulation(given()), 'TGT');

    expect(lines.slice(-2)).toEqual([
      '  record types the target would give the records created without one (1 object(s)):',
      '    Opportunity  1 record(s) on Master in the source: would go in as SFX_Retail (SFX ' +
        'Retail), the only other Opportunity record type open to the user the run writes as, ' +
        'whose describe names Master the default',
    ]);
  });

  it('says in a dry run that the sets a muted run assigns may open other types', () => {
    const lines = simulationLines(simulation(given()), 'TGT', true);

    expect(lines.at(-1)).toBe(
      '    the permission sets a real run assigns to mute the automation may open other record ' +
        'types to the user it writes as: it reads them again once assigned, and its summary ' +
        'says what the target gave',
    );
  });

  it('says nothing of an object whose records go with their own type', () => {
    expect(simulationLines(simulation(), 'TGT').join('\n')).not.toContain('record types');
    expect(recordTypeGivenOfObjectsLines([{}, {}], false)).toEqual([]);
    // Nor of the mute, with nothing to say of a type.
    expect(recordTypeGivenOfObjectsLines([{}], true, true)).toEqual([]);
  });

  it('says after a run what the records were read back holding', () => {
    const lines = recordTypeGivenOfObjectsLines(
      [
        {
          recordTypeGiven: given({
            readBack: {
              read: 1,
              types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 1 }],
            },
          }),
        },
      ],
      false,
    );

    expect(lines).toEqual([
      'record types the target gave the records created without one (1 object(s)):',
      '  Opportunity  1 record(s) on Master in the source: went in as SFX_Retail (SFX Retail), ' +
        'read back on 1',
    ]);
  });

  it('names the target’s automation when what was read back is not what the describe said', () => {
    const lines = recordTypeGivenOfObjectsLines(
      [
        {
          recordTypeGiven: given({
            rows: 250,
            why: { masterInSource: 250 },
            readBack: {
              read: 200,
              types: [{ developerName: 'SFX_Hidden', label: 'SFX Hidden', rows: 200 }],
            },
          }),
        },
      ],
      false,
    );

    expect(lines[1]).toBe(
      '  Opportunity  250 record(s) on Master in the source: read back on 200 of 250: 200 ' +
        'SFX_Hidden (SFX Hidden); the describe said SFX_Retail: an automation of the target sets ' +
        'the record type',
    );
  });

  it('says the org’s words when the read back failed', () => {
    const lines = recordTypeGivenOfObjectsLines(
      [
        {
          recordTypeGiven: given({
            readBack: { read: 0, types: [], unread: 'INVALID_TYPE: not supported' },
          }),
        },
      ],
      false,
    );

    expect(lines[1]).toContain(
      'the record types they hold could not be read back: ' + 'INVALID_TYPE: not supported',
    );
  });
});
