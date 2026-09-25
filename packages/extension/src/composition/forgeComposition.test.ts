import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeConfig } from '@sandforge/shared';
import { buildSyntheticForgeGraph } from '@sandforge/shared';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../core/connection/ConnectionHelper.js', () => ({ getJsforceConnection: vi.fn() }));

import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import { initForgeComposition } from './forgeComposition.js';
import type { ForgeCompositionDeps } from './forgeComposition.js';
import type { ForgeOrchestrator } from '../modules/forge/ForgeOrchestrator.js';
import type { ForgeServices } from '../bridge/handlers/ForgeHandler.js';
import { PIIDetector } from '../core/precheck/PIIDetector.js';

/** A field as jsforce's describe returns it, reduced to what Forge reads. */
function field(name: string, type: string, referenceTo: string[] = []) {
  return {
    name,
    type,
    createable: type !== 'id',
    nillable: type !== 'id',
    referenceTo,
    relationshipName: referenceTo.length > 0 ? name.replace(/Id$/, '') : null,
    cascadeDelete: false,
    picklistValues: [],
    externalId: false,
  };
}

/** Account with two children: discovery at depth `direct` finds three objects. */
const DESCRIBES: Record<string, unknown> = {
  Account: {
    name: 'Account',
    createable: true,
    fields: [field('Id', 'id'), field('Name', 'string')],
    childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities' },
    ],
  },
  Contact: {
    name: 'Contact',
    createable: true,
    fields: [
      field('Id', 'id'),
      field('LastName', 'string'),
      field('AccountId', 'reference', ['Account']),
    ],
    childRelationships: [],
  },
  Opportunity: {
    name: 'Opportunity',
    createable: true,
    fields: [
      field('Id', 'id'),
      field('Name', 'string'),
      field('AccountId', 'reference', ['Account']),
    ],
    childRelationships: [],
  },
};

const PREFIX: Record<string, string> = { Account: '001', Contact: '003', Opportunity: '006' };

/** An 18-character id for `object`, numbered `n`. */
function sfId(object: string, n: number): string {
  return `${PREFIX[object]}${String(n).padStart(12, '0')}AAA`;
}

/** Describe calls per `org::object`, across every connection handed out. */
let describeCalls: Map<string, number>;

/** A connection to `orgId` that counts describes and answers queries and writes. */
function fakeConnection(orgId: string) {
  return {
    describe: vi.fn(async (objectApiName: string) => {
      const key = `${orgId}::${objectApiName}`;
      describeCalls.set(key, (describeCalls.get(key) ?? 0) + 1);
      return DESCRIBES[objectApiName];
    }),
    describeGlobal: vi.fn(async () => ({
      sobjects: Object.keys(PREFIX).map((name) => ({ name, keyPrefix: PREFIX[name] })),
    })),
    query: vi.fn(async (soql: string) => {
      const object = /\bFROM\s+(\w+)/i.exec(soql)?.[1] ?? '';
      if (/COUNT\(\)/i.test(soql)) return { totalSize: 2, done: true, records: [] };
      const records = [1, 2].map((n) => ({
        Id: sfId(object, n),
        Name: `${object} ${n}`,
        LastName: `${object} ${n}`,
        ...(object === 'Account' ? {} : { AccountId: sfId('Account', n) }),
      }));
      return { totalSize: records.length, done: true, records };
    }),
    queryMore: vi.fn(async () => ({ totalSize: 0, done: true, records: [] })),
    sobject: (objectApiName: string) => ({
      create: vi.fn(async (records: unknown[]) =>
        records.map((_, i) => ({ id: sfId(objectApiName, 900 + i), success: true, errors: [] })),
      ),
    }),
  };
}

/** The PII scan discovery runs, reduced to the part the composition reads. */
type DetectPII = (
  objectName: string,
  fields: Array<{ apiName: string; label: string; type: string }>,
) => { piiFields: Array<{ fieldApiName: string }> };

