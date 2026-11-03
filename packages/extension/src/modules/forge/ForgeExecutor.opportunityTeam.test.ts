import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeWriteBoundary,
} from './ForgeExecutor.js';
import { leftOutLines, writePlanOf } from './ForgeRunGate.js';
import { finishedRunStatus } from './runResult.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { TeamSellingOrg } from '../../test/teamSellingOrg.js';
import { RehearsalWriter, rehearsalExecutorDeps } from './rehearsal/RehearsalWriter.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The clone of an opportunity between two orgs with Team Selling and Splits
 * on. Run for real, the target wrote, as it took the opportunity, its owner's
 * team member and its owner's Revenue split at 100 %; the clone sent both
 * again, without their user, and its Overlay split of the owner, written
 * first: the target refused all three — `REQUIRED_FIELD_MISSING [UserId]`, and
 * each split twice, `INVALID_CROSS_REFERENCE_KEY` "part of the opportunity
 * team" and `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY` "can't adjust necessary
 * split percentages from the opportunity owner's split" — and the run ended
 * partial. The target here answers as that org did (`TeamSellingOrg`).
 */

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable: true,
  isReference: false,
});
const lookup = (
  name: string,
  target: string,
  { required = false, updateable = true }: { required?: boolean; updateable?: boolean } = {},
): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable,
  isReference: true,
  referenceTo: [target],
  nillable: !required,
});

/** The fields of each object, as both orgs describe them. */
const FIELDS: Record<string, FieldInfo[]> = {
  Account: [idField, text('Name')],
  Opportunity: [
    idField,
    text('Name'),
    text('StageName'),
    lookup('AccountId', 'Account'),
    // The platform gives an opportunity sent without an owner the user the run writes as.
    { ...lookup('OwnerId', 'User', { required: true }), defaultedOnCreate: true },
  ],
  OpportunityTeamMember: [
    idField,
    lookup('OpportunityId', 'Opportunity', { required: true, updateable: false }),
    lookup('UserId', 'User', { required: true, updateable: false }),
    text('TeamMemberRole'),
    text('OpportunityAccessLevel'),
  ],
  OpportunitySplit: [
    idField,
    lookup('OpportunityId', 'Opportunity', { required: true, updateable: false }),
    lookup('SplitOwnerId', 'User', { required: true, updateable: false }),
    lookup('SplitTypeId', 'OpportunitySplitType'),
    text('SplitPercentage'),
    text('SplitNote'),
  ],
};

const SOURCE_OWNER = '005SRC000000001AAA';
const SOURCE_REP = '005SRC000000002AAA';
const SOURCE_REVENUE = '149SRC000000001AAA';
const SOURCE_OVERLAY = '149SRC000000002AAA';
const ACCOUNT = '001SRC000000001AAA';
const DEAL = '006SRC000000005AAA';
const OWNERS_MEMBER = '00qSRC000000001AAA';
const OWNERS_REVENUE = '049SRC000000001AAA';
const OWNERS_OVERLAY = '049SRC000000002AAA';

const RUNNING_USER = '005TGT000000001AAA';
const TARGET_REVENUE = '149TGT000000001AAA';
const TARGET_OVERLAY = '149TGT000000002AAA';

