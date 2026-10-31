/**
 * A target org in miniature for the mute lease: its permission sets, the
 * assignments of them to its users, what the connection's user may do, and
 * what kind of org it says it is — answered through a jsforce connection's
 * own methods (`query`, `identity`, `sobject(…).create` and `destroy`), so the
 * lease's adapter to a connection is crossed as a real run crosses it.
 *
 * As Salesforce answers them:
 *
 * - An assignment of a set its user already holds is refused
 *   `DUPLICATE_VALUE` "Duplicate PermissionSetAssignment", and nothing is
 *   written. A single insert through jsforce rejects with the error, its
 *   `errorCode` and its name both the code, rather than resolving.
 * - A delete of an assignment that is gone answers `ENTITY_IS_DELETED`
 *   "entity is deleted"; of an id that never was one, `INVALID_CROSS_REFERENCE_KEY`.
 * - An assignment of a set the org does not hold is refused
 *   `INVALID_CROSS_REFERENCE_KEY`, as is one to a user it does not know.
 * - `UserPermissionAccess` answers the connection user's own permissions, one
 *   row; a field the org does not let that user read refuses the query whole
 *   (`INVALID_FIELD`).
 * - Ids are 18 characters, the form every query answers; an id given in a
 *   query matches in 15 characters as in 18.
 * - `SetupEntityAccess` holds one row per setup entity a set gives access to,
 *   whatever its type — custom permissions, Apex classes, pages —, its
 *   `SetupEntityType` the type's name: a query that does not filter by it
 *   gets them all. `Parent` comes back as a nested record with its
 *   `attributes`, as jsforce gives a relationship; `COUNT(Id) n` grouped by
 *   `ParentId` answers one row per set.
 * - `CustomPermission` answers by `DeveloperName` or by `Id`, its
 *   `NamespacePrefix` null for one of the org's own.
 *
 * Every write is logged in the order it was made, so a test can hold the
 * lease to the order it journals and assigns in.
 */

import type { Connection } from 'jsforce';

/** A permission set of the org. */
export interface MemoryPermissionSet {
  id: string;
  name: string;
  namespace?: string;
  label?: string;
  /** The custom permissions it grants, by id. */
  customPermissions?: string[];
  /** The other setup entities it gives access to — Apex classes, pages —, by id. */
  otherEntities?: string[];
  /** A profile's own set, which no user is assigned. */
  ownedByProfile?: boolean;
  /** The objects it gives permissions on (`ObjectPermissions`), by count. */
  objects?: number;
}

/** A custom permission of the org. */
export interface MemoryCustomPermission {
  id: string;
  developerName: string;
  namespace?: string;
}

/** An assignment of a set to a user. */
export interface MemoryAssignment {
  id: string;
  assigneeId: string;
  permissionSetId: string;
}

/** What the org holds and says, set by the test. */
export interface MemoryPermissionOrgSetup {
  organizationId?: string;
  userId?: string;
  /** `IsSandbox`; a production org answers false with an edition such as `Enterprise Edition`. */
  sandbox?: boolean;
  edition?: string;
  sets?: MemoryPermissionSet[];
  customPermissions?: MemoryCustomPermission[];
  /** Refuse every query of `SetupEntityAccess` with this code, as an org that will not let the user read it. */
  refuseSetupEntityAccess?: string;
  assignments?: MemoryAssignment[];
  /** The connection user's `PermissionsAssignPermissionSets`; `unreadable` refuses the query. */
  canAssign?: boolean | 'unreadable';
  canManageUsers?: boolean;
  /** Called before each write, in order: a test hooks what happens between two of them. */
  beforeWrite?: (write: MemoryPermissionWrite) => void | Promise<void>;
  /** Sets whose assignment the org refuses, by id, with this code. */
  refuseAssigning?: Readonly<Record<string, string>>;
  /** Assignments whose delete the org refuses, by id, with this code. */
  refuseDeleting?: Readonly<Record<string, string>>;
}

/** One write the org was sent. */
export type MemoryPermissionWrite =
  { kind: 'insert'; permissionSetId: string; assigneeId: string } | { kind: 'delete'; id: string };

/** An error as jsforce raises it for a refused single-record call. */
class OrgRefusal extends Error {
  readonly errorCode: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.errorCode = code;
  }
}

/** A string list of a SOQL `IN (…)`. */
function inList(soql: string, field: string): string[] {
  const match = new RegExp(`${field}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(soql);
  return (match?.[1] ?? '')
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
    .filter((v) => v !== '');
}

/** An id as SOQL matches it, whichever length it is written in. */
function key15(id: string): string {
  return id.slice(0, 15);
}

/** The value of `field = '…'` in a SOQL WHERE. */
function equalTo(soql: string, field: string): string | undefined {
  return new RegExp(`${field}\\s*=\\s*'([^']*)'`, 'i').exec(soql)?.[1];
}

