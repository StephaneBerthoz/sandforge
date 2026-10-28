import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { OrgTypeAndEdition } from '@sandforge/shared';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import {
  guardCheckpoint,
  type CheckpointAct,
  type CheckpointGuardDeps,
  type CheckpointGuardRequest,
} from './checkpointGuard.js';

const ORG_ID = '00D000000000001AAA';
const OTHER_ORG_ID = '00D000000000002AAA';
const USER = 'tester@example.com';

/** What a fake org says of itself when asked. */
interface OrgSays {
  /** No Organization record at all when absent. */
  id?: string;
  sandbox: boolean;
  /** `OrganizationType`, or the error its read fails with. */
  edition?: string | Error;
  /** The running user's row of `UserPermissionAccess`, or the error its read fails with. */
  permissions?: Record<string, boolean> | Error;
  /** Fields of `UserPermissionAccess` the org does not know: a statement naming one is refused. */
  unknownFields?: string[];
  /**
   * The org's permission sets by id, each with its rows of `ObjectPermissions`:
   * a permission set group's aggregate names its group, as `PermissionSet`
   * does (`PermissionSetGroupId`).
   */
  permissionSets?: Record<string, { group?: string; rows: Grant[] }>;
  /** The running user's assignments, each to a set or to a group (through some set). */
  assignments?: Array<{ PermissionSetId: string; PermissionSetGroupId?: string }>;
  /** The objects whose reads the org refuses, with its error. */
  refusing?: Partial<Record<'ObjectPermissions' | 'PermissionSetAssignment', Error>>;
  /** The rows of a page of `ObjectPermissions`; all of them unless given. */
  pageRows?: number;
}

/** A row of `ObjectPermissions`, as the probes read them: its object, View All and Modify All. */
type Grant = {
  SobjectType: string;
  PermissionsViewAllRecords: boolean;
  PermissionsModifyAllRecords: boolean;
};

/** A row of `ObjectPermissions` on `object`, read and edited, with or without View All and Modify All. */
function grant(object: string, viewAll = false, modifyAll = false): Grant {
  return {
    SobjectType: object,
    PermissionsViewAllRecords: viewAll,
    PermissionsModifyAllRecords: modifyAll,
  };
}

/** The user the connection acts as, read object by object when it lacks the two. */
const STANDARD_USER = '005000000000042AAA';

/** What the guard is given to read a user object by object. */
const BY_OBJECT = { userId: async () => STANDARD_USER };