/** Wire the composition and hand back what it injects into the handlers. */
async function compose(
  detectPII: DetectPII = () => ({ piiFields: [] }),
): Promise<{ orchestrator: ForgeOrchestrator; services: ForgeServices }> {
  const setForgeOrchestrator = vi.fn();
  const deps = {
    handlers: { setForgeOrchestrator },
    orgRegistry: {},
    orgManager: {},
    configStore: { get: vi.fn(), set: vi.fn() },
    piiDetector: { detectPII },
    log: vi.fn(),
  } as unknown as ForgeCompositionDeps;
  initForgeComposition(deps);
  await vi.waitFor(() => expect(setForgeOrchestrator).toHaveBeenCalled(), { timeout: 5_000 });
  const [orchestrator, services] = setForgeOrchestrator.mock.calls[0] as [
    ForgeOrchestrator,
    ForgeServices,
  ];
  return { orchestrator, services };
}

const SOQL_CONFIG: ForgeConfig = {
  inputMode: 'soql',
  soqlQuery: 'SELECT Id FROM Account',
  depth: 'direct',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

describe('initForgeComposition', () => {
  beforeEach(() => {
    describeCalls = new Map();
    vi.mocked(getJsforceConnection).mockReset();
    vi.mocked(getJsforceConnection).mockImplementation(
      async (orgId: string) => fakeConnection(orgId) as unknown as Connection,
    );
  });

  it('describes each object at most once per org across discovery, the run and the drift check', async () => {
    const { orchestrator, services } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account', 'Contact', 'Opportunity']);

    const result = await orchestrator.execute(graph, SOQL_CONFIG);
    await services.metadataDiff?.compare('src', 'tgt', ['Account', 'Contact', 'Opportunity']);

    // The run wrote to the target: its describes were needed, not skipped.
    expect(result.idRemapCount).toBeGreaterThan(0);
    expect([...describeCalls.keys()].sort()).toEqual([
      'src::Account',
      'src::Contact',
      'src::Opportunity',
      'tgt::Account',
      'tgt::Contact',
      'tgt::Opportunity',
    ]);
    for (const [key, count] of describeCalls) {
      expect({ key, count }).toEqual({ key, count: 1 });
    }
  });

  it('links the children of an Account the target refused as a duplicate to the record it named', async () => {
    // The target already holds both Accounts: its unique index refuses each,
    // naming the record, the way sObject Collections answers.
    const existing: Record<string, string> = {
      'Account 1': '001000000000771',
      'Account 2': '001000000000772',
    };
    const created = new Map<string, Array<Record<string, unknown>>>();
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      return {
        ...connection,
        describe: vi.fn(async (objectApiName: string) => ({
          ...((await connection.describe(objectApiName)) as object),
          keyPrefix: PREFIX[objectApiName],
        })),
        sobject: (objectApiName: string) => ({
          create: vi.fn(async (records: Array<Record<string, unknown>>) => {
            created.set(objectApiName, records);
            return records.map((record, i) =>
              objectApiName === 'Account'
                ? {
                    success: false,
                    errors: [
                      {
                        statusCode: 'DUPLICATE_VALUE',
                        message: `duplicate value found: Name duplicates value on record with id: ${existing[String(record['Name'])]}`,
                        fields: [],
                      },
                    ],
                  }
                : { id: sfId(objectApiName, 900 + i), success: true, errors: [] },
            );
          }),
        }),
      } as unknown as Connection;
    });
    const { orchestrator } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    const result = await orchestrator.execute(graph, SOQL_CONFIG);

    expect(created.get('Contact')?.map((c) => c['AccountId'])).toEqual([
      '001000000000771AAA',
      '001000000000772AAA',
    ]);
    expect(result.linkedExistingCount).toBe(2);
    expect(result.existingRecords).toEqual([
      { objectApiName: 'Account', linked: 2, unidentified: 0 },
    ]);
    expect(result.idRemapExisting).toEqual([sfId('Account', 1), sfId('Account', 2)]);
    expect(result.status).toBe('success');
    // The key prefix came from the describe the run already held.
    for (const [key, count] of describeCalls) {
      expect({ key, count }).toEqual({ key, count: 1 });
    }
  });

  describe('a record type closed to the running user in the target', () => {
    const SOURCE_RT = '012000000000001AAA';
    const TARGET_RT = '012000000000009AAA';
    const MAPPINGS = {
      recordTypeMappings: [{ sourceId: SOURCE_RT, targetId: TARGET_RT, developerName: 'Partner' }],
    };

    /**
     * Account carries a Partner record type in both orgs; the target says
     * whether the running user may use it, as `isOpen` answers at the time.
     */
    function partnerAccounts(isOpen: () => boolean, created: string[]): void {
      vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
        const connection = fakeConnection(orgId);
        return {
          ...connection,
          describe: vi.fn(async (objectApiName: string) => {
            const described = (await connection.describe(objectApiName)) as {
              fields: unknown[];
            };
            if (objectApiName !== 'Account') return described;
            return {
              ...described,
              keyPrefix: '001',
              fields: [...described.fields, field('RecordTypeId', 'reference', ['RecordType'])],
              recordTypeInfos: [
                {
                  active: true,
                  available: isOpen(),
                  defaultRecordTypeMapping: false,
                  developerName: 'Partner',
                  master: false,
                  name: 'Partner',
                  recordTypeId: TARGET_RT,
                  urls: {},
                },
              ],
            };
          }),
          query: vi.fn(async (soql: string) => {
            const page = (await connection.query(soql)) as {
              records: Array<Record<string, unknown>>;
            };
            if (!/\bFROM\s+Account\b/i.test(soql) || /COUNT\(\)/i.test(soql)) return page;
            return {
              ...page,
              records: page.records.map((r) => ({ ...r, RecordTypeId: SOURCE_RT })),
            };
          }),
          sobject: (objectApiName: string) => ({
            create: vi.fn(async (records: unknown[]) => {
              created.push(objectApiName);
              return records.map((_, i) => ({
                id: sfId(objectApiName, 900 + i),
                success: true,
                errors: [],
              }));
            }),
          }),
        } as unknown as Connection;
      });
    }

    it('holds back the object from the describe the run already read', async () => {
      const created: string[] = [];
      partnerAccounts(() => false, created);
      const { orchestrator } = await compose();

      const graph = await orchestrator.discover(SOQL_CONFIG);
      const result = await orchestrator.execute(graph, SOQL_CONFIG, MAPPINGS);

      expect(created).not.toContain('Account');
      const held = result.errors?.find((e) => e.objectApiName === 'Account');
      expect(held?.stage).toBe('scope');
      expect(held?.samples[0].messages[0]).toMatch(
        /^RECORD_TYPE_UNAVAILABLE: 2 Account records use record type Partner, which the running user cannot use/,
      );
      for (const [key, count] of describeCalls) {
        expect({ key, count }).toEqual({ key, count: 1 });
      }
    });

    it('reads the target again on the run after, so access granted in between is seen', async () => {
      let open = false;
      const created: string[] = [];
      partnerAccounts(() => open, created);
      const { orchestrator } = await compose();
      const graph = await orchestrator.discover(SOQL_CONFIG);
      await orchestrator.execute(graph, SOQL_CONFIG, MAPPINGS);
      expect(created).not.toContain('Account');

      // The user does what the run said: the target now lets them use Partner.
      open = true;
      const retry = await orchestrator.execute(graph, SOQL_CONFIG, MAPPINGS);

      expect(created).toContain('Account');
      expect(retry.errors?.find((e) => e.objectApiName === 'Account')).toBeUndefined();
      expect(describeCalls.get('tgt::Account')).toBe(2);
    });
  });

  describe('anonymization', () => {
    /** Contacts carry an email and a phone, and the scan flags both. */
    function contactsWithPersonalData(
      created: Map<string, Array<Record<string, unknown>>>,
    ): DetectPII {
      vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
        const connection = fakeConnection(orgId);
        return {
          ...connection,
          describe: vi.fn(async (objectApiName: string) => {
            const described = (await connection.describe(objectApiName)) as { fields: unknown[] };
            if (objectApiName !== 'Contact') return described;
            return {
              ...described,
              fields: [...described.fields, field('Email', 'email'), field('Phone', 'phone')],
            };
          }),
          query: vi.fn(async (soql: string) => {
            const page = (await connection.query(soql)) as {
              records: Array<Record<string, unknown>>;
            };
            if (!/\bFROM\s+Contact\b/i.test(soql) || /COUNT\(\)/i.test(soql)) return page;
            return {
              ...page,
              records: page.records.map((r, i) => ({
                ...r,
                Email: `person${i + 1}@source.test`,
                Phone: `0102030${i}`,
              })),
            };
          }),
          sobject: (objectApiName: string) => ({
            create: vi.fn(async (records: Array<Record<string, unknown>>) => {
              created.set(objectApiName, records);
              return records.map((_, i) => ({
                id: sfId(objectApiName, 900 + i),
                success: true,
                errors: [],
              }));
            }),
          }),
        } as unknown as Connection;
      });
      return (_objectName, fields) => ({
        piiFields: fields
          .filter((f) => f.type === 'email' || f.type === 'phone')
          .map((f) => ({ fieldApiName: f.apiName })),
      });
    }

    it('writes the fields selected on a node anonymized, with the methods Review sent', async () => {
      const created = new Map<string, Array<Record<string, unknown>>>();
      const { orchestrator } = await compose(contactsWithPersonalData(created));
      const config: ForgeConfig = { ...SOQL_CONFIG, anonymizePII: true };

      const graph = await orchestrator.discover(config);
      expect(graph.nodes.find((n) => n.objectApiName === 'Contact')?.anonymizeFields).toEqual([
        'Email',
        'Phone',
      ]);
      await orchestrator.execute(graph, config, { anonymizationRules: { phone: 'redact' } });

      const contacts = created.get('Contact') ?? [];
      expect(contacts).toHaveLength(2);
      for (const contact of contacts) {
        expect(String(contact['Email'])).not.toMatch(/@source\.test$/);
        expect(String(contact['Email'])).toMatch(/@example\.com$/);
      }
      expect(contacts.map((c) => c['Phone'])).toEqual(['[REDACTED]', '[REDACTED]']);
    });

    it('leaves a field the user deselected as the source holds it', async () => {
      const created = new Map<string, Array<Record<string, unknown>>>();
      const { orchestrator } = await compose(contactsWithPersonalData(created));
      const config: ForgeConfig = { ...SOQL_CONFIG, anonymizePII: true };
      const discovered = await orchestrator.discover(config);
      const graph = {
        ...discovered,
        nodes: discovered.nodes.map((n) =>
          n.objectApiName === 'Contact' ? { ...n, anonymizeFields: ['Phone'] } : n,
        ),
      };

      await orchestrator.execute(graph, config);

      const contacts = created.get('Contact') ?? [];
      expect(contacts.map((c) => c['Email'])).toEqual([
        'person1@source.test',
        'person2@source.test',
      ]);
      expect(contacts.map((c) => c['Phone'])).not.toContain('01020300');
    });

    describe('with the detector the extension runs', () => {
      const detector = new PIIDetector();
      const detectPII: DetectPII = (objectName, fields) => detector.detectPII(objectName, fields);
      const config: ForgeConfig = { ...SOQL_CONFIG, anonymizePII: true };

      /** The contacts the run wrote: both of those the source holds. */
      function writtenContacts(
        created: Map<string, Array<Record<string, unknown>>>,
      ): Array<Record<string, unknown>> {
        const contacts = created.get('Contact') ?? [];
        expect(contacts).toHaveLength(2);
        return contacts;
      }

      it('writes a contact’s name anonymized, not as the source holds it', async () => {
        const created = new Map<string, Array<Record<string, unknown>>>();
        contactsWithPersonalData(created);
        const { orchestrator } = await compose(detectPII);

        const graph = await orchestrator.discover(config);
        expect(graph.nodes.find((n) => n.objectApiName === 'Contact')?.anonymizeFields).toEqual([
          'LastName',
          'Email',
          'Phone',
        ]);
        await orchestrator.execute(graph, config);

        for (const contact of writtenContacts(created)) {
          expect(contact['LastName']).toEqual(expect.any(String));
          expect(contact['LastName']).not.toMatch(/^Contact \d$/);
        }
      });

      it('names the personal fields of a starter template’s graph for Review', async () => {
        contactsWithPersonalData(new Map());
        const { orchestrator } = await compose(detectPII);

        const graph = await orchestrator.readPersonalFields(
          buildSyntheticForgeGraph(['Account', 'Contact']),
          config,
        );

        expect(graph.nodes.find((n) => n.objectApiName === 'Contact')?.anonymizeFields).toEqual([
          'LastName',
          'Email',
          'Phone',
        ]);
      });

      it('anonymizes a starter template’s contacts though its graph names no personal field', async () => {
        const created = new Map<string, Array<Record<string, unknown>>>();
        contactsWithPersonalData(created);
        const { orchestrator } = await compose(detectPII);

        await orchestrator.execute(buildSyntheticForgeGraph(['Account', 'Contact']), config);

        for (const contact of writtenContacts(created)) {
          expect(String(contact['Email'])).toMatch(/@example\.com$/);
          expect(contact['LastName']).not.toMatch(/^Contact \d$/);
          expect(contact['Phone']).not.toMatch(/^0102030\d$/);
        }
      });
    });

    it('writes every field as the source holds it with the toggle off', async () => {
      const created = new Map<string, Array<Record<string, unknown>>>();
      const { orchestrator } = await compose(contactsWithPersonalData(created));
      const discovered = await orchestrator.discover(SOQL_CONFIG);
      // Selections the toggle overrules: nothing is anonymized with it off.
      const graph = {
        ...discovered,
        nodes: discovered.nodes.map((n) =>
          n.objectApiName === 'Contact' ? { ...n, anonymizeFields: ['Email'] } : n,
        ),
      };

      await orchestrator.execute(graph, SOQL_CONFIG);

      expect(created.get('Contact')?.map((c) => c['Email'])).toEqual([
        'person1@source.test',
        'person2@source.test',
      ]);
    });
  });

  it('names an object whose source read a bound stopped in the run result', async () => {
    // The source keeps a Contact cursor open forever: the page bound is what
    // ends the read, and only the composition sees that it did.
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      if (orgId !== 'src') return connection as unknown as Connection;
      const answer = connection.query;
      return {
        ...connection,
        query: vi.fn(async (soql: string) => {
          const page = await answer(soql);
          if (!/\bFROM\s+Contact\b/i.test(soql) || /COUNT\(\)/i.test(soql)) return page;
          return { ...page, done: false, nextRecordsUrl: '/next' };
        }),
        queryMore: vi.fn(async () => ({
          totalSize: 0,
          done: false,
          nextRecordsUrl: '/next',
          records: [],
        })),
      } as unknown as Connection;
    });
    const { orchestrator } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    const result = await orchestrator.execute(graph, SOQL_CONFIG);

    expect(result.truncatedObjects).toEqual(['Contact']);
  });

  it('counts the calls a run makes, its reads and their pages, describes, writes, second pass and files, and none of discovery', async () => {
    // The results added up discovery's estimate of each node instead: a guess
    // at the writes of whole tables, 0 for every object of a starter template.
    const DOCUMENT = '069000000000001AAA';
    const VERSION = '068000000000001AAA';
    /** Every request the fake orgs answered, as Salesforce counts them. */
    let requests = 0;
    const pagesAfter = vi.fn();
    const updates = vi.fn();
    const page = (records: unknown[], more = false) => ({
      totalSize: records.length,
      done: !more,
      records,
      ...(more ? { nextRecordsUrl: '/services/data/v66.0/query/01g-2000' } : {}),
    });
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      return {
        describeGlobal: connection.describeGlobal,
        describe: vi.fn(async (objectApiName: string) => {
          requests++;
          const described = (await connection.describe(objectApiName)) as { fields: unknown[] };
          // Accounts under an account: a lookup the second pass fills in.
          return objectApiName === 'Account'
            ? {
                ...described,
                fields: [...described.fields, field('ParentId', 'reference', ['Account'])],
              }
            : described;
        }),
        query: vi.fn(async (soql: string) => {
          requests++;
          if (/FROM ContentDocumentLink/.test(soql)) {
            return page(
              soql.includes(sfId('Account', 1))
                ? [
                    {
                      ContentDocumentId: DOCUMENT,
                      LinkedEntityId: sfId('Account', 1),
                      ShareType: 'V',
                      Visibility: 'AllUsers',
                    },
                  ]
                : [],
            );
          }
          if (/FROM ContentVersion WHERE ContentDocumentId/.test(soql)) {
            return page([
              {
                Id: VERSION,
                ContentDocumentId: DOCUMENT,
                Title: 'Scan',
                PathOnClient: 'scan.png',
                ContentSize: 4,
                ContentLocation: 'S',
                SharingPrivacy: 'N',
              },
            ]);
          }
          if (/FROM ContentVersion WHERE Id/.test(soql)) {
            return page([{ ContentDocumentId: '069000000000901AAA' }]);
          }
          if (/FROM Attachment/.test(soql)) return page([]);
          const answered = await connection.query(soql);
          if (/COUNT\(\)/.test(soql)) return answered;
          if (/\bFROM Account\b/.test(soql)) {
            return page(
              answered.records.map((row) => ({
                ...row,
                ParentId: row.Id === sfId('Account', 2) ? sfId('Account', 1) : null,
              })),
            );
          }
          // The contacts come on two pages.
          return /\bFROM Contact\b/.test(soql) ? page(answered.records, true) : answered;
        }),
        queryMore: vi.fn(async () => {
          requests++;
          pagesAfter();
          return page([]);
        }),
        sobject: (objectApiName: string) => ({
          // An empty write sends nothing, as jsforce sends none.
          create: vi.fn(async (records: unknown[]) => {
            if (records.length > 0) requests++;
            return connection.sobject(objectApiName).create(records);
          }),
          update: vi.fn(async (records: Array<{ Id: string }>) => {
            if (records.length > 0) requests++;
            updates(objectApiName, records);
            return records.map((record) => ({ id: record.Id, success: true, errors: [] }));
          }),
        }),
        request: vi.fn(async (request: { method: string; url: string }) => {
          requests++;
          if (request.url === '/limits') return { FileStorageMB: { Max: 200, Remaining: 200 } };
          if (request.method === 'GET') return Buffer.from('scan').toString('base64');
          return { id: '068000000000901AAA', success: true, errors: [] };
        }),
      } as unknown as Connection;
    });
    const { orchestrator } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    const byDiscovery = requests;
    const result = await orchestrator.execute(graph, SOQL_CONFIG, {
      files: { maxFileSizeMB: 10, acceptedAsIs: false },
    });

    // Each kind of call was made: a page after a read, the second pass, a file.
    expect(pagesAfter).toHaveBeenCalled();
    expect(updates).toHaveBeenCalledWith('Account', expect.any(Array));
    expect(result.files?.objects[0]?.copied).toBe(1);
    expect(result.apiCalls).toBe(requests - byDiscovery);
  });

  it('joins a describe already under way instead of sending a second one', async () => {
    const { services } = await compose();

    await Promise.all([
      services.metadataDiff?.compare('src', 'tgt', ['Account']),
      services.metadataDiff?.compare('src', 'tgt', ['Account']),
    ]);

    expect(describeCalls.get('src::Account')).toBe(1);
    expect(describeCalls.get('tgt::Account')).toBe(1);
  });

  it('describes an object again once the caller re-discovers', async () => {
    const { orchestrator, services } = await compose();

    await services.metadataDiff?.compare('src', 'tgt', ['Account']);
    expect(describeCalls.get('tgt::Account')).toBe(1);

    orchestrator.clearDiscoveryCache();
    await services.metadataDiff?.compare('src', 'tgt', ['Account']);

    expect(describeCalls.get('tgt::Account')).toBe(2);
  });

  it('drops the describes of the orgs a caller names and leaves the others warm', async () => {
    const { orchestrator, services } = await compose();

    await services.metadataDiff?.compare('src', 'tgt', ['Account']);
    expect(describeCalls.get('src::Account')).toBe(1);
    expect(describeCalls.get('tgt::Account')).toBe(1);

    // Re-reading one org's schema is no reason to make every other org pay for
    // its describes again.
    orchestrator.clearDiscoveryCache(['tgt']);
    await services.metadataDiff?.compare('src', 'tgt', ['Account']);

    expect(describeCalls.get('src::Account')).toBe(1);
    expect(describeCalls.get('tgt::Account')).toBe(2);
  });

  it('shows a field deployed on the target once the caller re-discovers', async () => {
    // The source always has Industry; the target gains it partway through, the
    // way a deployment lands between two drift checks.
    let targetHasIndustry = false;
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      const hasIndustry = orgId === 'src' ? () => true : () => targetHasIndustry;
      return {
        ...connection,
        describe: vi.fn(async (objectApiName: string) => {
          const described = (await connection.describe(objectApiName)) as {
            fields: unknown[];
          };
          if (objectApiName !== 'Account' || !hasIndustry()) return described;
          return { ...described, fields: [...described.fields, field('Industry', 'string')] };
        }),
      } as unknown as Connection;
    });
    const { orchestrator, services } = await compose();

    const drift = await services.metadataDiff?.compare('src', 'tgt', ['Account']);
    expect(drift?.map((d) => d.fieldApiName)).toEqual(['Industry']);

    targetHasIndustry = true;
    // Still the cached describes: the drift is reported exactly as before.
    expect(await services.metadataDiff?.compare('src', 'tgt', ['Account'])).toEqual(drift);

    orchestrator.clearDiscoveryCache();
    expect(await services.metadataDiff?.compare('src', 'tgt', ['Account'])).toEqual([]);
  });

  it('sends no describe once discovery was cancelled while the connection was opening', async () => {
    // Discovery opens one connection per request (the describe and the count);
    // every pending one is held so that both are opened after the cancel.
    const pendingOpens: Array<() => void> = [];
    const connection = fakeConnection('src');
    vi.mocked(getJsforceConnection).mockImplementation(
      () =>
        new Promise<Connection>((resolve) => {
          pendingOpens.push(() => resolve(connection as unknown as Connection));
        }),
    );
    const { orchestrator } = await compose();
    const controller = new AbortController();

    const discovery = orchestrator.discover(SOQL_CONFIG, { signal: controller.signal });
    await vi.waitFor(() => expect(getJsforceConnection).toHaveBeenCalledTimes(2));
    controller.abort();
    const graph = await discovery;
    for (const open of pendingOpens) open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graph.nodes).toEqual([]);
    expect(connection.describe).not.toHaveBeenCalled();
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('sends no describeGlobal once a record-mode discovery was cancelled while the connection was opening', async () => {
    // Record mode starts by reading the org's key prefixes, so describeGlobal
    // is the request the cancel has to reach.
    const pendingOpens: Array<() => void> = [];
    const connection = fakeConnection('src');
    vi.mocked(getJsforceConnection).mockImplementation(
      () =>
        new Promise<Connection>((resolve) => {
          pendingOpens.push(() => resolve(connection as unknown as Connection));
        }),
    );
    const { orchestrator } = await compose();
    const controller = new AbortController();

    const discovery = orchestrator.discover(
      { ...SOQL_CONFIG, inputMode: 'record', soqlQuery: undefined, recordId: sfId('Account', 1) },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(getJsforceConnection).toHaveBeenCalled());
    controller.abort();
    const graph = await discovery;
    for (const open of pendingOpens) open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graph.nodes).toEqual([]);
    expect(connection.describeGlobal).not.toHaveBeenCalled();
    expect(connection.describe).not.toHaveBeenCalled();
  });

  it('copies the file of a cloned record through the connection, one request each way', async () => {
    const DOCUMENT = '069000000000001AAA';
    const VERSION = '068000000000001AAA';
    const COPIED = '068000000000901AAA';
    const requests: Array<{ org: string; method: string; url: string; body?: string }> = [];
    const readOptions: unknown[] = [];
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
      return {
        ...connection,
        query: vi.fn(async (soql: string) => {
          if (/FROM ContentDocumentLink/.test(soql)) {
            return page(
              soql.includes(sfId('Account', 1))
                ? [
                    {
                      ContentDocumentId: DOCUMENT,
                      LinkedEntityId: sfId('Account', 1),
                      ShareType: 'V',
                      Visibility: 'AllUsers',
                    },
                  ]
                : [],
            );
          }
          if (/FROM ContentVersion WHERE ContentDocumentId/.test(soql)) {
            return page([
              {
                Id: VERSION,
                ContentDocumentId: DOCUMENT,
                Title: 'Scan',
                PathOnClient: 'scan.png',
                ContentSize: 4,
                ContentLocation: 'S',
                SharingPrivacy: 'N',
              },
            ]);
          }
          if (/FROM ContentVersion WHERE Id/.test(soql)) {
            return page([{ ContentDocumentId: '069000000000901AAA' }]);
          }
          if (/FROM Attachment/.test(soql)) return page([]);
          return connection.query(soql);
        }),
        request: vi.fn(
          async (request: { method: string; url: string; body?: string }, options?: object) => {
            requests.push({ org: orgId, ...request });
            if (request.url === '/limits') return { FileStorageMB: { Max: 200, Remaining: 200 } };
            if (request.method === 'GET') {
              readOptions.push(options);
              return Buffer.from('scan').toString('base64');
            }
            return { id: COPIED, success: true, errors: [] };
          },
        ),
      } as unknown as Connection;
    });
    const { orchestrator } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    const result = await orchestrator.execute(graph, SOQL_CONFIG, {
      files: { maxFileSizeMB: 10, acceptedAsIs: false },
    });

    expect(requests.map((r) => [r.org, r.method, r.url])).toEqual([
      ['tgt', 'GET', '/limits'],
      ['src', 'GET', `/sobjects/ContentVersion/${VERSION}/VersionData`],
      ['tgt', 'POST', '/sobjects/ContentVersion'],
    ]);
    expect(readOptions).toEqual([{ encoding: 'base64', responseType: 'application/octet-stream' }]);
    expect(JSON.parse(requests[2].body ?? '{}')).toEqual({
      Title: 'Scan',
      PathOnClient: 'scan.png',
      VersionData: Buffer.from('scan').toString('base64'),
      // The first account the run created, as the fake target names it.
      FirstPublishLocationId: sfId('Account', 900),
    });
    expect(result.files?.objects).toEqual([
      { objectApiName: 'ContentDocument', planned: 1, plannedBytes: 4, copied: 1, failed: 0 },
    ]);
    expect(result.idRemapCreated).toContainEqual({
      objectApiName: 'ContentDocument',
      sourceIds: [DOCUMENT],
    });
  });
});