/** The deal of the real run: its owner's member, Revenue split at 100 % and Overlay split at 40 %. */
function sourceRows(): Record<string, FakeRow[]> {
  return {
    Account: [{ Id: ACCOUNT, Name: 'Customer' }],
    Opportunity: [
      {
        Id: DEAL,
        Name: 'Deal 05',
        StageName: 'Prospecting',
        AccountId: ACCOUNT,
        OwnerId: SOURCE_OWNER,
      },
    ],
    OpportunityTeamMember: [
      {
        Id: OWNERS_MEMBER,
        OpportunityId: DEAL,
        UserId: SOURCE_OWNER,
        TeamMemberRole: 'Opportunity Owner',
        OpportunityAccessLevel: 'Edit',
      },
    ],
    OpportunitySplit: [
      {
        Id: OWNERS_REVENUE,
        OpportunityId: DEAL,
        SplitOwnerId: SOURCE_OWNER,
        SplitTypeId: SOURCE_REVENUE,
        SplitPercentage: '100',
        SplitNote: null,
      },
      {
        Id: OWNERS_OVERLAY,
        OpportunityId: DEAL,
        SplitOwnerId: SOURCE_OWNER,
        SplitTypeId: SOURCE_OVERLAY,
        SplitPercentage: '40',
        SplitNote: 'Overlay credit',
      },
    ],
    OpportunitySplitType: [
      { Id: SOURCE_REVENUE, DeveloperName: 'Revenue' },
      { Id: SOURCE_OVERLAY, DeveloperName: 'Overlay' },
    ],
  };
}

/** The source with a second member, a sales rep, credited 40 % of the revenue: the owner keeps 60 %. */
function withARep(tables = sourceRows()): Record<string, FakeRow[]> {
  tables['OpportunityTeamMember'].push({
    Id: '00qSRC000000002AAA',
    OpportunityId: DEAL,
    UserId: SOURCE_REP,
    TeamMemberRole: 'Sales Rep',
    OpportunityAccessLevel: 'Read',
  });
  tables['OpportunitySplit'][0]['SplitPercentage'] = '60';
  tables['OpportunitySplit'].push({
    Id: '049SRC000000003AAA',
    OpportunityId: DEAL,
    SplitOwnerId: SOURCE_REP,
    SplitTypeId: SOURCE_REVENUE,
    SplitPercentage: '40',
    SplitNote: null,
  });
  return tables;
}

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 4,
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

const edge = (parent: string, child: string, required = false): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName: `${parent}To${child}`,
  type: 'lookup',
  ...(required ? { required: true } : {}),
});

/**
 * The graph discovery built around the opportunity, its splits met before its
 * team members, as the real run met them.
 */
function dealGraph(): ForgeGraph {
  return {
    nodes: [
      node('Opportunity', 0),
      node('Account', 1),
      node('OpportunitySplit', 1),
      node('OpportunityTeamMember', 1),
    ],
    edges: [
      edge('Account', 'Opportunity'),
      edge('Opportunity', 'OpportunitySplit', true),
      edge('Opportunity', 'OpportunityTeamMember', true),
    ],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

const ROOTED_AT_THE_DEAL = { rootRecordId: DEAL, rootObjectApiName: 'Opportunity' };

/** The objects the target answers statements on. */
const TARGET_READS =
  /\bFROM (Opportunity|OpportunityTeamMember|OpportunitySplit|OpportunitySplitType|User)\b/;

/**
 * The source holding `tables`, and a target with Team Selling and Splits on
 * that holds `users` besides the user the run writes as.
 */
function orgs(tables: Record<string, FakeRow[]> = sourceRows(), users: string[] = []) {
  const target = new TeamSellingOrg({
    runningUser: RUNNING_USER,
    users,
    splitTypes: [
      { Id: TARGET_REVENUE, DeveloperName: 'Revenue', IsTotalValidated: true },
      { Id: TARGET_OVERLAY, DeveloperName: 'Overlay', IsTotalValidated: false },
    ],
  });
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') return selectRows(tables, soql);
      return TARGET_READS.test(soql) ? target.query(soql) : [];
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) =>
      target.insert(object, rows),
    ),
    updateRecords: vi.fn(async (_org: string, _object: string, rows: Record<string, unknown>[]) =>
      rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
  } satisfies ForgeExecutorDeps;
  return { deps, target };
}

/** The deal's copy in the target. */
const copyOf = (target: TeamSellingOrg): string => String(target.tables['Opportunity'][0]['Id']);