/** The rows a statement on `ObjectPermissions` or `PermissionSetAssignment` selects, as the org reads it. */
function permissionRowsOf(says: OrgSays, soql: string): Array<Record<string, unknown>> {
  const sets = says.permissionSets ?? {};
  const mine = (assignee: string) => (assignee === STANDARD_USER ? (says.assignments ?? []) : []);
  if (soql.includes('FROM ObjectPermissions')) {
    const refusal = says.refusing?.ObjectPermissions;
    if (refusal) throw refusal;
    const semiJoin =
      /ParentId IN \(SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '(\w+)'( AND PermissionSetGroupId = null)?\)/.exec(
        soql,
      );
    const groups = /Parent\.PermissionSetGroupId IN \(([^)]*)\)/.exec(soql);
    let parents: string[];
    if (semiJoin) {
      parents = mine(semiJoin[1])
        .filter((assignment) => semiJoin[2] === undefined || !assignment.PermissionSetGroupId)
        .map((assignment) => assignment.PermissionSetId);
    } else if (groups) {
      const named = groups[1].split(',').map((id) => id.trim().replace(/'/g, ''));
      parents = Object.entries(sets)
        .filter(([, set]) => set.group !== undefined && named.includes(set.group))
        .map(([id]) => id);
    } else {
      throw new Error(`Not a read of permissions the org was probed with: ${soql}`);
    }
    return parents.flatMap((id) => sets[id]?.rows ?? []);
  }
  const refusal = says.refusing?.PermissionSetAssignment;
  if (refusal) throw refusal;
  const assigned =
    /FROM PermissionSetAssignment WHERE AssigneeId = '(\w+)' AND PermissionSetGroupId != null$/.exec(
      soql,
    );
  if (!assigned) throw new Error(`Not a read of assignments the org was probed with: ${soql}`);
  return mine(assigned[1])
    .filter((assignment) => assignment.PermissionSetGroupId !== undefined)
    .map((assignment) => ({ PermissionSetGroupId: assignment.PermissionSetGroupId }));
}

const BOTH = { PermissionsViewAllData: true, PermissionsModifyAllData: true };

/** A connection to an org that answers as `says`, and the statements it was asked, next pages among them. */
function orgSaying(says: OrgSays) {
  const asked: string[] = [];
  const cursors = new Map<string, Array<Record<string, unknown>>>();
  const pageOf = (rows: Array<Record<string, unknown>>, totalSize: number) => {
    const size = says.pageRows ?? rows.length;
    if (rows.length <= size) return { records: rows, totalSize, done: true };
    const locator = `/services/data/v66.0/query/01gxx0000000${cursors.size + 1}AAA-${size}`;
    cursors.set(locator, rows.slice(size));
    return { records: rows.slice(0, size), totalSize, done: false, nextRecordsUrl: locator };
  };
  const conn = {
    queryMore: vi.fn(async (locator: string) => {
      asked.push(`next ${locator}`);
      const rest = cursors.get(locator);
      if (rest === undefined) throw new Error('INVALID_QUERY_LOCATOR: invalid query locator');
      cursors.delete(locator);
      return pageOf(rest, rest.length);
    }),
    query: vi.fn(async (soql: string) => {
      asked.push(soql);
      if (
        soql.includes('FROM ObjectPermissions') ||
        soql.includes('FROM PermissionSetAssignment')
      ) {
        const rows = permissionRowsOf(says, soql);
        return pageOf(rows, rows.length);
      }
      if (soql.startsWith('SELECT Id, IsSandbox FROM Organization')) {
        return says.id === undefined
          ? { records: [], totalSize: 0 }
          : { records: [{ Id: says.id, IsSandbox: says.sandbox }], totalSize: 1 };
      }
      if (soql.startsWith('SELECT OrganizationType FROM Organization')) {
        if (says.edition instanceof Error) throw says.edition;
        return { records: [{ OrganizationType: says.edition }], totalSize: 1 };
      }
      if (soql.includes('FROM UserPermissionAccess')) {
        const row = says.permissions ?? BOTH;
        if (row instanceof Error) throw row;
        if (says.unknownFields?.some((field) => soql.includes(field))) {
          throw new Error(
            `No such column '${says.unknownFields[0]}' on entity 'UserPermissionAccess'.`,
          );
        }
        return { records: [row], totalSize: 1 };
      }
      throw new Error(`The guard read records: ${soql}`);
    }),
  } as unknown as Pick<Connection, 'query' | 'queryMore'>;
  return { conn, asked };
}

const SANDBOX: OrgTypeAndEdition = { orgType: 'Sandbox' };
const SCRATCH: OrgTypeAndEdition = { orgType: 'Scratch' };
const DEVELOPER: OrgTypeAndEdition = { orgType: 'Developer' };
const PRODUCTION: OrgTypeAndEdition = { orgType: 'Production' };

/** A request for `act` on the org the registry holds as `registered`, of the checkpoint's org {@link ORG_ID}. */
function asking(
  act: CheckpointAct,
  registered: OrgTypeAndEdition | undefined,
  organizationId = ORG_ID,
): CheckpointGuardRequest {
  const base = { orgName: 'DEV-SB', registered, username: USER };
  return act === 'take' ? { ...base, act } : { ...base, act, organizationId };
}

const ACTS: CheckpointAct[] = ['take', 'preview', 'rewind', 'undo'];

describe('guardCheckpoint: never a production org', () => {
  it('lets through a sandbox, a scratch org and a Developer Edition org that the registry and the org itself both place, and says which it is', async () => {
    const sandbox = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true }).conn,
      asking('take', SANDBOX),
    );
    const scratch = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true }).conn,
      asking('rewind', SCRATCH),
    );
    const developer = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' }).conn,
      asking('undo', DEVELOPER),
    );
    // Builds before the edition rule registered a Developer Edition org as
    // Production, its edition kept beside the type.
    const registeredBefore = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' }).conn,
      asking('preview', { orgType: 'Production', metadata: { edition: 'Developer Edition' } }),
    );

    expect(sandbox).toEqual({
      allowed: true,
      org: { id: ORG_ID, sandbox: true },
      tier: 'sandbox',
      queryAllFiles: false,
      grants: { kind: 'org' },
    });
    expect(scratch).toEqual({
      allowed: true,
      org: { id: ORG_ID, sandbox: true },
      tier: 'scratch',
      queryAllFiles: false,
      grants: { kind: 'org' },
    });
    expect(developer).toEqual({
      allowed: true,
      org: { id: ORG_ID, sandbox: false, edition: 'Developer Edition' },
      tier: 'developer',
      queryAllFiles: false,
      grants: { kind: 'org' },
    });
    expect(registeredBefore).toMatchObject({ allowed: true, tier: 'developer' });
  });

  it('refuses an org the registry holds as a production org, or does not hold at all, without asking the org anything', async () => {
    for (const registered of [PRODUCTION, undefined]) {
      const { conn, asked } = orgSaying({ id: ORG_ID, sandbox: true });

      const answer = await guardCheckpoint(conn, asking('take', registered));

      expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
      expect(asked).toEqual([]);
    }
    const unknown = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true }).conn,
      asking('take', undefined),
    );
    expect(unknown.allowed === false && unknown.refusal.message).toBe(
      'DEV-SB is a production org, or cannot be told from one: SandForge has no record of what ' +
        'kind of org it is. Checkpoints are for sandboxes, scratch orgs and Developer Edition ' +
        'orgs: SandForge never takes a checkpoint of, or rewinds, a production org. No record ' +
        'was read or written.',
    );
  });

  it('refuses an org the registry holds as a sandbox when the org itself says it is a production one', async () => {
    const answer = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' }).conn,
      asking('rewind', SANDBOX),
    );

    expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    expect(answer.allowed === false && answer.refusal.message).toContain(
      'DEV-SB is a production org, or cannot be told from one: its Organization record says ' +
        'IsSandbox false, edition Enterprise Edition.',
    );
  });

  it('refuses an org whose edition cannot be read, or that will not say what it is, as a production org', async () => {
    const noEdition = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: false, edition: new Error('INVALID_FIELD') }).conn,
      asking('take', DEVELOPER),
    );
    const noRecord = await guardCheckpoint(
      orgSaying({ sandbox: false }).conn,
      asking('take', DEVELOPER),
    );

    expect(noEdition).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    expect(noEdition.allowed === false && noEdition.refusal.message).toContain(
      'its Organization record says IsSandbox false, and no edition',
    );
    expect(noRecord).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    expect(noRecord.allowed === false && noRecord.refusal.message).toContain(
      'it did not say what org it is (The org gave no Organization record',
    );
  });

  it('refuses a production org at a take, a preview, a rewind and an undo alike, even with the override Production Guard holds for a delete there', async () => {
    const productionGuard = new ProductionGuard();
    productionGuard.setProductionOverride(ORG_ID, true);
    // The override is live: Production Guard lets a delete through in this org.
    expect(
      productionGuard.check({
        orgId: ORG_ID,
        orgTier: 'production',
        operation: 'delete',
        objectName: 'Account',
        recordCount: 3,
        module: 'checkpoint',
      }).allowed,
    ).toBe(true);

    for (const act of ACTS) {
      const answer = await guardCheckpoint(
        orgSaying({ id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' }).conn,
        asking(act, PRODUCTION),
      );
      expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    }
  });
});

