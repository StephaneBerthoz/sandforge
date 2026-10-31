import { describe, expect, it } from 'vitest';
import { memoryPermissionOrg } from './memoryPermissionOrg.js';

const SET = '0PSxx0000000001AAA';
const OTHER_SET = '0PSxx0000000002AAA';

/** The org's connection, as a test reaches its methods. */
function conn(org: ReturnType<typeof memoryPermissionOrg>) {
  return org.connection as unknown as {
    query: (soql: string) => Promise<{ records: Array<Record<string, unknown>> }>;
    identity: () => Promise<{ user_id: string; organization_id: string }>;
    sobject: (name: string) => {
      create: (record: { AssigneeId: string; PermissionSetId: string }) => Promise<{ id: string }>;
      destroy: (id: string) => Promise<{ id: string }>;
    };
  };
}

describe('memoryPermissionOrg', () => {
  it('assigns a set once, and refuses a second assignment of it DUPLICATE_VALUE, as jsforce rejects it', async () => {
    const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'PS_Bypass' }] });
    const assignments = conn(org).sobject('PermissionSetAssignment');
    const { id } = await assignments.create({ AssigneeId: org.userId, PermissionSetId: SET });
    expect(org.assignments()).toEqual([{ id, assigneeId: org.userId, permissionSetId: SET }]);

    const refused = await assignments
      .create({ AssigneeId: org.userId, PermissionSetId: SET })
      .catch((err: unknown) => err);
    expect(refused).toMatchObject({ name: 'DUPLICATE_VALUE', errorCode: 'DUPLICATE_VALUE' });
    expect(org.assignments()).toHaveLength(1);
  });

  it('refuses an assignment of a set it does not hold', async () => {
    const org = memoryPermissionOrg({ sets: [] });
    await expect(
      conn(org).sobject('PermissionSetAssignment').create({
        AssigneeId: org.userId,
        PermissionSetId: SET,
      }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_CROSS_REFERENCE_KEY' });
  });

  it('deletes an assignment, and answers ENTITY_IS_DELETED for one gone', async () => {
    const org = memoryPermissionOrg({ sets: [{ id: SET, name: 'PS_Bypass' }] });
    const id = org.assign(SET);
    const assignments = conn(org).sobject('PermissionSetAssignment');
    await assignments.destroy(id);
    expect(org.assignments()).toEqual([]);
    await expect(assignments.destroy(id)).rejects.toMatchObject({ errorCode: 'ENTITY_IS_DELETED' });
    expect(org.writes).toEqual([
      { kind: 'delete', id },
      { kind: 'delete', id },
    ]);
  });

  it('answers the user’s assignments of the sets asked, and the sets by name', async () => {
    const org = memoryPermissionOrg({
      sets: [
        { id: SET, name: 'PS_Bypass' },
        { id: OTHER_SET, name: 'Bypass', namespace: 'pkg' },
      ],
    });
    org.assign(SET);
    org.assign(OTHER_SET, '005xx0000000009AAA');
    const held = await conn(org).query(
      `SELECT Id, PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${org.userId}' ` +
        `AND PermissionSetId IN ('${SET}', '${OTHER_SET}')`,
    );
    expect(held.records.map((r) => r['PermissionSetId'])).toEqual([SET]);
    const sets = await conn(org).query(
      "SELECT Id, Name, NamespacePrefix FROM PermissionSet WHERE Name IN ('Bypass')",
    );
    expect(sets.records).toEqual([{ Id: OTHER_SET, Name: 'Bypass', NamespacePrefix: 'pkg' }]);
  });

  it('answers what kind of org it is, and what its user may do, or refuses the field', async () => {
    const org = memoryPermissionOrg({
      sandbox: false,
      edition: 'Enterprise Edition',
      canAssign: false,
    });
    expect(
      (await conn(org).query('SELECT Id, IsSandbox FROM Organization LIMIT 1')).records,
    ).toEqual([{ Id: org.organizationId, IsSandbox: false }]);
    expect(
      (
        await conn(org).query(
          'SELECT PermissionsAssignPermissionSets, PermissionsManageUsers FROM UserPermissionAccess',
        )
      ).records,
    ).toEqual([{ PermissionsAssignPermissionSets: false, PermissionsManageUsers: false }]);
    const unreadable = memoryPermissionOrg({ canAssign: 'unreadable' });
    await expect(
      conn(unreadable).query('SELECT PermissionsAssignPermissionSets FROM UserPermissionAccess'),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
    expect(await conn(org).identity()).toEqual({
      user_id: org.userId,
      organization_id: org.organizationId,
    });
  });

  it('answers SetupEntityAccess as Salesforce does: every type unless filtered, ids in 15 or 18, Parent nested', async () => {
    const FLOW_CP = '0CPxx0000000001AAA';
    const VR_CP = '0CPxx0000000002AAA';
    const CLASS = '01pxx0000000001AAA';
    const org = memoryPermissionOrg({
      sets: [
        {
          id: SET,
          name: 'PS_Bypass',
          label: 'Bypass',
          customPermissions: [FLOW_CP, VR_CP],
          otherEntities: [CLASS],
        },
        { id: OTHER_SET, name: 'Profile_Own', ownedByProfile: true, customPermissions: [FLOW_CP] },
      ],
      customPermissions: [
        { id: FLOW_CP, developerName: 'Bypass_Flow' },
        { id: VR_CP, developerName: 'Bypass_VR' },
      ],
    });
    const granted = await conn(org).query(
      "SELECT ParentId, SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType = 'CustomPermission' " +
        `AND ParentId IN ('${SET.slice(0, 15)}')`,
    );
    expect(granted.records).toEqual([
      { ParentId: SET, SetupEntityId: FLOW_CP },
      { ParentId: SET, SetupEntityId: VR_CP },
    ]);
    // Counted whatever their type: the Apex class too.
    const counted = await conn(org).query(
      `SELECT ParentId, COUNT(Id) n FROM SetupEntityAccess WHERE ParentId IN ('${SET}') GROUP BY ParentId`,
    );
    expect(counted.records).toEqual([{ ParentId: SET, n: 3 }]);
    const holding = await conn(org).query(
      'SELECT SetupEntityId, ParentId, Parent.Name, Parent.Label, Parent.NamespacePrefix ' +
        "FROM SetupEntityAccess WHERE SetupEntityType = 'CustomPermission' " +
        `AND SetupEntityId IN ('${FLOW_CP}') AND Parent.IsOwnedByProfile = false ` +
        'AND Parent.PermissionSetGroupId = null',
    );
    expect(holding.records).toEqual([
      {
        ParentId: SET,
        SetupEntityId: FLOW_CP,
        Parent: {
          attributes: { type: 'PermissionSet' },
          Name: 'PS_Bypass',
          Label: 'Bypass',
          NamespacePrefix: null,
        },
      },
    ]);
    const named = await conn(org).query(
      `SELECT Id, DeveloperName, NamespacePrefix FROM CustomPermission WHERE Id IN ('${VR_CP}')`,
    );
    expect(named.records).toEqual([
      { Id: VR_CP, DeveloperName: 'Bypass_VR', NamespacePrefix: null },
    ]);
  });

  it('refuses SetupEntityAccess whole for a user the org will not let read it', async () => {
    const org = memoryPermissionOrg({ refuseSetupEntityAccess: 'INSUFFICIENT_ACCESS' });
    await expect(
      conn(org).query(
        "SELECT ParentId, SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType = 'CustomPermission'",
      ),
    ).rejects.toMatchObject({ errorCode: 'INSUFFICIENT_ACCESS' });
  });
});