describe('ForgeExecutor, an opportunity with Team Selling and Splits on', () => {
  it("links the owner's member and Revenue split to the platform's, and writes the owner's Overlay split once", async () => {
    const { deps, target } = orgs();
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      ROOTED_AT_THE_DEAL,
    );

    const deal = copyOf(target);
    expect(target.sent['OpportunityTeamMember']).toBeUndefined();
    expect(target.sent['OpportunitySplit']).toEqual([
      {
        OpportunityId: deal,
        SplitOwnerId: RUNNING_USER,
        SplitTypeId: TARGET_OVERLAY,
        SplitPercentage: '40',
        SplitNote: 'Overlay credit',
      },
    ]);
    // Nothing twice: the platform's member, its role kept, and one split of each type.
    expect(target.teamOf(deal)).toEqual([
      expect.objectContaining({ UserId: RUNNING_USER, TeamMemberRole: 'Opportunity Owner' }),
    ]);
    expect(
      target.splitsOf(deal).map((s) => [s['SplitOwnerId'], s['SplitTypeId'], s['SplitPercentage']]),
    ).toEqual([
      [RUNNING_USER, TARGET_REVENUE, '100'],
      [RUNNING_USER, TARGET_OVERLAY, '40'],
    ]);
    expect(summary.errors).toEqual([]);
    expect(summary.failedCount).toBe(0);
    expect(finishedRunStatus(summary)).toBe('success');
    expect(summary.linkedCount).toBe(2);
    // Linked, never written, and deleted by the platform with the opportunity.
    expect(summary.existingSourceIds).toEqual(
      expect.arrayContaining([OWNERS_MEMBER, OWNERS_REVENUE]),
    );
    expect(summary.withTheirRecordSourceIds).toEqual(
      expect.arrayContaining([OWNERS_MEMBER, OWNERS_REVENUE]),
    );
    expect(summary.withTheirRecordSourceIds).not.toContain(OWNERS_OVERLAY);
    const messages = said.map((event) => event.message);
    // The source's member gives the owner Edit; the platform's holds All.
    expect(messages).toContain(
      'Completed OpportunityTeamMember: 0 succeeded, 1 written by the platform with their opportunity, for its owner, 0 failed, ' +
        "1 linked without the source's OpportunityAccessLevel: the target's record keeps its own",
    );
    expect(messages).toContain(
      'Completed OpportunitySplit: 1 succeeded, 1 written by the platform with their opportunity, for its owner, 0 failed',
    );
  });

  it("writes a member before the splits of that member, which the platform takes from the owner's", async () => {
    // Two sandboxes of one production share their users' ids: the rep is a
    // user of the target too.
    const { deps, target } = orgs(withARep(), [SOURCE_REP]);

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_DEAL,
    );

    const deal = copyOf(target);
    expect(target.sent['OpportunityTeamMember']).toEqual([
      {
        OpportunityId: deal,
        UserId: SOURCE_REP,
        TeamMemberRole: 'Sales Rep',
        OpportunityAccessLevel: 'Read',
      },
    ]);
    expect(
      target.splitsOf(deal).map((s) => [s['SplitOwnerId'], s['SplitTypeId'], s['SplitPercentage']]),
    ).toEqual([
      [RUNNING_USER, TARGET_REVENUE, '60'],
      [RUNNING_USER, TARGET_OVERLAY, '40'],
      [SOURCE_REP, TARGET_REVENUE, '40'],
    ]);
    expect(summary.errors).toEqual([]);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('holds back a member whose user the target has no counterpart of, and its split, and says why', async () => {
    const { deps, target } = orgs(withARep());
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      ROOTED_AT_THE_DEAL,
    );

    expect(target.sent['OpportunityTeamMember']).toBeUndefined();
    expect(target.sent['OpportunitySplit']?.map((row) => row['SplitTypeId'])).toEqual([
      TARGET_OVERLAY,
    ]);
    expect(summary.failedCount).toBe(2);
    expect(finishedRunStatus(summary)).toBe('partial');
    const why =
      'names a user the target has no counterpart of: a team member and a split go in for ' +
      "the opportunity's owner, which is the owner of its copy in the target, for a user an " +
      'owner mapping gives, or for a user of the same id the target holds active.';
    expect(summary.errors).toEqual([
      {
        objectApiName: 'OpportunityTeamMember',
        stage: 'scope',
        failedCount: 1,
        attemptedCount: 0,
        samples: [
          { recordSummary: 'UserId → User (1 record)', messages: [`Not written: UserId ${why}`] },
        ],
      },
      {
        objectApiName: 'OpportunitySplit',
        stage: 'scope',
        failedCount: 1,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'SplitOwnerId → User (1 record)',
            messages: [`Not written: SplitOwnerId ${why}`],
          },
        ],
      },
    ]);
    expect(said.map((event) => event.message)).toContain(
      'Completed OpportunityTeamMember: 0 succeeded, 1 written by the platform with their opportunity, for its owner, 1 failed, 1 of them held back for want of their parent, ' +
        "1 linked without the source's OpportunityAccessLevel: the target's record keeps its own",
    );
  });

  it('writes a split under the user an owner mapping gives the owner, whose member the platform wrote', async () => {
    const MAPPED = '005TGT000000007AAA';
    const { deps, target } = orgs(sourceRows(), [MAPPED]);

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_DEAL, ownerMappings: { [SOURCE_OWNER]: MAPPED } },
    );

    const deal = copyOf(target);
    expect(target.tables['Opportunity'][0]['OwnerId']).toBe(MAPPED);
    expect(target.sent['OpportunitySplit']?.map((row) => row['SplitOwnerId'])).toEqual([MAPPED]);
    expect(target.teamOf(deal).map((m) => m['UserId'])).toEqual([MAPPED]);
    expect(summary.errors).toEqual([]);
  });

  it('holds back a split whose type the target holds none of by its name', async () => {
    const tables = sourceRows();
    tables['OpportunitySplitType'][1]['DeveloperName'] = 'Partner_Credit';
    const { deps, target } = orgs(tables);

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_DEAL,
    );

    expect(target.sent['OpportunitySplit']).toBeUndefined();
    expect(summary.errors).toEqual([
      expect.objectContaining({
        objectApiName: 'OpportunitySplit',
        failedCount: 1,
        samples: [
          {
            recordSummary: 'SplitTypeId → OpportunitySplitType (1 record)',
            messages: [
              'Not written: SplitTypeId names the split type Partner_Credit, which the target ' +
                'holds no active one of by that name: sent without it, the split would go in as ' +
                'one of the Revenue type.',
            ],
          },
        ],
      }),
    ]);
  });

  it('says in a dry run what the platform writes with the opportunity, and that the Overlay split would be inserted', async () => {
    const { deps } = orgs();
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { ...ROOTED_AT_THE_DEAL, dryRun: true },
    );

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(summary.errors).toEqual([]);
    expect(summary.failedCount).toBe(0);
    expect(summary.wouldInsertCount).toBe(1 /* deal */ + 1 /* account */ + 1 /* Overlay */);
    const messages = said.map((event) => event.message);
    expect(messages).toContain(
      'Simulated OpportunityTeamMember: 0 would be inserted, 1 written by the platform with their opportunity, for its owner, 0 failed, ' +
        "1 linked without the source's OpportunityAccessLevel: the target's record keeps its own",
    );
    expect(messages).toContain(
      'Simulated OpportunitySplit: 1 would be inserted, 1 written by the platform with their opportunity, for its owner, 0 failed',
    );
  });
});