describe('guardCheckpoint: the org the checkpoint was taken of', () => {
  it('refuses a preview, a rewind and an undo of an org whose Organization Id is not the checkpoint’s, before reading the user’s permissions', async () => {
    for (const act of ['preview', 'rewind', 'undo'] as const) {
      const { conn, asked } = orgSaying({ id: OTHER_ORG_ID, sandbox: true });

      const answer = await guardCheckpoint(conn, asking(act, SANDBOX));

      expect(answer).toEqual({
        allowed: false,
        refusal: {
          code: 'OTHER_ORG',
          message:
            'DEV-SB is another org than the one this checkpoint was taken of: its Organization ' +
            "Id has changed, as a sandbox's does when it is refreshed. This checkpoint is of the " +
            'org before it, and can only be deleted. No record was read or written.',
        },
      });
      expect(asked.some((soql) => soql.includes('UserPermissionAccess'))).toBe(false);
    }
  });

  it('takes the checkpoint’s Organization Id in its 15-character form and its 18-character form alike', async () => {
    const answer = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true }).conn,
      asking('rewind', SANDBOX, ORG_ID.slice(0, 15)),
    );

    expect(answer).toMatchObject({ allowed: true, tier: 'sandbox' });
  });
});

describe('guardCheckpoint: a user who sees and may put back every record', () => {
  it('refuses a take, a rewind and an undo by a user without View All Data and Modify All Data, before any record is read', async () => {
    for (const act of ['take', 'rewind', 'undo'] as const) {
      const { conn, asked } = orgSaying({ id: ORG_ID, sandbox: true, permissions: {} });

      const answer = await guardCheckpoint(conn, asking(act, SANDBOX));

      expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
      expect(asked).toEqual([
        'SELECT Id, IsSandbox FROM Organization LIMIT 1',
        'SELECT PermissionsViewAllData, PermissionsModifyAllData, PermissionsQueryAllFiles ' +
          'FROM UserPermissionAccess',
      ]);
    }
  });

  it('names the permission the user lacks, or both', async () => {
    const neither = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true, permissions: { PermissionsViewAllData: false } }).conn,
      asking('rewind', SANDBOX),
    );
    const noModify = await guardCheckpoint(
      orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: { PermissionsViewAllData: true, PermissionsModifyAllData: false },
      }).conn,
      asking('take', SANDBOX),
    );

    expect(neither.allowed === false && neither.refusal.message).toBe(
      'Rewind needs a user with View All Data and Modify All Data: it must see and put back ' +
        `what everyone changed. ${USER} doesn't have them. No record was read or written.`,
    );
    expect(noModify.allowed === false && noModify.refusal.message).toBe(
      'A checkpoint needs a user with View All Data and Modify All Data: a rewind to it must ' +
        `see and put back what everyone changed. ${USER} doesn't have Modify All Data. No ` +
        'record was read or written.',
    );
  });

  it('refuses when the org will not say what the user may do', async () => {
    const answer = await guardCheckpoint(
      orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: new Error("sObject type 'UserPermissionAccess' is not supported."),
      }).conn,
      asking('undo', SANDBOX),
    );

    expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
    expect(answer.allowed === false && answer.refusal.message).toContain(
      `SandForge could not read whether ${USER} has them (sObject type 'UserPermissionAccess' ` +
        'is not supported.), and takes an org that will not say for a user who has neither.',
    );
  });

  it('reads Query All Files in the statement that reads the two permissions, and refuses no act without it', async () => {
    for (const act of ACTS) {
      const without = orgSaying({ id: ORG_ID, sandbox: true });
      const holding = orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: { ...BOTH, PermissionsQueryAllFiles: true },
      });

      const lacking = await guardCheckpoint(without.conn, asking(act, SANDBOX));
      const having = await guardCheckpoint(holding.conn, asking(act, SANDBOX));

      expect(lacking).toMatchObject({ allowed: true, queryAllFiles: false });
      expect(having).toMatchObject({ allowed: true, queryAllFiles: true });
      expect(without.asked.filter((soql) => soql.includes('UserPermissionAccess'))).toEqual([
        'SELECT PermissionsViewAllData, PermissionsModifyAllData, PermissionsQueryAllFiles ' +
          'FROM UserPermissionAccess',
      ]);
    }
  });

  it('asks the two permissions alone of an org that does not know Query All Files, and takes its user for one without it', async () => {
    const { conn, asked } = orgSaying({
      id: ORG_ID,
      sandbox: true,
      unknownFields: ['PermissionsQueryAllFiles'],
    });

    const answer = await guardCheckpoint(conn, asking('take', SANDBOX));

    expect(answer).toMatchObject({ allowed: true, queryAllFiles: false });
    expect(asked.filter((soql) => soql.includes('UserPermissionAccess'))).toEqual([
      'SELECT PermissionsViewAllData, PermissionsModifyAllData, PermissionsQueryAllFiles ' +
        'FROM UserPermissionAccess',
      'SELECT PermissionsViewAllData, PermissionsModifyAllData FROM UserPermissionAccess',
    ]);
  });

  it('refuses a preview by a user without View All Data, whose records out of sight would read as deleted since', async () => {
    const { conn } = orgSaying({ id: ORG_ID, sandbox: true, permissions: {} });

    const answer = await guardCheckpoint(conn, asking('preview', SANDBOX));

    expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
    expect(answer.allowed === false && answer.refusal.message).toContain(
      'A preview needs a user with View All Data and Modify All Data',
    );
  });
});

