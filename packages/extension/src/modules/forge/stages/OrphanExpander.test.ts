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
    describeFields: vi
      .fn<ExpanderDeps['describeFields']>()
      .mockResolvedValue([
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
    // CR-007: parent registered in scope cache for multi-hop children.
    expect(input.scopeCache?.has('Account')).toBe(true);
    expect(expander.buildErrorReport()).toBeNull();
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
    expect(report?.attemptedCount).toBe(0); // only successful expansions count (CR-001)
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