describe('ForgeExecutor, a decision giving a user to a team row whose user the target has no counterpart of', () => {
  const SANDBOX_USER = '005TGT000000009AAA';
  const REPS_MEMBER = '00qSRC000000002AAA';

  /** The rep on the team with the Overlay split at 40 %, the owner with the whole revenue. */
  function withARepsOverlay(): Record<string, FakeRow[]> {
    const tables = sourceRows();
    tables['OpportunitySplit'] = tables['OpportunitySplit'].filter(
      (s) => s['Id'] !== OWNERS_OVERLAY,
    );
    tables['OpportunityTeamMember'].push({
      Id: REPS_MEMBER,
      OpportunityId: DEAL,
      UserId: SOURCE_REP,
      TeamMemberRole: 'Sales Rep',
      OpportunityAccessLevel: 'Read',
    });
    tables['OpportunitySplit'].push({
      Id: '049SRC000000003AAA',
      OpportunityId: DEAL,
      SplitOwnerId: SOURCE_REP,
      SplitTypeId: SOURCE_OVERLAY,
      SplitPercentage: '40',
      SplitNote: null,
    });
    return tables;
  }

  /** The same user given to both gaps of the dry run, as Review gives it. */
  const givenTo = (user: string) => ({
    defaultValues: [
      { object: 'OpportunityTeamMember', field: 'UserId', value: user },
      { object: 'OpportunitySplit', field: 'SplitOwnerId', value: user },
    ],
  });

  it("writes the rep's split as an Overlay one of the user the decision gives, never as a Revenue one", async () => {
    const { deps, target } = orgs(withARepsOverlay(), [SANDBOX_USER]);

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_DEAL, decisions: givenTo(SANDBOX_USER) },
    );

    const deal = copyOf(target);
    // Sent without its type, the split went in as a Revenue one, and the
    // platform took its 40 % from the owner's.
    expect(
      target.splitsOf(deal).map((s) => [s['SplitOwnerId'], s['SplitTypeId'], s['SplitPercentage']]),
    ).toEqual([
      [RUNNING_USER, TARGET_REVENUE, '100'],
      [SANDBOX_USER, TARGET_OVERLAY, '40'],
    ]);
    expect(target.teamOf(deal).map((m) => m['UserId'])).toEqual([RUNNING_USER, SANDBOX_USER]);
    expect(summary.errors).toEqual([]);
    expect(summary.decisionsApplied).toEqual([
      {
        kind: 'set_default',
        objectApiName: 'OpportunityTeamMember',
        field: 'UserId',
        to: SANDBOX_USER,
        rows: 1,
      },
      {
        kind: 'set_default',
        objectApiName: 'OpportunitySplit',
        field: 'SplitOwnerId',
        to: SANDBOX_USER,
        rows: 1,
      },
    ]);
  });

  it('holds back a split the decision gives a user to, whose type the target holds none of by its name', async () => {
    const tables = withARepsOverlay();
    tables['OpportunitySplitType'][1]['DeveloperName'] = 'Partner_Credit';
    const { deps, target } = orgs(tables, [SANDBOX_USER]);

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_DEAL, decisions: givenTo(SANDBOX_USER) },
    );

    expect(target.sent['OpportunitySplit']).toBeUndefined();
    expect(summary.errors).toEqual([
      expect.objectContaining({
        objectApiName: 'OpportunitySplit',
        failedCount: 1,
        samples: [
          expect.objectContaining({
            recordSummary: 'SplitTypeId → OpportunitySplitType (1 record)',
          }),
        ],
      }),
    ]);
  });

  it("links the rep's member to the platform's when the decision gives it the user the run writes as, the copy's owner", async () => {
    const { deps, target } = orgs(withARepsOverlay());
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { ...ROOTED_AT_THE_DEAL, decisions: givenTo(RUNNING_USER) },
    );

    const deal = copyOf(target);
    // Sent, the member went in as the platform's own, its role changed, and
    // was counted created: the platform's member, which its removal is refused.
    expect(target.sent['OpportunityTeamMember']).toBeUndefined();
    expect(target.teamOf(deal)).toEqual([
      expect.objectContaining({ UserId: RUNNING_USER, TeamMemberRole: 'Opportunity Owner' }),
    ]);
    expect(
      target.splitsOf(deal).map((s) => [s['SplitOwnerId'], s['SplitTypeId'], s['SplitPercentage']]),
    ).toEqual([
      [RUNNING_USER, TARGET_REVENUE, '100'],
      [RUNNING_USER, TARGET_OVERLAY, '40'],
    ]);
    expect(summary.existingSourceIds).toEqual(expect.arrayContaining([OWNERS_MEMBER, REPS_MEMBER]));
    expect(summary.withTheirRecordSourceIds).toEqual(
      expect.arrayContaining([OWNERS_MEMBER, REPS_MEMBER]),
    );
    expect(said.map((event) => event.message)).toContainEqual(
      expect.stringMatching(
        /^Completed OpportunityTeamMember: 0 succeeded, 2 written by the platform with their opportunity, for its owner, 0 failed/,
      ),
    );
  });

  it('says in a dry run what the run does when the decision gives the user the run writes as: the member linked, not inserted', async () => {
    // Played for real: the dry run said "1 would be inserted" of the rep's
    // member and 4 records in all, where the run linked it to the
    // platform's and wrote 3. The simulation stood an id of its own for the
    // copy's owner, which the user the decision gives never matched.
    const run = orgs(withARepsOverlay());
    const ran = await new ForgeExecutor({
      ...run.deps,
      runningUser: async () => RUNNING_USER,
    }).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_DEAL,
      decisions: givenTo(RUNNING_USER),
    });
    const { deps } = orgs(withARepsOverlay());
    const said: ForgeProgressEvent[] = [];

    const simulated = await new ForgeExecutor({
      ...deps,
      runningUser: async () => RUNNING_USER,
    }).execute(dealGraph(), 'src', 'tgt', (event) => said.push(event), {
      ...ROOTED_AT_THE_DEAL,
      decisions: givenTo(RUNNING_USER),
      dryRun: true,
    });

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(ran.successCount).toBe(3);
    expect(simulated.wouldInsertCount).toBe(ran.successCount);
    expect(simulated.linkedCount).toBe(ran.linkedCount);
    expect(said.map((event) => event.message)).toContainEqual(
      expect.stringMatching(
        /^Simulated OpportunityTeamMember: 0 would be inserted, 2 written by the platform with their opportunity, for its owner, 0 failed/,
      ),
    );
  });
});