/** The org, and what a test reads back of it. */
export interface MemoryPermissionOrg {
  /** The connection a run holds to it. */
  connection: Pick<Connection, 'query' | 'identity' | 'sobject'>;
  /** The assignments it holds now. */
  assignments: () => MemoryAssignment[];
  /** Every write sent, in order. */
  writes: MemoryPermissionWrite[];
  /** Every query sent, in order. */
  queries: string[];
  /** Assign a set as an admin would, outside any run. */
  assign: (permissionSetId: string, assigneeId?: string) => string;
  organizationId: string;
  userId: string;
}

/** An org holding `setup`. */
export function memoryPermissionOrg(setup: MemoryPermissionOrgSetup = {}): MemoryPermissionOrg {
  const organizationId = setup.organizationId ?? '00Dxx0000000001AAA';
  const userId = setup.userId ?? '005xx0000000001AAA';
  const sets = setup.sets ?? [];
  const assignments: MemoryAssignment[] = (setup.assignments ?? []).map((a) => ({ ...a }));
  const writes: MemoryPermissionWrite[] = [];
  const queries: string[] = [];
  let next = 1;
  const newId = (): string => `0Paxx${String(next++).padStart(10, '0')}AAA`;

  const insert = (assigneeId: string, permissionSetId: string): string => {
    if (!sets.some((s) => s.id === permissionSetId) || !assigneeId.startsWith('005')) {
      throw new OrgRefusal('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id');
    }
    const refused = setup.refuseAssigning?.[permissionSetId];
    if (refused) throw new OrgRefusal(refused, `The org refused the assignment: ${refused}`);
    if (
      assignments.some((a) => a.assigneeId === assigneeId && a.permissionSetId === permissionSetId)
    ) {
      throw new OrgRefusal(
        'DUPLICATE_VALUE',
        `Duplicate PermissionSetAssignment. Assignee: ${assigneeId}; Permission Set: ${permissionSetId}`,
      );
    }
    const id = newId();
    assignments.push({ id, assigneeId, permissionSetId });
    return id;
  };

  /** `SetupEntityAccess` as the org answers it: every set's grants, filtered and projected as asked. */
  const setupEntityAccess = (soql: string): Array<Record<string, unknown>> => {
    const type = equalTo(soql, 'SetupEntityType');
    const parents = /\bParentId\s+IN/i.test(soql) ? inList(soql, 'ParentId').map(key15) : null;
    const entities = /\bSetupEntityId\s+IN/i.test(soql)
      ? inList(soql, 'SetupEntityId').map(key15)
      : null;
    const assignable = /Parent\.IsOwnedByProfile\s*=\s*false/i.test(soql);
    const rows = sets.flatMap((set) => [
      ...(set.customPermissions ?? []).map((id) => ({ set, id, type: 'CustomPermission' })),
      ...(set.otherEntities ?? []).map((id) => ({ set, id, type: 'ApexClass' })),
    ]);
    const kept = rows.filter(
      (row) =>
        (type === undefined || row.type === type) &&
        (parents === null || parents.includes(key15(row.set.id))) &&
        (entities === null || entities.includes(key15(row.id))) &&
        (!assignable || row.set.ownedByProfile !== true),
    );
    if (/COUNT\(Id\)/i.test(soql)) {
      const counts = new Map<string, number>();
      for (const row of kept) counts.set(row.set.id, (counts.get(row.set.id) ?? 0) + 1);
      return [...counts].map(([ParentId, n]) => ({ ParentId, n }));
    }
    const asked = /SELECT\s+(.*?)\s+FROM/i.exec(soql)?.[1] ?? '';
    return kept.map((row) => ({
      ...(/\bParentId\b/.test(asked) ? { ParentId: row.set.id } : {}),
      ...(/\bSetupEntityId\b/.test(asked) ? { SetupEntityId: row.id } : {}),
      ...(/\bSetupEntityType\b/.test(asked) ? { SetupEntityType: row.type } : {}),
      ...(/\bParent\./.test(asked)
        ? {
            Parent: {
              attributes: { type: 'PermissionSet' },
              Name: row.set.name,
              Label: row.set.label ?? row.set.name,
              NamespacePrefix: row.set.namespace ?? null,
            },
          }
        : {}),
    }));
  };

  const query = async (soql: string) => {
    queries.push(soql);
    const records = ((): Array<Record<string, unknown>> => {
      if (/FROM Organization/i.test(soql)) {
        return /OrganizationType/i.test(soql)
          ? [{ OrganizationType: setup.edition ?? 'Developer Edition' }]
          : [{ Id: organizationId, IsSandbox: setup.sandbox ?? true }];
      }
      if (/FROM UserPermissionAccess/i.test(soql)) {
        if (setup.canAssign === 'unreadable') {
          throw new OrgRefusal(
            'INVALID_FIELD',
            "No such column 'PermissionsAssignPermissionSets' on entity 'UserPermissionAccess'",
          );
        }
        return [
          {
            PermissionsAssignPermissionSets: setup.canAssign ?? true,
            PermissionsManageUsers: setup.canManageUsers ?? false,
          },
        ];
      }
      if (/FROM PermissionSetAssignment/i.test(soql)) {
        const assignee = equalTo(soql, 'AssigneeId');
        const ids = inList(soql, 'PermissionSetId');
        return assignments
          .filter((a) => a.assigneeId === assignee && ids.includes(a.permissionSetId))
          .map((a) => ({
            Id: a.id,
            PermissionSetId: a.permissionSetId,
            PermissionSet: { Name: sets.find((s) => s.id === a.permissionSetId)?.name },
          }));
      }
      if (/FROM SetupEntityAccess/i.test(soql)) {
        if (setup.refuseSetupEntityAccess) {
          throw new OrgRefusal(
            setup.refuseSetupEntityAccess,
            `${setup.refuseSetupEntityAccess}: the org refused the query of SetupEntityAccess`,
          );
        }
        return setupEntityAccess(soql);
      }
      if (/FROM ObjectPermissions\b/i.test(soql) && /COUNT\(Id\)/i.test(soql)) {
        const parents = inList(soql, 'ParentId').map(key15);
        return sets
          .filter((set) => parents.includes(key15(set.id)) && (set.objects ?? 0) > 0)
          .map((set) => ({ ParentId: set.id, n: set.objects }));
      }
      if (/FROM CustomPermission\b/i.test(soql)) {
        const byName = inList(soql, 'DeveloperName').map((n) => n.toLowerCase());
        const byId = /\bDeveloperName\s+IN/i.test(soql) ? [] : inList(soql, '\\bId').map(key15);
        return (setup.customPermissions ?? [])
          .filter((p) =>
            byName.length > 0
              ? byName.includes(p.developerName.toLowerCase())
              : byId.includes(key15(p.id)),
          )
          .map((p) => ({
            Id: p.id,
            DeveloperName: p.developerName,
            NamespacePrefix: p.namespace ?? null,
          }));
      }
      if (/FROM PermissionSet\b/i.test(soql)) {
        const names = inList(soql, 'Name').map((n) => n.toLowerCase());
        return sets
          .filter((s) => names.includes(s.name.toLowerCase()))
          .map((s) => ({ Id: s.id, Name: s.name, NamespacePrefix: s.namespace ?? null }));
      }
      throw new OrgRefusal('MALFORMED_QUERY', `The memory org does not answer: ${soql}`);
    })();
    return { records, totalSize: records.length, done: true };
  };

  const sobject = (name: string) => {
    if (name !== 'PermissionSetAssignment') {
      throw new Error(`The memory org writes PermissionSetAssignment alone, not ${name}`);
    }
    return {
      create: async (record: { AssigneeId: string; PermissionSetId: string }) => {
        const write: MemoryPermissionWrite = {
          kind: 'insert',
          permissionSetId: record.PermissionSetId,
          assigneeId: record.AssigneeId,
        };
        await setup.beforeWrite?.(write);
        writes.push(write);
        const id = insert(record.AssigneeId, record.PermissionSetId);
        return { id, success: true, errors: [] };
      },
      destroy: async (id: string) => {
        const write: MemoryPermissionWrite = { kind: 'delete', id };
        await setup.beforeWrite?.(write);
        writes.push(write);
        const refused = setup.refuseDeleting?.[id];
        if (refused) throw new OrgRefusal(refused, `The org refused the delete: ${refused}`);
        const at = assignments.findIndex((a) => a.id === id);
        if (at < 0) {
          throw id.startsWith('0Pa')
            ? new OrgRefusal('ENTITY_IS_DELETED', 'entity is deleted')
            : new OrgRefusal('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id');
        }
        assignments.splice(at, 1);
        return { id, success: true, errors: [] };
      },
    };
  };

  return {
    connection: {
      query,
      identity: async () => ({ user_id: userId, organization_id: organizationId }),
      sobject,
    } as unknown as Pick<Connection, 'query' | 'identity' | 'sobject'>,
    assignments: () => assignments.map((a) => ({ ...a })),
    writes,
    queries,
    assign: (permissionSetId, assigneeId = userId) => insert(assigneeId, permissionSetId),
    organizationId,
    userId,
  };
}
