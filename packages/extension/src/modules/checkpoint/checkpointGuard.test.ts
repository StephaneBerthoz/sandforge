import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { OrgTypeAndEdition } from '@sandforge/shared';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import {
  guardCheckpoint,
  type CheckpointAct,
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
}

const BOTH = { PermissionsViewAllData: true, PermissionsModifyAllData: true };

/** A connection to an org that answers as `says`, and the statements it was asked. */
function orgSaying(says: OrgSays) {
  const asked: string[] = [];
  const conn = {
    query: vi.fn(async (soql: string) => {
      asked.push(soql);
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
  } as unknown as Pick<Connection, 'query'>;
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
    });
    expect(scratch).toEqual({
      allowed: true,
      org: { id: ORG_ID, sandbox: true },
      tier: 'scratch',
      queryAllFiles: false,
    });
    expect(developer).toEqual({
      allowed: true,
      org: { id: ORG_ID, sandbox: false, edition: 'Developer Edition' },
      tier: 'developer',
      queryAllFiles: false,
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