describe('ForgeExecutor, the values of a team row linked to the record the platform wrote', () => {
  it("says which of the source's values the owner's member and Revenue split went without", async () => {
    const tables = sourceRows();
    tables['OpportunityTeamMember'][0]['TeamMemberRole'] = 'Sales Manager';
    tables['OpportunityTeamMember'][0]['OpportunityAccessLevel'] = 'All';
    tables['OpportunitySplit'][0]['SplitNote'] = 'Q3 reorg';
    const { deps, target } = orgs(tables);
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      ROOTED_AT_THE_DEAL,
    );

    // Linked, never written: the target keeps the platform's values.
    expect(target.teamOf(copyOf(target))[0]['TeamMemberRole']).toBe('Opportunity Owner');
    expect(finishedRunStatus(summary)).toBe('success');
    const messages = said.map((event) => event.message);
    expect(messages).toContain(
      'Completed OpportunityTeamMember: 0 succeeded, 1 written by the platform with their opportunity, for its owner, 0 failed, ' +
        "1 linked without the source's TeamMemberRole: the target's record keeps its own",
    );
    expect(messages).toContain(
      'Completed OpportunitySplit: 1 succeeded, 1 written by the platform with their opportunity, for its owner, 0 failed, ' +
        "1 linked without the source's SplitNote: the target's record keeps its own",
    );
  });

  it('says it in a dry run too, of the values the platform writes', async () => {
    const tables = sourceRows();
    tables['OpportunityTeamMember'][0]['TeamMemberRole'] = 'Sales Manager';
    tables['OpportunitySplit'][0]['SplitNote'] = 'Q3 reorg';
    const { deps } = orgs(tables);
    const said: ForgeProgressEvent[] = [];

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', (event) => said.push(event), {
      ...ROOTED_AT_THE_DEAL,
      dryRun: true,
    });

    const messages = said.map((event) => event.message);
    expect(messages).toContain(
      'Simulated OpportunityTeamMember: 0 would be inserted, 1 written by the platform with their opportunity, for its owner, 0 failed, ' +
        "1 linked without the source's TeamMemberRole: the target's record keeps its own, " +
        "1 linked without the source's OpportunityAccessLevel: the target's record keeps its own",
    );
    expect(messages).toContain(
      'Simulated OpportunitySplit: 1 would be inserted, 1 written by the platform with their opportunity, for its owner, 0 failed, ' +
        "1 linked without the source's SplitNote: the target's record keeps its own",
    );
  });
});

