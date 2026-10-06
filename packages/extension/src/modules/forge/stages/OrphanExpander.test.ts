import { describe, it, expect, vi } from 'vitest';
import { OrphanExpander, type OrphanExpansionInput } from './OrphanExpander.js';
import { IdRemapper } from '../IdRemapper.js';
import { RecordScopeCache } from '../RecordScopeCache.js';
import type { FieldInfo, ForgeExecutorDeps, InsertResult } from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';
import { RowsLeftToThePlatform } from '../../../core/common/platformRecords.js';
import { toSaveOutcome } from '../../../core/common/existingRecordMatch.js';
import type { RecordTypePicklists } from '../../../core/metadata/recordTypePicklists.js';
import { RecordTypeMapper } from '../../sync/RecordTypeMapper.js';
import { PicklistChangeTally, RecordTypePicklistReads } from './RecordTypePicklists.js';
import type { WrittenWithoutFields } from './BatchWriter.js';
import { ContactPointNeutralizer } from './ContactPointNeutralizer.js';

const ORPHAN_ID = '001AP00ORPHAN12'; // 15 alnum — passes SF_RECORD_ID_RE

type ExpanderDeps = Pick<ForgeExecutorDeps, 'describeFields' | 'queryRecords' | 'insertRecords'>;

function makeNode(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const ASSET_FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  {
    name: 'AccountId',
    queryable: true,
    createable: true,
    isReference: true,
    referenceTo: ['Account'],
    nillable: false,
  },
];

function makeDeps(overrides?: Partial<ExpanderDeps>): ExpanderDeps {
  return {
    describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
    ]),
    queryRecords: vi
      .fn<ExpanderDeps['queryRecords']>()
      .mockResolvedValue([{ Id: ORPHAN_ID, Name: 'Acme Insurance', OwnerId: '005USER' }]),
    insertRecords: vi
      .fn<ExpanderDeps['insertRecords']>()
      .mockResolvedValue([{ id: '001NEW', success: true, errors: [] }]),
    ...overrides,
  };
}

function makeInput(deps: ExpanderDeps, overrides?: Partial<OrphanExpansionInput>) {
  return {
    input: {
      node: makeNode('Asset'),
      fieldInfos: ASSET_FIELDS,
      records: [{ Id: '02iOLD1', AccountId: ORPHAN_ID }],
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      remapper: new IdRemapper(),
      scopeCache: new RecordScopeCache(),
      recordTypeMappings: undefined,
      recordTypeMapper: null,
      enabled: true,
      maxExpansions: 20,
      ...overrides,
    } satisfies OrphanExpansionInput,
    deps,
  };
}