/** A Standard User's profile, as P-B4 read it: Account and Contact read, edited and deleted, Case read and edited, Campaign read; no View All, no Modify All. */
const STANDARD_PROFILE = {
  rows: [grant('Account'), grant('Contact'), grant('Case'), grant('Campaign')],
};

/** The statements that read the user's permission rows, as a real org is sent them. */
const OWN_ROWS =
  'SELECT SobjectType, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ' +
  'ObjectPermissions WHERE ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment ' +
  `WHERE AssigneeId = '${STANDARD_USER}' AND PermissionSetGroupId = null)`;
const GROUPS_ASSIGNED =
  'SELECT PermissionSetGroupId FROM PermissionSetAssignment ' +
  `WHERE AssigneeId = '${STANDARD_USER}' AND PermissionSetGroupId != null`;

/** The reads after the org's own, of the user's permissions. */
function permissionReadsOf(asked: readonly string[]): string[] {
  return asked.filter((soql) => !soql.includes('FROM Organization'));
}

describe('guardCheckpoint: a user without View All Data and Modify All Data, object by object', () => {
  it('refuses a Standard User whose rows give View All and Modify All on no object, as P-B4 read them, saying what lifts it', async () => {
    for (const act of ACTS) {
      const { conn, asked } = orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: {},
        permissionSets: { '0PS000000000001AAA': STANDARD_PROFILE },
        assignments: [{ PermissionSetId: '0PS000000000001AAA' }],
      });

      const answer = await guardCheckpoint(conn, asking(act, SANDBOX), BY_OBJECT);

      expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
      expect(answer.allowed === false && answer.refusal.message).toContain(
        `${USER} doesn't have them, nor View All and Modify All on any object. Give the user ` +
          'View All and Modify All on the objects to hold, or View All Data and Modify All ' +
          'Data. No record was read or written.',
      );
      expect(permissionReadsOf(asked)).toEqual([
        'SELECT PermissionsViewAllData, PermissionsModifyAllData, PermissionsQueryAllFiles ' +
          'FROM UserPermissionAccess',
        OWN_ROWS,
        GROUPS_ASSIGNED,
      ]);
    }
    const take = await guardCheckpoint(
      orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: {},
        permissionSets: { '0PS000000000001AAA': STANDARD_PROFILE },
        assignments: [{ PermissionSetId: '0PS000000000001AAA' }],
      }).conn,
      asking('take', SANDBOX),
      BY_OBJECT,
    );
    expect(take.allowed === false && take.refusal.message).toBe(
      'A checkpoint needs a user with View All Data and Modify All Data, or with View All and ' +
        'Modify All on each object it holds: a rewind to it must see and put back what ' +
        `everyone changed there. ${USER} doesn't have them, nor View All and Modify All on any ` +
        'object. Give the user View All and Modify All on the objects to hold, or View All Data ' +
        'and Modify All Data. No record was read or written.',
    );
  });

  it('lets a user without the two through with what every row of theirs gives each object, OR over the rows, and the requests that read them', async () => {
    const { conn } = orgSaying({
      id: ORG_ID,
      sandbox: true,
      permissions: { PermissionsViewAllData: true },
      permissionSets: {
        '0PS000000000001AAA': STANDARD_PROFILE,
        '0PS000000000002AAA': { rows: [grant('Account', true, true), grant('Contact', true)] },
        '0PS000000000003AAA': { rows: [grant('Contact'), grant('Opportunity', true, true)] },
      },
      assignments: [
        { PermissionSetId: '0PS000000000001AAA' },
        { PermissionSetId: '0PS000000000002AAA' },
        { PermissionSetId: '0PS000000000003AAA' },
      ],
    });

    const answer = await guardCheckpoint(conn, asking('take', SANDBOX), BY_OBJECT);

    expect(answer).toMatchObject({
      allowed: true,
      grants: { kind: 'perObject', viewAllData: true, modifyAllData: false, requests: 3 },
    });
    const grants = answer.allowed && answer.grants.kind === 'perObject' ? answer.grants : undefined;
    // The profile's row of Account, read first, takes nothing from the set that gives it all.
    expect(Object.fromEntries(grants?.objects ?? [])).toEqual({
      account: { viewAll: true, modifyAll: true },
      contact: { viewAll: true, modifyAll: false },
      case: { viewAll: false, modifyAll: false },
      campaign: { viewAll: false, modifyAll: false },
      opportunity: { viewAll: true, modifyAll: true },
    });
  });

  it('reads a permission set group by its aggregate, which reflects its muting (P-B5), and never through the set its assignment names, whichever it is', async () => {
    // The group bundles a set giving Modify All on Account and a muting set
    // taking it away: the aggregate read `Modify All false` there, live.
    const sets = {
      '0PS000000000001AAA': STANDARD_PROFILE,
      '0PS000000000004AAA': { rows: [grant('Account', true, true)] },
      '0PS000000000005AAA': { group: '0PG000000000001AAA', rows: [grant('Account', true, false)] },
      '0PS000000000006AAA': { rows: [grant('Contact', true, true)] },
    };
    for (const throughSet of ['0PS000000000004AAA', '0PS000000000005AAA']) {
      const { conn, asked } = orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: {},
        permissionSets: sets,
        assignments: [
          { PermissionSetId: '0PS000000000001AAA' },
          { PermissionSetId: throughSet, PermissionSetGroupId: '0PG000000000001AAA' },
          { PermissionSetId: '0PS000000000006AAA' },
        ],
      });

      const answer = await guardCheckpoint(conn, asking('take', SANDBOX), BY_OBJECT);

      const grants =
        answer.allowed && answer.grants.kind === 'perObject' ? answer.grants : undefined;
      expect(grants?.objects.get('account'), throughSet).toEqual({
        viewAll: true,
        modifyAll: false,
      });
      expect(grants?.objects.get('contact'), throughSet).toEqual({
        viewAll: true,
        modifyAll: true,
      });
      expect(grants?.requests).toBe(4);
      expect(permissionReadsOf(asked).slice(1)).toEqual([
        OWN_ROWS,
        GROUPS_ASSIGNED,
        'SELECT SobjectType, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ' +
          "ObjectPermissions WHERE Parent.PermissionSetGroupId IN ('0PG000000000001AAA')",
      ]);
    }
  });

  it('refuses in the org’s words when it will not read the user, their assignments or their rows, saying what lifts it', async () => {
    const lacking: Array<[OrgSays['refusing'], CheckpointGuardDeps]> = [
      [
        {
          PermissionSetAssignment: new Error(
            "INVALID_TYPE: sObject type 'PermissionSetAssignment' is not supported.",
          ),
        },
        BY_OBJECT,
      ],
      [
        {
          ObjectPermissions: new Error(
            "INVALID_TYPE: sObject type 'ObjectPermissions' is not supported.",
          ),
        },
        BY_OBJECT,
      ],
      [
        {},
        { userId: async () => Promise.reject(new Error('INVALID_SESSION_ID: Session expired')) },
      ],
      [{}, { userId: async () => "005000000000042AAA' OR Id != '" }],
    ];
    for (const [refusing, deps] of lacking) {
      const { conn } = orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: {},
        permissionSets: { '0PS000000000004AAA': { rows: [grant('Account', true, true)] } },
        assignments: [{ PermissionSetId: '0PS000000000004AAA' }],
        refusing,
      });

      const answer = await guardCheckpoint(conn, asking('rewind', SANDBOX), deps);

      expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
      const message = answer.allowed === false ? answer.refusal.message : '';
      expect(message).toMatch(
        new RegExp(
          `^Rewind needs a user with View All Data and Modify All Data, or with View All and ` +
            `Modify All on each object it puts back: it must see and put back what everyone ` +
            `changed there\\. ${USER.replace('.', '\\.')} doesn't have them, and SandForge ` +
            'could not read which objects they have View All and Modify All on \\(.+\\)\\. ' +
            'View Setup and Configuration lets a user read their own permissions; with View ' +
            'All Data and Modify All Data, nothing needs reading\\. No record was read or ' +
            'written\\.$',
        ),
      );
    }
  });

  it('reads every page of the rows, and refuses rows past a page it cannot turn', async () => {
    const says: OrgSays = {
      id: ORG_ID,
      sandbox: true,
      permissions: {},
      permissionSets: {
        '0PS000000000004AAA': {
          rows: [grant('Account'), grant('Contact'), grant('Case'), grant('Lead', true, true)],
        },
      },
      assignments: [{ PermissionSetId: '0PS000000000004AAA' }],
      pageRows: 3,
    };
    const turning = orgSaying(says);

    const answer = await guardCheckpoint(turning.conn, asking('take', SANDBOX), BY_OBJECT);

    expect(answer).toMatchObject({ allowed: true, grants: { kind: 'perObject', requests: 4 } });
    expect(
      answer.allowed && answer.grants.kind === 'perObject' && answer.grants.objects.get('lead'),
    ).toEqual({ viewAll: true, modifyAll: true });
    expect(turning.asked.filter((what) => what.startsWith('next '))).toHaveLength(1);

    const { query } = orgSaying(says).conn;
    const stuck = await guardCheckpoint({ query }, asking('take', SANDBOX), BY_OBJECT);
    expect(stuck.allowed === false && stuck.refusal.message).toContain(
      'could not read which objects they have View All and Modify All on (the org answered 3 ' +
        'rows of 4, and no next page)',
    );
  });

  it('reads no permission row of a user with View All Data and Modify All Data, given a user id or not', async () => {
    for (const deps of [BY_OBJECT, {}]) {
      const { conn, asked } = orgSaying({ id: ORG_ID, sandbox: true });

      const answer = await guardCheckpoint(conn, asking('take', SANDBOX), deps);

      expect(answer).toMatchObject({ allowed: true, grants: { kind: 'org' } });
      expect(asked.join(' ')).not.toMatch(/ObjectPermissions|PermissionSetAssignment/);
    }
  });

  it('refuses a user without the two as before when its caller gives no user id, and an import even when it does, reading no permission row', async () => {
    const says: OrgSays = {
      id: ORG_ID,
      sandbox: true,
      permissions: {},
      permissionSets: { '0PS000000000004AAA': { rows: [grant('Account', true, true)] } },
      assignments: [{ PermissionSetId: '0PS000000000004AAA' }],
    };
    for (const [act, deps] of [
      ['preview', {}],
      ['rewind', {}],
      ['undo', {}],
      ['import', BY_OBJECT],
    ] as const) {
      const { conn, asked } = orgSaying(says);

      const answer = await guardCheckpoint(conn, asking(act, SANDBOX), deps);

      expect(answer, act).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
      expect(answer.allowed === false && answer.refusal.message, act).toContain(
        `needs a user with View All Data and Modify All Data`,
      );
      expect(asked.join(' '), act).not.toMatch(/ObjectPermissions|PermissionSetAssignment/);
    }
  });

  it('asks for Customize Application before reading any permission row of an act that holds custom settings', async () => {
    const { conn, asked } = orgSaying({
      id: ORG_ID,
      sandbox: true,
      permissions: {},
      permissionSets: { '0PS000000000004AAA': { rows: [grant('Account', true, true)] } },
      assignments: [{ PermissionSetId: '0PS000000000004AAA' }],
    });

    const answer = await guardCheckpoint(
      conn,
      { ...asking('take', SANDBOX), customSettings: true },
      BY_OBJECT,
    );

    expect(answer.allowed === false && answer.refusal.message).toContain(
      `${USER} needs Customize Application to keep and rewind custom settings`,
    );
    expect(asked.join(' ')).not.toMatch(/ObjectPermissions|PermissionSetAssignment/);
  });
});