describe('ForgeExecutor, where the records the platform wrote with the run’s opportunity are said', () => {
  it('counts none of them at its gate, which holds --max-total and the storage to what the run writes, in a run or in a dry run', async () => {
    // Played for real: the gate said 5 records to write, the owner's member
    // and Revenue split among them, where the run wrote 3.
    for (const dryRun of [false, true]) {
      const { deps, target } = orgs();
      let shown: ForgeWriteBoundary | undefined;

      const summary = await new ForgeExecutor(deps).execute(
        dealGraph(),
        'src',
        'tgt',
        () => undefined,
        {
          ...ROOTED_AT_THE_DEAL,
          dryRun,
          beforeWrite: async (boundary) => {
            shown = boundary;
          },
        },
      );

      const plan = writePlanOf(shown?.objects ?? []);
      const written = dryRun
        ? summary.wouldInsertCount
        : Object.values(target.sent).reduce((sum, rows) => sum + rows.length, 0);
      expect(written).toBe(3);
      expect(plan.totalRows).toBe(written);
      expect(plan.objects.map(({ objectApiName, rows }) => [objectApiName, rows])).toEqual([
        ['Account', 1],
        ['Opportunity', 1],
        ['OpportunitySplit', 1],
      ]);
      expect(plan.leftOut?.byThePlatform).toEqual([
        { objectApiName: 'OpportunitySplit', rows: 1 },
        { objectApiName: 'OpportunityTeamMember', rows: 1 },
      ]);
      expect(leftOutLines(plan.leftOut)).toEqual([
        '  not counted: OpportunitySplit, 1 record(s) written by the platform with their ' +
          'opportunity, for its owner, which the run links to and does not send',
        '  not counted: OpportunityTeamMember, 1 record(s) written by the platform with their ' +
          'opportunity, for its owner, which the run links to and does not send',
      ]);
    }
  });

  it('lists none of them among the records the target held already, in a run or in a dry run', async () => {
    for (const dryRun of [false, true]) {
      const { deps } = orgs();

      const summary = await new ForgeExecutor(deps).execute(
        dealGraph(),
        'src',
        'tgt',
        () => undefined,
        { ...ROOTED_AT_THE_DEAL, dryRun },
      );

      expect(summary.existingRecords).toEqual([]);
      expect(summary.linkedCount).toBe(2);
      // Said apart from the records the target held: the platform wrote them.
      expect(summary.writtenByThePlatform).toEqual([
        { objectApiName: 'OpportunityTeamMember', rows: 1 },
        { objectApiName: 'OpportunitySplit', rows: 1 },
      ]);
    }
  });

  it('says them, in a run of whole tables read page by page, as a run read whole says them', async () => {
    const tables = sourceRows();
    const { deps } = orgs(tables);
    /** A whole table's read, as a run of whole tables asks it, in the order of the ids. */
    const whole = (soql: string): FakeRow[] | undefined => {
      const match =
        /^SELECT .+? FROM (\w+)(?: WHERE Id > '(\w+)')?(?: ORDER BY Id)?(?: LIMIT (\d+))?$/.exec(
          soql,
        );
      if (!match) return undefined;
      const [, object, after, limit] = match;
      return [...(tables[object] ?? [])]
        .sort((a, b) => String(a['Id']).localeCompare(String(b['Id'])))
        .filter((row) => after === undefined || String(row['Id']) > after)
        .slice(0, limit === undefined ? undefined : Number(limit));
    };
    const read = (soql: string): FakeRow[] => whole(soql) ?? selectRows(tables, soql);
    const paged = {
      ...deps,
      queryRecords: vi.fn(async (org: string, soql: string) =>
        org === 'src' ? read(soql) : deps.queryRecords(org, soql),
      ),
      queryPages: (org: string, soql: string) =>
        (async function* pages(): AsyncGenerator<FakeRow[]> {
          if (org !== 'src') return;
          const rows = read(soql);
          if (rows.length === 0) yield [];
          for (let at = 0; at < rows.length; at += 1) yield rows.slice(at, at + 1);
        })(),
      countRecords: vi.fn(
        async (_org: string, soql: string) =>
          tables[/FROM (\w+)/.exec(soql)?.[1] ?? '']?.length ?? 0,
      ),
    } satisfies ForgeExecutorDeps;
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(paged).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { stream: { pageSize: 1 } },
    );

    const messages = said.map((event) => event.message);
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^Completed OpportunityTeamMember: 0 succeeded, 1 written by the platform with their opportunity, for its owner, 0 failed/,
      ),
    );
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^Completed OpportunitySplit: 1 succeeded, 1 written by the platform with their opportunity, for its owner, 0 failed/,
      ),
    );
    expect(summary.existingRecords).toEqual([]);
    expect(finishedRunStatus(summary)).toBe('success');
  });
});