describe('OrphanExpander', () => {
  it('fetches+inserts a missing required parent and registers the mapping', async () => {
    const deps = makeDeps();
    const { input } = makeInput(deps);
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);

    expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    const [, objectName, payload] = vi.mocked(deps.insertRecords).mock.calls[0];
    expect(objectName).toBe('Account');
    // Minimal payload: Id not createable, OwnerId orphan-nullified (omitted).
    expect(payload[0]).toEqual({ Name: 'Acme Insurance' });
    expect(input.remapper.get(ORPHAN_ID)).toBe('001NEW');
    // Parent registered in scope cache for multi-hop children.
    expect(input.scopeCache?.has('Account')).toBe(true);
    expect(expander.buildErrorReport()).toBeNull();
  });

  it('neutralizes the email addresses and phone numbers of the parent it copies, unless the run keeps them', async () => {
    const withContactPoints = (): ExpanderDeps =>
      makeDeps({
        describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Name', queryable: true, createable: true, isReference: false },
          { name: 'Phone', queryable: true, createable: true, isReference: false, type: 'phone' },
          {
            name: 'Billing_Email__c',
            queryable: true,
            createable: true,
            isReference: false,
            type: 'string',
            length: 255,
          },
        ]),
        queryRecords: vi.fn<ExpanderDeps['queryRecords']>().mockResolvedValue([
          {
            Id: ORPHAN_ID,
            Name: 'Acme Insurance',
            Phone: '+33 1 23 45 67 89',
            Billing_Email__c: 'billing@acme.com',
          },
        ]),
      });

    const neutralized = withContactPoints();
    const contactPoints = new ContactPointNeutralizer('salt');
    await new OrphanExpander(neutralized).expandForNode(
      makeInput(neutralized, { contactPoints }).input,
    );
    const kept = withContactPoints();
    await new OrphanExpander(kept).expandForNode(makeInput(kept).input);

    expect(vi.mocked(neutralized.insertRecords).mock.calls[0][2]).toEqual([
      {
        Name: 'Acme Insurance',
        Phone: expect.stringMatching(/^\+3363998\d{4}$/),
        Billing_Email__c: 'billing@acme.com.invalid',
      },
    ]);
    expect(contactPoints.report().values).toBe(2);
    expect(vi.mocked(kept.insertRecords).mock.calls[0][2]).toEqual([
      { Name: 'Acme Insurance', Phone: '+33 1 23 45 67 89', Billing_Email__c: 'billing@acme.com' },
    ]);
  });

  it('links the child to a parent the target already holds when it refuses the copy and names it', async () => {
    const deps: Pick<
      ForgeExecutorDeps,
      'describeFields' | 'queryRecords' | 'insertRecords' | 'describeObject'
    > = {
      ...makeDeps({
        insertRecords: vi.fn<ExpanderDeps['insertRecords']>().mockResolvedValue([
          {
            id: '',
            success: false,
            errors: [
              'DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: 001Fk00000AbCdE',
            ],
          },
        ]),
      }),
      describeObject: vi.fn(async () => ({ keyPrefix: '001', recordTypes: [] })),
    };
    const { input } = makeInput(deps);
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);

    expect(input.remapper.get(ORPHAN_ID)).toBe('001Fk00000AbCdEIAV');
    expect(input.remapper.isExisting(ORPHAN_ID)).toBe(true);
    expect(expander.buildErrorReport()).toBeNull();
  });

  describe('a parent the run writes as a draft', () => {
    /** A contract the child cannot be written without, read activated from the source. */
    const CHILD_FIELDS: FieldInfo[] = [
      {
        name: 'ContractId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Contract'],
        nillable: false,
      },
    ];

    function contractDeps(insertRecords: ExpanderDeps['insertRecords']) {
      return {
        ...makeDeps({
          describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'Status', queryable: true, createable: true, isReference: false },
          ]),
          queryRecords: vi
            .fn<ExpanderDeps['queryRecords']>()
            .mockResolvedValue([{ Id: ORPHAN_ID, Status: 'Activated' }]),
          insertRecords,
        }),
        describeObject: vi.fn(async () => ({ keyPrefix: '800', recordTypes: [] })),
      };
    }

    /** The run's own start as a draft: the status goes to Draft, and the one it had comes back. */
    const startAsDraft = async (
      _objectApiName: string,
      payload: Record<string, unknown>,
    ): Promise<string> => {
      const had = String(payload['Status']);
      payload['Status'] = 'Draft';
      return had;
    };

    it('writes it as a draft, and owes it the status it had once it is written', async () => {
      // Copied as read, an activated contract or order is refused by the
      // target — "choose Draft" — and the child that needed it with it.
      const deps = contractDeps(
        vi
          .fn<ExpanderDeps['insertRecords']>()
          .mockResolvedValue([{ id: '800NEW', success: true, errors: [] }]),
      );
      const oweStatus = vi.fn<(objectApiName: string, id: string, status: string) => void>();
      const { input } = makeInput(deps, {
        fieldInfos: CHILD_FIELDS,
        records: [{ Id: '02iOLD1', ContractId: ORPHAN_ID }],
        startAsDraft,
        oweStatus,
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(vi.mocked(deps.insertRecords).mock.calls[0][2]).toEqual([{ Status: 'Draft' }]);
      expect(input.remapper.get(ORPHAN_ID)).toBe('800NEW');
      expect(oweStatus).toHaveBeenCalledWith('Contract', '800NEW', 'Activated');
    });

    it('owes nothing to a parent the target already held, which the run never wrote', async () => {
      const deps = contractDeps(
        vi.fn<ExpanderDeps['insertRecords']>().mockResolvedValue([
          {
            id: '',
            success: false,
            errors: [
              'DUPLICATE_VALUE: duplicate value found: ContractNumber duplicates value on record with id: 800Fk00000AbCdE',
            ],
          },
        ]),
      );
      const oweStatus = vi.fn<(objectApiName: string, id: string, status: string) => void>();
      const { input } = makeInput(deps, {
        fieldInfos: CHILD_FIELDS,
        records: [{ Id: '02iOLD1', ContractId: ORPHAN_ID }],
        startAsDraft,
        oweStatus,
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(input.remapper.isExisting(ORPHAN_ID)).toBe(true);
      expect(oweStatus).not.toHaveBeenCalled();
    });
  });

  it('reports the expansion as failed when the refusal names a record of another object', async () => {
    const deps: Pick<
      ForgeExecutorDeps,
      'describeFields' | 'queryRecords' | 'insertRecords' | 'describeObject'
    > = {
      ...makeDeps({
        insertRecords: vi.fn<ExpanderDeps['insertRecords']>().mockResolvedValue([
          {
            id: '',
            success: false,
            errors: [
              'DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: 003Fk00000MnOpQ',
            ],
          },
        ]),
      }),
      describeObject: vi.fn(async () => ({ keyPrefix: '001', recordTypes: [] })),
    };
    const { input } = makeInput(deps);
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);

    expect(input.remapper.get(ORPHAN_ID)).toBeUndefined();
    // The refusal is what the report says, as a row of the run's says it.
    expect(expander.buildErrorReport()?.samples[0].messages).toEqual([
      'DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: 003Fk00000MnOpQ',
    ]);
  });

  describe('a lookup that can point at several objects', () => {
    /** A feed item's parent: it may not be left empty, and it can be one of several objects. */
    const FEED_FIELDS: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'ParentId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account', 'FeedItem', 'Opportunity', 'Quote'],
        nillable: false,
      },
    ];
    const QUOTE_ID = '0Q0AP00ORPHAN12';
    /** The source org's key prefixes. */
    const PREFIXES: Record<string, string> = {
      Account: '001',
      FeedItem: '0D5',
      Opportunity: '006',
      Quote: '0Q0',
    };
    /** The run telling the object of an id among the candidates, by its key prefix. */
    const objectOfById = () =>
      vi.fn(async (id: string, candidates: readonly string[]) =>
        candidates.find((object) => PREFIXES[object] === id.slice(0, 3)),
      );

    it('looks for the parent in the object its id belongs to, not in the first one the lookup names', async () => {
      // `ParentId` names its objects in alphabetical order: looked for among
      // the accounts, a quote was never found.
      const deps = makeDeps({
        queryRecords: vi
          .fn<ExpanderDeps['queryRecords']>()
          .mockResolvedValue([{ Id: QUOTE_ID, Name: 'Renewal' }]),
        insertRecords: vi
          .fn<ExpanderDeps['insertRecords']>()
          .mockResolvedValue([{ id: '0Q0NEW', success: true, errors: [] }]),
      });
      const objectOf = objectOfById();
      const { input } = makeInput(deps, {
        node: makeNode('FeedItem'),
        fieldInfos: FEED_FIELDS,
        records: [{ Id: '0D5OLD1', ParentId: QUOTE_ID }],
        objectOf,
      });
      const expander = new OrphanExpander(deps);

      await expander.expandForNode(input);

      expect(objectOf).toHaveBeenCalledWith(QUOTE_ID, [
        'Account',
        'FeedItem',
        'Opportunity',
        'Quote',
      ]);
      expect(vi.mocked(deps.describeFields).mock.calls.map(([, object]) => object)).toEqual([
        'Quote',
        'Quote',
      ]);
      expect(vi.mocked(deps.queryRecords).mock.calls[0][1]).toBe(
        `SELECT Id, Name, OwnerId FROM Quote WHERE Id = '${QUOTE_ID}'`,
      );
      expect(vi.mocked(deps.insertRecords).mock.calls[0][1]).toBe('Quote');
      expect(input.remapper.get(QUOTE_ID)).toBe('0Q0NEW');
      expect(expander.buildErrorReport()).toBeNull();
    });

    it('leaves the parent alone when the run cannot tell which object its id belongs to', async () => {
      // A feed item posted on a user: an object no copy writes, and none
      // of those the parent is looked for in.
      const deps = makeDeps();
      const { input } = makeInput(deps, {
        node: makeNode('FeedItem'),
        fieldInfos: FEED_FIELDS,
        records: [{ Id: '0D5OLD1', ParentId: '005AP00000USER1' }],
        objectOf: objectOfById(),
      });
      const expander = new OrphanExpander(deps);

      await expander.expandForNode(input);

      expect(deps.describeFields).not.toHaveBeenCalled();
      expect(deps.queryRecords).not.toHaveBeenCalled();
      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(expander.buildErrorReport()).toBeNull();
    });

    it('leaves a parent of the node’s own object to the node', async () => {
      const deps = makeDeps();
      const { input } = makeInput(deps, {
        node: makeNode('FeedItem'),
        fieldInfos: FEED_FIELDS,
        records: [{ Id: '0D5OLD1', ParentId: '0D5AP00000POST1' }],
        objectOf: objectOfById(),
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(deps.describeFields).not.toHaveBeenCalled();
      expect(deps.insertRecords).not.toHaveBeenCalled();
    });
  });

  it('does nothing when disabled', async () => {
    const deps = makeDeps();
    const { input } = makeInput(deps, { enabled: false });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.queryRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('does nothing when the budget is already exhausted', async () => {
    const deps = makeDeps();
    const { input } = makeInput(deps, { maxExpansions: 0 });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('respects the maxExpansions cap across eligible orphans', async () => {
    const deps = makeDeps();
    const { input } = makeInput(deps, {
      records: [
        { Id: '02iA', AccountId: '001AP00ORPHAN12' },
        { Id: '02iB', AccountId: '001AP00ORPHAN34' },
        { Id: '02iC', AccountId: '001AP00ORPHAN56' },
      ],
      maxExpansions: 2,
    });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.insertRecords).toHaveBeenCalledTimes(2);
  });

  it('skips nillable (non-required) references', async () => {
    const deps = makeDeps();
    const fields = ASSET_FIELDS.map((f) => ({ ...f, nillable: true }));
    const { input } = makeInput(deps, { fieldInfos: fields });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('refuses to expand excluded system objects (User)', async () => {
    const deps = makeDeps();
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
        nillable: false,
      },
    ];
    const { input } = makeInput(deps, {
      fieldInfos: fields,
      records: [{ Id: '02iOLD1', OwnerId: '005USER0000001' }],
    });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('skips self-references (same-object parents)', async () => {
    const deps = makeDeps();
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'ParentId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Asset'],
        nillable: false,
      },
    ];
    const { input } = makeInput(deps, {
      fieldInfos: fields,
      records: [{ Id: '02iOLD1', ParentId: '02iPARENT000001' }],
    });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('skips orphans already present in the remapper', async () => {
    const deps = makeDeps();
    const remapper = new IdRemapper();
    remapper.add(ORPHAN_ID, '001ALREADY');
    const { input } = makeInput(deps, { remapper });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.queryRecords).not.toHaveBeenCalled();
  });

  it('negative-caches failed expansions and reports them once', async () => {
    const deps = makeDeps({
      insertRecords: vi
        .fn<ExpanderDeps['insertRecords']>()
        .mockResolvedValue([{ id: '', success: false, errors: ['REQUIRED_FIELD_MISSING'] }]),
    });
    const { input } = makeInput(deps);
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);
    await expander.expandForNode(input); // same orphan again — must not retry

    expect(deps.queryRecords).toHaveBeenCalledTimes(1);
    const report = expander.buildErrorReport();
    expect(report).not.toBeNull();
    expect(report?.objectApiName).toBe('__expandOrphanParents__');
    expect(report?.failedCount).toBe(1);
    expect(report?.attemptedCount).toBe(0); // only successful expansions count
    expect(report?.samples[0].messages).toEqual(['REQUIRED_FIELD_MISSING']);
  });

  it('says the parent produced no new id when the target answers its insert with nothing', async () => {
    const deps = makeDeps({
      insertRecords: vi.fn<ExpanderDeps['insertRecords']>().mockResolvedValue([]),
    });
    const { input } = makeInput(deps);
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);

    expect(expander.buildErrorReport()?.samples[0].messages).toEqual([
      'Orphan parent expansion produced no new id',
    ]);
  });

  it('captures invalid record IDs as error samples instead of throwing', async () => {
    const deps = makeDeps();
    const { input } = makeInput(deps, {
      records: [{ Id: '02iOLD1', AccountId: 'NOT-A-VALID-ID!' }],
    });
    const expander = new OrphanExpander(deps);
    await expander.expandForNode(input);

    expect(deps.queryRecords).not.toHaveBeenCalled();
    const report = expander.buildErrorReport();
    expect(report?.samples[0].messages[0]).toContain('Invalid Salesforce record ID');
  });

  it('refuses a malformed parent object name before any describe goes out', async () => {
    const deps = makeDeps();
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'Weird__c',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Bad/../Name'],
        nillable: false,
      },
    ];
    const { input } = makeInput(deps, {
      fieldInfos: fields,
      records: [{ Id: '02iOLD1', Weird__c: ORPHAN_ID }],
    });
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);

    expect(deps.describeFields).not.toHaveBeenCalled();
    expect(deps.queryRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
    const report = expander.buildErrorReport();
    expect(report?.samples).toHaveLength(1);
    expect(report?.samples[0].recordSummary).toBe(`Bad/../Name/${ORPHAN_ID}`);
  });

  it('does not expand a required reference to a job table discovery also excludes', async () => {
    const deps = makeDeps();
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'AsyncApexJobId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['AsyncApexJob'],
        nillable: false,
      },
    ];
    const { input } = makeInput(deps, {
      fieldInfos: fields,
      records: [{ Id: '02iOLD1', AsyncApexJobId: '707AP00000JOB01' }],
    });

    await new OrphanExpander(deps).expandForNode(input);

    expect(deps.describeFields).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('copies a Person Account parent without its computed Name, keeping __pc fields', async () => {
    const deps = makeDeps({
      describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Name', queryable: true, createable: true, isReference: false },
        { name: 'LastName', queryable: true, createable: true, isReference: false },
        { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
        { name: 'Loyalty__pc', queryable: true, createable: true, isReference: false },
      ]),
      queryRecords: vi.fn<ExpanderDeps['queryRecords']>().mockResolvedValue([
        {
          Id: ORPHAN_ID,
          Name: 'Jane Doe',
          LastName: 'Doe',
          // The SOAP-normalized form some jsforce paths return.
          IsPersonAccount: 1,
          Loyalty__pc: 'Gold',
        },
      ]),
    });
    const { input } = makeInput(deps);

    await new OrphanExpander(deps).expandForNode(input);

    const [, objectName, payload] = vi.mocked(deps.insertRecords).mock.calls[0];
    expect(objectName).toBe('Account');
    expect(payload[0]).toEqual({ LastName: 'Doe', Loyalty__pc: 'Gold' });
  });

  it("never sends a person account's contact on its own, and says why", async () => {
    // A contact role's contact, out of the clone's reach, is a person
    // account's. The platform writes it with its account; sent alone, with
    // its account's lookup left out as every parent's are, it would stand as
    // a contact of no account beside the platform's.
    const CONTACT_ID = '003AP00PERSON12';
    const deps = makeDeps({
      describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'LastName', queryable: true, createable: true, isReference: false },
        { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
      ]),
      queryRecords: vi
        .fn<ExpanderDeps['queryRecords']>()
        .mockResolvedValue([{ Id: CONTACT_ID, LastName: 'Doe', IsPersonAccount: true }]),
    });
    const { input } = makeInput(deps, {
      node: makeNode('CaseContactRole'),
      fieldInfos: [
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'ContactId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Contact'],
          nillable: false,
        },
      ],
      records: [{ Id: '03jOLD1', ContactId: CONTACT_ID }],
    });
    const expander = new OrphanExpander(deps);

    await expander.expandForNode(input);

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(input.remapper.get(CONTACT_ID)).toBeUndefined();
    expect(expander.buildErrorReport()?.samples).toEqual([
      {
        recordSummary: `Contact/${CONTACT_ID}`,
        messages: [
          "Not copied: a person account's contact is written by the platform with its account, never on its own",
        ],
      },
    ]);
  });

  it('drops __pc fields from a Business Account parent', async () => {
    const deps = makeDeps({
      describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Name', queryable: true, createable: true, isReference: false },
        { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
        { name: 'Loyalty__pc', queryable: true, createable: true, isReference: false },
      ]),
      queryRecords: vi
        .fn<ExpanderDeps['queryRecords']>()
        .mockResolvedValue([
          { Id: ORPHAN_ID, Name: 'Acme', IsPersonAccount: null, Loyalty__pc: 'Gold' },
        ]),
    });
    const { input } = makeInput(deps);

    await new OrphanExpander(deps).expandForNode(input);

    const [, , payload] = vi.mocked(deps.insertRecords).mock.calls[0];
    expect(payload[0]).toEqual({ Name: 'Acme' });
  });

  it("copies a parent without the fields the run leaves out for holding a file's content", async () => {
    const address = `/services/data/v66.0/sobjects/Account/${ORPHAN_ID}/Logo__c`;
    const deps = makeDeps({
      describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Name', queryable: true, createable: true, isReference: false },
        { name: 'Logo__c', queryable: true, createable: true, isReference: false, type: 'base64' },
      ]),
      queryRecords: vi
        .fn<ExpanderDeps['queryRecords']>()
        .mockImplementation(async (_org, soql) =>
          soql.includes('Logo__c')
            ? [{ Id: ORPHAN_ID, Name: 'Acme', Logo__c: address }]
            : [{ Id: ORPHAN_ID, Name: 'Acme' }],
        ),
    });
    const leftOut: string[] = [];
    const { input } = makeInput(deps, {
      withoutFileContent: (objectApiName, fields) => {
        leftOut.push(
          ...fields.filter((f) => f.type === 'base64').map((f) => `${objectApiName}.${f.name}`),
        );
        return fields.filter((f) => f.type !== 'base64');
      },
    });

    await new OrphanExpander(deps).expandForNode(input);

    const [, , payload] = vi.mocked(deps.insertRecords).mock.calls[0];
    expect(payload[0]).toEqual({ Name: 'Acme' });
    expect(vi.mocked(deps.queryRecords).mock.calls[0][1]).not.toContain('Logo__c');
    expect(leftOut).toEqual(['Account.Logo__c']);
  });

  describe('a parent the platform writes itself', () => {
    const CHANGE = '0D5AP0000CHANGE'; // 15 alnum — passes SF_RECORD_ID_RE
    const COMMENT_FIELDS: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'FeedItemId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['FeedItem'],
        nillable: false,
      },
    ];
    const feedItemDeps = (): ExpanderDeps =>
      makeDeps({
        describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Type', queryable: true, createable: true, isReference: false },
        ]),
        queryRecords: vi
          .fn<ExpanderDeps['queryRecords']>()
          .mockResolvedValue([{ Id: CHANGE, Type: 'TrackedChange' }]),
      });

    it('never sends a tracked change it reads, notes it, and reports nothing failed', async () => {
      // Sent, the platform refuses it: "Cannot directly insert FeedItem with
      // type TrackedChange".
      const deps = feedItemDeps();
      const leftToThePlatform = new RowsLeftToThePlatform();
      const { input } = makeInput(deps, {
        node: makeNode('FeedComment'),
        fieldInfos: COMMENT_FIELDS,
        records: [{ Id: '0D7AP0000COMMENT', FeedItemId: CHANGE }],
        leftToThePlatform,
      });
      const expander = new OrphanExpander(deps);

      await expander.expandForNode(input);

      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(leftToThePlatform.has(CHANGE)).toBe(true);
      expect(input.remapper.get(CHANGE)).toBeUndefined();
      expect(expander.buildErrorReport()).toBeNull();
    });

    it('does not read again a parent already left to the platform', async () => {
      const deps = feedItemDeps();
      const leftToThePlatform = new RowsLeftToThePlatform();
      leftToThePlatform.keep('FeedItem', [{ Id: CHANGE, Type: 'TrackedChange' }]);
      const { input } = makeInput(deps, {
        node: makeNode('FeedComment'),
        fieldInfos: COMMENT_FIELDS,
        records: [{ Id: '0D7AP0000COMMENT', FeedItemId: CHANGE }],
        leftToThePlatform,
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(deps.queryRecords).not.toHaveBeenCalled();
    });
  });

  it('expands more than one wave of orphans (concurrency 4)', async () => {
    const deps = makeDeps();
    const { input } = makeInput(deps, {
      records: Array.from({ length: 6 }, (_, i) => ({
        Id: `02i${i}`,
        AccountId: `001AP00ORPHAN${i}${i}`,
      })),
    });
    await new OrphanExpander(deps).expandForNode(input);
    expect(deps.insertRecords).toHaveBeenCalledTimes(6);
  });

  describe("a parent goes in on the rules the run's own rows go in on", () => {
    /** The parent's record type in the source, and the one the mapping gives it in the target. */
    const SOURCE_RETAIL = '012AP0000000001AAA';
    const TARGET_RETAIL = '012AP0000000101AAA';
    const MAPPINGS = [
      { sourceId: SOURCE_RETAIL, targetId: TARGET_RETAIL, developerName: 'Retail' },
    ];
    const RULE = 'Enter the phone in international format';

    /** An account with a phone and a restricted picklist, described alike in both orgs. */
    const PARENT_FIELDS: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'Phone', queryable: true, createable: true, isReference: false, type: 'phone' },
      {
        name: 'RecordTypeId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['RecordType'],
      },
      {
        name: 'Tier__c',
        queryable: true,
        createable: true,
        isReference: false,
        type: 'picklist',
        restrictedPicklist: true,
        picklistValues: ['Gold', 'Silver', 'Bronze'],
      },
    ];
    const PARENT_ROW = {
      Id: ORPHAN_ID,
      Name: 'Acme',
      Phone: '555-0100',
      RecordTypeId: SOURCE_RETAIL,
      Tier__c: 'Gold',
    };
    /** What the target's record type Retail keeps of Tier__c: "Gold" is active, and not kept. */
    const RETAIL: RecordTypePicklists = new Map([
      ['Tier__c', { values: ['Silver', 'Bronze'], defaultValue: 'Silver' }],
    ]);

    const parentDeps = (
      insertRecords = vi
        .fn<ExpanderDeps['insertRecords']>()
        .mockResolvedValue([{ id: '001NEW', success: true, errors: [] }]),
      row: Record<string, unknown> = PARENT_ROW,
    ) =>
      makeDeps({
        describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue(PARENT_FIELDS),
        queryRecords: vi.fn<ExpanderDeps['queryRecords']>().mockResolvedValue([{ ...row }]),
        insertRecords,
      });

    /** The rule's refusal of the phone, as the writers read it from the platform. */
    const refusedOnThePhone = (): InsertResult =>
      toSaveOutcome(
        {
          success: false,
          errors: [
            { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: RULE, fields: ['Phone'] },
          ],
        },
        'Account',
      );

    it("replaces a restricted value the parent's record type does not keep, and counts it in the run's tally", async () => {
      // Copied as read, the parent was refused — "bad value for restricted
      // picklist field" — and the row that needed it with it.
      const deps = parentDeps();
      const read = vi.fn(async (_object: string, _recordTypeId: string) => RETAIL);
      const picklistChanges = new PicklistChangeTally();
      const { input } = makeInput(deps, {
        recordTypeMappings: MAPPINGS,
        recordTypeMapper: new RecordTypeMapper(),
        recordTypePicklists: new RecordTypePicklistReads(read),
        picklistChanges,
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(vi.mocked(deps.insertRecords).mock.calls[0][2]).toEqual([
        { Name: 'Acme', Phone: '555-0100', RecordTypeId: TARGET_RETAIL, Tier__c: 'Silver' },
      ]);
      expect(read.mock.calls).toEqual([['Account', TARGET_RETAIL]]);
      expect(picklistChanges.list()).toEqual([
        {
          objectApiName: 'Account',
          field: 'Tier__c',
          reason: 'record-type',
          values: ['Gold'],
          rows: 1,
          recordType: 'Retail',
          replacedBy: 'Silver',
          replacement: 'default',
        },
      ]);
      expect(input.remapper.get(ORPHAN_ID)).toBe('001NEW');
    });

    it('asks nothing more of a record type the run has read for its own rows', async () => {
      const deps = parentDeps();
      const read = vi.fn(async (_object: string, _recordTypeId: string) => RETAIL);
      const reads = new RecordTypePicklistReads(read);
      // The account node's rows, read before the parent was met.
      await reads.forRows({
        objectApiName: 'Account',
        rows: [{ ...PARENT_ROW, Id: '001AP00000OTHER' }],
        fields: new Map([['Tier__c', { multi: false, restricted: true, required: false }]]),
        written: () => true,
        recordTypeMappings: MAPPINGS,
      });
      const { input } = makeInput(deps, {
        recordTypeMappings: MAPPINGS,
        recordTypeMapper: new RecordTypeMapper(),
        recordTypePicklists: reads,
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.insertRecords).mock.calls[0][2][0]).toMatchObject({
        Tier__c: 'Silver',
      });
    });

    it('leaves out of a parent a restricted value the target does not hold', async () => {
      const deps = parentDeps(undefined, { ...PARENT_ROW, Tier__c: 'Platinum' });
      const picklistChanges = new PicklistChangeTally();
      const { input } = makeInput(deps, { picklistChanges });

      await new OrphanExpander(deps).expandForNode(input);

      expect(vi.mocked(deps.insertRecords).mock.calls[0][2]).toEqual([
        { Name: 'Acme', Phone: '555-0100', RecordTypeId: SOURCE_RETAIL },
      ]);
      expect(picklistChanges.list()).toEqual([
        {
          objectApiName: 'Account',
          field: 'Tier__c',
          reason: 'not-in-target',
          values: ['Platinum'],
          rows: 1,
        },
      ]);
    });

    it('copies it without the fields the user excluded, and a renamed one under the name the target has, as a row is', async () => {
      // Copied as read, a parent carried a field the user excluded from every
      // write, and a renamed one under a name the target may not have. The
      // field map answers for what the renamed one takes: not checked.
      const deps = makeDeps({
        describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
          ...PARENT_FIELDS,
          {
            name: 'Level__c',
            queryable: true,
            createable: true,
            isReference: false,
            type: 'picklist',
            restrictedPicklist: true,
            picklistValues: ['Bronze'],
          },
        ]),
        queryRecords: vi.fn<ExpanderDeps['queryRecords']>().mockResolvedValue([{ ...PARENT_ROW }]),
      });
      const { input } = makeInput(deps, {
        fieldExclusions: { Account: ['Phone'] },
        fieldMappings: { Account: { Tier__c: 'Level__c' } },
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(vi.mocked(deps.insertRecords).mock.calls[0][2]).toEqual([
        { Name: 'Acme', RecordTypeId: SOURCE_RETAIL, Level__c: 'Gold' },
      ]);
    });

    it("says once a record type whose values could not be read, and checks the parent's values against each field's", async () => {
      const deps = parentDeps();
      const notes: Array<[string, unknown]> = [];
      const { input } = makeInput(deps, {
        recordTypeMappings: MAPPINGS,
        recordTypeMapper: new RecordTypeMapper(),
        recordTypePicklists: new RecordTypePicklistReads(async () => {
          throw new Error('INVALID_TYPE: not supported by the UI API');
        }),
        onRecordTypeNote: (object, note) => notes.push([object, note]),
      });

      await new OrphanExpander(deps).expandForNode(input);

      expect(notes).toEqual([
        ['Account', { recordType: 'Retail', error: 'INVALID_TYPE: not supported by the UI API' }],
      ]);
      // Active in the target, "Gold" goes as read.
      expect(vi.mocked(deps.insertRecords).mock.calls[0][2][0]).toMatchObject({ Tier__c: 'Gold' });
    });

    it('writes a parent a validation rule refused on a field it named once more without it, and counts it', async () => {
      // Refused on its phone, the parent went down, and the row that needed
      // it with it.
      const insertRecords = vi
        .fn<ExpanderDeps['insertRecords']>()
        .mockResolvedValueOnce([refusedOnThePhone()])
        .mockResolvedValueOnce([{ id: '001NEW', success: true, errors: [] }]);
      const deps = parentDeps(insertRecords);
      const written: Array<[string, WrittenWithoutFields]> = [];
      const { input } = makeInput(deps, {
        onWrittenWithoutFields: (object, without) => written.push([object, without]),
      });
      const expander = new OrphanExpander(deps);

      await expander.expandForNode(input);

      expect(insertRecords.mock.calls.map(([, , rows]) => rows)).toEqual([
        [{ Name: 'Acme', Phone: '555-0100', RecordTypeId: SOURCE_RETAIL, Tier__c: 'Gold' }],
        [{ Name: 'Acme', RecordTypeId: SOURCE_RETAIL, Tier__c: 'Gold' }],
      ]);
      expect(input.remapper.get(ORPHAN_ID)).toBe('001NEW');
      expect(written).toEqual([
        [
          'Account',
          {
            rows: 1,
            fields: [
              {
                field: 'Phone',
                refusedBy: 'validation-rule',
                reason: `FIELD_CUSTOM_VALIDATION_EXCEPTION: ${RULE}`,
                rows: 1,
              },
            ],
          },
        ],
      ]);
      expect(expander.buildErrorReport()).toBeNull();
    });

    it('writes a parent a restricted picklist refused for its value once more without the field, and counts it', async () => {
      // Active in the target, "Gold" passes the check; the record type the
      // parent goes in with takes none of the field's values all the same.
      const insertRecords = vi
        .fn<ExpanderDeps['insertRecords']>()
        .mockResolvedValueOnce([
          toSaveOutcome(
            {
              success: false,
              errors: [
                {
                  statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
                  message: 'bad value for restricted picklist field: Gold',
                  fields: ['Tier__c'],
                },
              ],
            },
            'Account',
          ),
        ])
        .mockResolvedValueOnce([{ id: '001NEW', success: true, errors: [] }]);
      const deps = parentDeps(insertRecords);
      const written: Array<[string, WrittenWithoutFields]> = [];
      const { input } = makeInput(deps, {
        onWrittenWithoutFields: (object, without) => written.push([object, without]),
      });
      const expander = new OrphanExpander(deps);

      await expander.expandForNode(input);

      expect(insertRecords.mock.calls.map(([, , rows]) => rows)).toEqual([
        [{ Name: 'Acme', Phone: '555-0100', RecordTypeId: SOURCE_RETAIL, Tier__c: 'Gold' }],
        [{ Name: 'Acme', Phone: '555-0100', RecordTypeId: SOURCE_RETAIL }],
      ]);
      expect(input.remapper.get(ORPHAN_ID)).toBe('001NEW');
      expect(written).toEqual([
        [
          'Account',
          {
            rows: 1,
            fields: [
              {
                field: 'Tier__c',
                refusedBy: 'restricted-picklist',
                reason:
                  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold',
                rows: 1,
              },
            ],
          },
        ],
      ]);
      expect(expander.buildErrorReport()).toBeNull();
    });

    it('fails a parent refused again, never sent a third time, with both refusals', async () => {
      const insertRecords = vi
        .fn<ExpanderDeps['insertRecords']>()
        .mockResolvedValueOnce([refusedOnThePhone()])
        .mockResolvedValueOnce([
          { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Give a phone'] },
        ]);
      const deps = parentDeps(insertRecords);
      const onWrittenWithoutFields = vi.fn();
      const { input } = makeInput(deps, { onWrittenWithoutFields });
      const expander = new OrphanExpander(deps);

      await expander.expandForNode(input);

      expect(insertRecords).toHaveBeenCalledTimes(2);
      expect(input.remapper.get(ORPHAN_ID)).toBeUndefined();
      expect(onWrittenWithoutFields).not.toHaveBeenCalled();
      expect(expander.buildErrorReport()?.samples).toEqual([
        {
          recordSummary: `Account/${ORPHAN_ID}`,
          messages: [
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: Give a phone',
            `Sent again without Phone after the first refusal: FIELD_CUSTOM_VALIDATION_EXCEPTION: ${RULE} [Phone]`,
          ],
        },
      ]);
    });

    it('sends once a parent a validation rule refused without naming a field', async () => {
      const unnamed = toSaveOutcome(
        {
          success: false,
          errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: RULE, fields: [] }],
        },
        'Account',
      );
      const insertRecords = vi.fn<ExpanderDeps['insertRecords']>().mockResolvedValue([unnamed]);
      const deps = parentDeps(insertRecords);
      const expander = new OrphanExpander(deps);
      const { input } = makeInput(deps);

      await expander.expandForNode(input);

      expect(insertRecords).toHaveBeenCalledTimes(1);
      expect(expander.buildErrorReport()?.samples[0].messages).toEqual([
        `FIELD_CUSTOM_VALIDATION_EXCEPTION: ${RULE}`,
      ]);
    });

    describe('a person account', () => {
      const PERSON = '001AP00PERSON12';
      const PERSON_CONTACT = '003AP00PERSON12';
      const PLATFORM_CONTACT = '003TG00PLATFORM';
      /** A case whose account and contact may not be left empty, both a person account's. */
      const CASE_FIELDS: FieldInfo[] = [
        { name: 'Id', queryable: true, createable: false, isReference: false },
        ...(['Account', 'Contact'] as const).map((object): FieldInfo => ({
          name: `${object}Id`,
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: [object],
          nillable: false,
        })),
      ];
      const personDeps = (insertRecords?: ExpanderDeps['insertRecords']) => ({
        ...makeDeps({
          describeFields: vi.fn<ExpanderDeps['describeFields']>(async (_org, object) => [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'LastName', queryable: true, createable: true, isReference: false },
            { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
            ...(object === 'Account'
              ? [
                  {
                    name: 'PersonContactId',
                    queryable: true,
                    createable: false,
                    updateable: false,
                    isReference: true,
                    referenceTo: ['Contact'],
                  },
                ]
              : []),
          ]),
          queryRecords: vi.fn<ExpanderDeps['queryRecords']>(async (_org, soql) =>
            soql.includes('FROM Account')
              ? [
                  {
                    Id: PERSON,
                    LastName: 'Doe',
                    IsPersonAccount: true,
                    PersonContactId: PERSON_CONTACT,
                  },
                ]
              : [{ Id: PERSON_CONTACT, LastName: 'Doe', IsPersonAccount: true }],
          ),
          ...(insertRecords ? { insertRecords } : {}),
        }),
        describeObject: vi.fn(async () => ({ keyPrefix: '001', recordTypes: [] })),
      });
      /** The run's link: the contact the platform wrote with each account, mapped from the source's. */
      const linkingThrough = (remapper: IdRemapper) =>
        vi.fn(async (accounts: readonly Record<string, unknown>[]) => {
          for (const account of accounts) {
            remapper.addExisting(String(account['PersonContactId']), PLATFORM_CONTACT);
          }
        });

      it('links the contact the platform wrote with a person account it copied, before any contact is copied', async () => {
        // The case needs both. Copied side by side, the contact was refused as
        // a person account's — never copied on its own — and the case with it.
        const deps = personDeps();
        const remapper = new IdRemapper();
        const linkPersonContacts = linkingThrough(remapper);
        const { input } = makeInput(deps, {
          node: makeNode('Case'),
          fieldInfos: CASE_FIELDS,
          records: [{ Id: '500OLD1', AccountId: PERSON, ContactId: PERSON_CONTACT }],
          remapper,
          linkPersonContacts,
        });
        const expander = new OrphanExpander(deps);

        await expander.expandForNode(input);

        expect(vi.mocked(deps.insertRecords).mock.calls.map(([, object]) => object)).toEqual([
          'Account',
        ]);
        expect(linkPersonContacts).toHaveBeenCalledWith([
          { Id: PERSON, LastName: 'Doe', IsPersonAccount: true, PersonContactId: PERSON_CONTACT },
        ]);
        expect(remapper.get(PERSON)).toBe('001NEW');
        expect(remapper.get(PERSON_CONTACT)).toBe(PLATFORM_CONTACT);
        // The contact was never read: nothing was left to copy.
        expect(
          vi.mocked(deps.queryRecords).mock.calls.some(([, soql]) => soql.includes('FROM Contact')),
        ).toBe(false);
        expect(expander.buildErrorReport()).toBeNull();
      });

      it('links the contact of a person account the target already held, found by the refusal of its copy', async () => {
        const deps = personDeps(
          vi.fn<ExpanderDeps['insertRecords']>().mockResolvedValue([
            {
              id: '',
              success: false,
              errors: [
                'DUPLICATE_VALUE: duplicate value found: Ext__c duplicates value on record with id: 001Fk00000AbCdE',
              ],
            },
          ]),
        );
        const remapper = new IdRemapper();
        const linkPersonContacts = linkingThrough(remapper);
        const { input } = makeInput(deps, {
          records: [{ Id: '02iOLD1', AccountId: PERSON }],
          remapper,
          linkPersonContacts,
        });

        await new OrphanExpander(deps).expandForNode(input);

        expect(remapper.isExisting(PERSON)).toBe(true);
        expect(linkPersonContacts).toHaveBeenCalledTimes(1);
        expect(remapper.get(PERSON_CONTACT)).toBe(PLATFORM_CONTACT);
      });

      it('copies a person account as the business one a target without person accounts makes of it, by its name', async () => {
        // Its name left out as a person account's is, the target — which
        // computes none — refused it: REQUIRED_FIELD_MISSING, Name.
        const deps = makeDeps({
          describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'Name', queryable: true, createable: true, isReference: false },
            { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
          ]),
          queryRecords: vi
            .fn<ExpanderDeps['queryRecords']>()
            .mockResolvedValue([{ Id: PERSON, Name: 'Jane Doe', IsPersonAccount: true }]),
        });
        const { input } = makeInput(deps, {
          records: [{ Id: '02iOLD1', AccountId: PERSON }],
          personAccountsInTarget: async () => false,
        });

        await new OrphanExpander(deps).expandForNode(input);

        expect(vi.mocked(deps.insertRecords).mock.calls[0][2]).toEqual([{ Name: 'Jane Doe' }]);
      });

      it("copies a person account's contact as any contact in a target without person accounts", async () => {
        // The target writes no contact with an account there: refused as one
        // the platform writes, the contact never went in, nor the row needing it.
        const deps = personDeps(
          vi
            .fn<ExpanderDeps['insertRecords']>()
            .mockResolvedValue([{ id: '003NEW', success: true, errors: [] }]),
        );
        const { input } = makeInput(deps, {
          node: makeNode('CaseContactRole'),
          fieldInfos: [CASE_FIELDS[0], CASE_FIELDS[2]],
          records: [{ Id: '03jOLD1', ContactId: PERSON_CONTACT }],
          personAccountsInTarget: async () => false,
        });
        const expander = new OrphanExpander(deps);

        await expander.expandForNode(input);

        expect(vi.mocked(deps.insertRecords).mock.calls).toEqual([
          ['tgt', 'Contact', [{ LastName: 'Doe' }]],
        ]);
        expect(input.remapper.get(PERSON_CONTACT)).toBe('003NEW');
        expect(expander.buildErrorReport()).toBeNull();
      });

      it('copies a person account the target takes as a business one as such: its name kept, no field only a person account holds', async () => {
        // Its record type in the target a business account's, the target
        // refused it without its name, and with its person fields.
        const PERSON_TYPE = '012AP0000000001AAA';
        const read = {
          Id: PERSON,
          Name: 'Jane Doe',
          LastName: 'Doe',
          PersonEmail: 'person@example.com',
          Tier__pc: 'Gold',
          RecordTypeId: PERSON_TYPE,
          IsPersonAccount: true,
        };
        const deps = makeDeps({
          describeFields: vi.fn<ExpanderDeps['describeFields']>().mockResolvedValue([
            { name: 'Id', queryable: true, createable: false, isReference: false },
            ...['Name', 'LastName', 'PersonEmail', 'Tier__pc'].map((name): FieldInfo => ({
              name,
              queryable: true,
              createable: true,
              isReference: false,
            })),
            {
              name: 'RecordTypeId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['RecordType'],
            },
            { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
          ]),
          queryRecords: vi.fn<ExpanderDeps['queryRecords']>().mockResolvedValue([{ ...read }]),
        });
        const businessAccountsAmong = vi.fn(
          async (rows: readonly Record<string, unknown>[], _recordTypeWritten: boolean) =>
            new Set(rows),
        );
        const { input } = makeInput(deps, {
          records: [{ Id: '02iOLD1', AccountId: PERSON }],
          personAccountsInTarget: async () => true,
          businessAccountsAmong,
        });

        await new OrphanExpander(deps).expandForNode(input);

        expect(vi.mocked(deps.insertRecords).mock.calls[0][2]).toEqual([
          { Name: 'Jane Doe', RecordTypeId: PERSON_TYPE },
        ]);
        // Asked as the run asks of its own rows, written with their record type.
        expect(businessAccountsAmong).toHaveBeenCalledWith([read], true);
      });

      it("copies a person account's contact as a contact of its own when the target wrote none with its account", async () => {
        // Its account is in the target as a business one: refused as a contact
        // the platform writes, it never went in, nor the row needing it.
        const deps = personDeps(
          vi
            .fn<ExpanderDeps['insertRecords']>()
            .mockResolvedValue([{ id: '003NEW', success: true, errors: [] }]),
        );
        const { input } = makeInput(deps, {
          node: makeNode('CaseContactRole'),
          fieldInfos: [CASE_FIELDS[0], CASE_FIELDS[2]],
          records: [{ Id: '03jOLD1', ContactId: PERSON_CONTACT }],
          personAccountsInTarget: async () => true,
          contactOnItsOwn: (sourceId) => sourceId === PERSON_CONTACT,
        });
        const expander = new OrphanExpander(deps);

        await expander.expandForNode(input);

        expect(vi.mocked(deps.insertRecords).mock.calls).toEqual([
          ['tgt', 'Contact', [{ LastName: 'Doe' }]],
        ]);
        expect(input.remapper.get(PERSON_CONTACT)).toBe('003NEW');
        expect(expander.buildErrorReport()).toBeNull();
      });

      it('asks no contact of a business account it copied', async () => {
        const deps = makeDeps();
        const linkPersonContacts = vi.fn(async () => undefined);
        const { input } = makeInput(deps, { linkPersonContacts });

        await new OrphanExpander(deps).expandForNode(input);

        expect(input.remapper.get(ORPHAN_ID)).toBe('001NEW');
        expect(linkPersonContacts).not.toHaveBeenCalled();
      });
    });
  });
});