describe('guardCheckpoint: an import of another machine’s checkpoint', () => {
  it('refuses an org the file is not of in its own words, before reading the user’s permissions', async () => {
    const { conn, asked } = orgSaying({ id: OTHER_ORG_ID, sandbox: true });

    const answer = await guardCheckpoint(conn, asking('import', SANDBOX));

    expect(answer).toEqual({
      allowed: false,
      refusal: {
        code: 'OTHER_ORG',
        message:
          'DEV-SB is another org than the one this file holds a checkpoint of: it is imported ' +
          'for the org it was taken of alone, under any alias of it. Nothing was imported.',
      },
    });
    expect(asked.some((soql) => soql.includes('UserPermissionAccess'))).toBe(false);
  });

  it('refuses a production org and a user without View All Data and Modify All Data, whose machine would hold what they cannot see', async () => {
    const live = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' }).conn,
      asking('import', SANDBOX),
    );
    expect(live).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });

    const answer = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true, permissions: { PermissionsModifyAllData: true } })
        .conn,
      asking('import', SANDBOX),
    );
    expect(answer).toEqual({
      allowed: false,
      refusal: {
        code: 'PERMISSIONS',
        message:
          'An import needs a user with View All Data and Modify All Data: SandForge never keeps ' +
          'on this machine records its user could not see in the org, and a rewind to it must ' +
          `see and put back what everyone changed. ${USER} doesn't have View All Data. No record ` +
          'was read or written.',
      },
    });

    const both = await guardCheckpoint(
      orgSaying({ id: ORG_ID, sandbox: true }).conn,
      asking('import', SANDBOX),
    );
    expect(both).toMatchObject({ allowed: true, tier: 'sandbox' });
  });
});