describe('ForgeExecutor, a rehearsal of an opportunity with Team Selling and Splits on', () => {
  const KEY_PREFIXES: Record<string, string> = {
    Account: '001',
    Opportunity: '006',
    OpportunityTeamMember: '00q',
    OpportunitySplit: '049',
  };

  /** The rows the rehearsal's writer keeps, prepared as the CLI's `--rehearse` prepares them. */
  async function rehearsed(runningUser?: () => Promise<string | undefined>) {
    const { deps, target } = orgs();
    const writer = new RehearsalWriter(
      async (object) => KEY_PREFIXES[object] ?? null,
      ...(runningUser ? [runningUser] : []),
    );
    await new ForgeExecutor(rehearsalExecutorDeps(deps, writer)).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_DEAL,
    );
    return { writer, target, deps };
  }

  it("hands its writer the owner's Overlay split the run writes, under the user the run writes as, and not what the platform writes", async () => {
    const { writer, target } = await rehearsed(async () => RUNNING_USER);

    const deal = writer.rows.find((row) => row.objectApiName === 'Opportunity');
    expect(writer.rows.map((row) => row.objectApiName)).toEqual([
      'Account',
      'Opportunity',
      'OpportunitySplit',
    ]);
    expect(writer.rows[2].fields).toEqual({
      OpportunityId: deal?.placeholderId,
      SplitOwnerId: RUNNING_USER,
      SplitTypeId: TARGET_OVERLAY,
      SplitPercentage: '40',
      SplitNote: 'Overlay credit',
    });
    // Nothing reached the target.
    expect(target.tables['Opportunity']).toEqual([]);
  });

  it('gives the split the owner the opportunity is sent with, when an owner mapping gives it one', async () => {
    const MAPPED = '005TGT000000007AAA';
    const { deps } = orgs(sourceRows(), [MAPPED]);
    const writer = new RehearsalWriter(
      async (object) => KEY_PREFIXES[object] ?? null,
      async () => RUNNING_USER,
    );

    await new ForgeExecutor(rehearsalExecutorDeps(deps, writer)).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_DEAL, ownerMappings: { [SOURCE_OWNER]: MAPPED } },
    );

    expect(
      writer.rows
        .filter((row) => row.objectApiName === 'OpportunitySplit')
        .map((row) => row.fields['SplitOwnerId']),
    ).toEqual([MAPPED]);
  });

  it('holds the team back, as before, when the user the run writes as cannot be told', async () => {
    const { writer } = await rehearsed(async () => undefined);

    expect(writer.rows.map((row) => row.objectApiName)).toEqual(['Account', 'Opportunity']);
  });
});
