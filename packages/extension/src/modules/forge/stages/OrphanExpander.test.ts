import { describe, it, expect, vi } from 'vitest';
import { OrphanExpander, type OrphanExpansionInput } from './OrphanExpander.js';
import { IdRemapper } from '../IdRemapper.js';
import { RecordScopeCache } from '../RecordScopeCache.js';
import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';

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
      .mockResolvedValue([{ Id: ORPHAN_ID, Name: 'GAN ASSURANCES', OwnerId: '005USER' }]),
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
    expect(payload[0]).toEqual({ Name: 'GAN ASSURANCES' });
    expect(input.remapper.get(ORPHAN_ID)).toBe('001NEW');
    // Parent registered in scope cache for multi-hop children.
    expect(input.scopeCache?.has('Account')).toBe(true);
    expect(expander.buildErrorReport()).toBeNull();
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
    expect(expander.buildErrorReport()?.samples[0].messages).toEqual([
      'Orphan parent expansion produced no new id',
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
    expect(report?.samples[0].messages[0]).toContain('no new id');
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
});