describe('guardCheckpoint: custom settings', () => {
  const CUSTOMIZE = 'PermissionsCustomizeApplication';

  it('refuses an act that keeps or writes custom settings by a user without Customize Application, saying what lifts it, and lets the same user through with it', async () => {
    for (const act of ACTS) {
      const without = orgSaying({ id: ORG_ID, sandbox: true });
      const holding = orgSaying({
        id: ORG_ID,
        sandbox: true,
        permissions: { ...BOTH, [CUSTOMIZE]: true },
      });

      const lacking = await guardCheckpoint(without.conn, {
        ...asking(act, SANDBOX),
        customSettings: true,
      });
      const having = await guardCheckpoint(holding.conn, {
        ...asking(act, SANDBOX),
        customSettings: true,
      });

      expect(lacking).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
      expect(lacking.allowed === false && lacking.refusal.message).toBe(
        `${USER} needs Customize Application to keep and rewind custom settings, and doesn't ` +
          'have it: View All Custom Settings lets a user read them, never write them. ' +
          (act === 'take'
            ? 'Leave the custom settings out of the checkpoint, or give the user Customize ' +
              'Application.'
            : 'This checkpoint holds custom settings: give the user Customize Application.') +
          ' No record was read or written.',
      );
      expect(having).toMatchObject({ allowed: true });
      expect(without.asked.filter((soql) => soql.includes('UserPermissionAccess'))).toEqual([
        `SELECT PermissionsViewAllData, PermissionsModifyAllData, ${CUSTOMIZE}, ` +
          'PermissionsQueryAllFiles FROM UserPermissionAccess',
      ]);
    }
  });

  it('takes View All Custom Settings for no lift: it reads custom settings and never writes them', async () => {
    const { conn } = orgSaying({
      id: ORG_ID,
      sandbox: true,
      permissions: { ...BOTH, PermissionsViewAllCustomSettings: true, [CUSTOMIZE]: false },
    });

    const answer = await guardCheckpoint(conn, {
      ...asking('rewind', SANDBOX),
      customSettings: true,
    });

    expect(answer).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
  });

  it('asks nothing more of an act that holds no custom setting: a user without Customize Application passes, and the statement does not name it', async () => {
    for (const customSettings of [undefined, false]) {
      const { conn, asked } = orgSaying({ id: ORG_ID, sandbox: true, permissions: BOTH });

      const answer = await guardCheckpoint(conn, {
        ...asking('rewind', SANDBOX),
        ...(customSettings !== undefined ? { customSettings } : {}),
      });

      expect(answer).toMatchObject({ allowed: true });
      expect(asked.join(' ')).not.toContain(CUSTOMIZE);
    }
  });

  it('still asks for Customize Application of an org that does not know Query All Files', async () => {
    const lacking = orgSaying({
      id: ORG_ID,
      sandbox: true,
      unknownFields: ['PermissionsQueryAllFiles'],
    });
    const having = orgSaying({
      id: ORG_ID,
      sandbox: true,
      permissions: { ...BOTH, [CUSTOMIZE]: true },
      unknownFields: ['PermissionsQueryAllFiles'],
    });

    const refused = await guardCheckpoint(lacking.conn, {
      ...asking('take', SANDBOX),
      customSettings: true,
    });
    const allowed = await guardCheckpoint(having.conn, {
      ...asking('take', SANDBOX),
      customSettings: true,
    });

    expect(refused).toMatchObject({ allowed: false, refusal: { code: 'PERMISSIONS' } });
    expect(allowed).toMatchObject({ allowed: true, queryAllFiles: false });
    expect(having.asked.filter((soql) => soql.includes('UserPermissionAccess'))[1]).toBe(
      `SELECT PermissionsViewAllData, PermissionsModifyAllData, ${CUSTOMIZE} FROM UserPermissionAccess`,
    );
  });

  it('refuses for want of View All Data and Modify All Data first, as they refuse any act', async () => {
    const { conn } = orgSaying({ id: ORG_ID, sandbox: true, permissions: {} });

    const answer = await guardCheckpoint(conn, {
      ...asking('take', SANDBOX),
      customSettings: true,
    });

    expect(answer.allowed === false && answer.refusal.message).toContain(
      "doesn't have them. No record was read or written.",
    );
  });
});
