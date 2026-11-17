/**
 * An org in miniature for `sandforge users`: its users and their logins, its
 * profiles and licenses, its permission sets, groups of them, groups and
 * queues, the accesses its users hold, and its setup audit trail — answered
 * through a jsforce connection's own methods (`query`, `queryMore`,
 * `identity`, `sobject(…).create`, `update`, `destroy`), so that the port of
 * `usersOrg.ts` is crossed as a real run crosses it.
 *
 * It refuses what a scratch org refused when it was asked (17/11):
 *
 * - `User.Email` written by the API is answered success and left as it was,
 *   still under `.invalid`; the setup audit trail gains a line
 *   `useremailchangesent`, "Email change attempted for user <name> (UserID:
 *   [<15 characters>]) from <old> to <new>", and Salesforce mails the new
 *   address a link: an address restores once its owner clicks it.
 * - An activation, or a profile of another license given to an active user,
 *   past the last free license is refused `LICENSE_LIMIT_EXCEEDED`, "License
 *   Limit Exceeded - <license>", no field named, and nothing of the row is
 *   written. `UsedLicenses` counts the active users of the license's
 *   profiles, live.
 * - A `PermissionSetAssignment` a user holds already is refused
 *   `DUPLICATE_VALUE`, "Duplicate PermissionSetAssignment. Assignee: <id>;
 *   Permission Set: <id>", on `AssigneeId` and `PermissionSetId`; one to an
 *   inactive user is accepted.
 * - A `GroupMember` a user holds already is answered **success, with the id
 *   of the membership already there**: no error says it was not created.
 * - More than 200 rows in one collection is refused whole,
 *   `EXCEEDED_ID_LIMIT`.
 * - A column the object does not have refuses the statement,
 *   `INVALID_FIELD`. The columns of `User` are those a scratch org's describe
 *   gave (14/11); the others are those the probes read and the Object
 *   Reference documents. A test narrows them with `org.columns.set`.
 * - A text compares whatever its case, as the org compares one; an id in 15
 *   characters as in 18; `LIKE` reads `%` and `_` as wildcards unless
 *   escaped with a backslash.
 *
 * A delete of an access that is gone answers `ENTITY_IS_DELETED`, as a
 * permission set assignment's does; no probe has read a `GroupMember`'s.
 *
 * A test-support file (`*.fixtures.ts`): no run ships it.
 */

import type { Connection } from 'jsforce';

// ─── What the org holds ──────────────────────────────────────────────────────

/** A user of the org. Its name is a person's, which no answer of the script may carry. */
export interface TestUser {
  id: string;
  username: string;
  email: string;
  isActive: boolean;
  profileId: string;
  name?: string;
  /** Its `UserLogin.IsFrozen`. */
  frozen?: boolean;
  /** Its `UserLogin`'s id; `null` for a user the org keeps no login of. */
  loginId?: string | null;
}

export interface TestProfile {
  id: string;
  name: string;
  licenseId: string;
}

export interface TestLicense {
  id: string;
  name: string;
  total: number;
  /** Licenses taken by active users the org holds outside `users`. */
  outside?: number;
}

export interface TestPermissionSet {
  id: string;
  name: string;
  namespace?: string;
  /** The `UserLicense` or `PermissionSetLicense` it needs. */
  licenseId?: string;
  ownedByProfile?: boolean;
}

export interface TestPermissionSetGroup {
  id: string;
  developerName: string;
  namespace?: string;
}

export interface TestGroup {
  id: string;
  developerName: string;
  type: 'Regular' | 'Queue' | 'Role' | 'Organization';
}

export interface TestAssignment {
  id: string;
  assigneeId: string;
  permissionSetId?: string;
  permissionSetGroupId?: string;
}

export interface TestMembership {
  id: string;
  groupId: string;
  userId: string;
}

export interface TestAuditLine {
  action: string;
  display: string;
  createdDate: string;
}

/** A write the org was sent, row by row, in the order it came. */
export interface TestWrite {
  kind: 'create' | 'update' | 'destroy';
  object: string;
  rows: Array<Record<string, unknown>>;
  allOrNone: unknown;
}

/** What the org is made of. */
export interface UsersTestOrgSetup {
  organizationId?: string;
  /** The user the connection is: the first user unless named. */
  connectedUserId?: string;
  /** What `UserPermissionAccess` answers of Manage Users; `unreadable` refuses the read. */
  manageUsers?: boolean | 'unreadable';
  users: TestUser[];
  profiles: TestProfile[];
  licenses: TestLicense[];
  permissionSets?: TestPermissionSet[];
  permissionSetGroups?: TestPermissionSetGroup[];
  groups?: TestGroup[];
  assignments?: TestAssignment[];
  memberships?: TestMembership[];
  /** `PermissionSetLicenseAssign` rows: who holds which permission set license. */
  licenseAssignments?: Array<{ assigneeId: string; permissionSetLicenseId: string }>;
  auditTrail?: TestAuditLine[];
  /** Rows a page of a read holds: 2,000 unless given. */
  pageSize?: number;
  /** A refusal of the org's own for a row, by its code and words: a deactivation it will not do. */
  refuse?: (write: {
    kind: TestWrite['kind'];
    object: string;
    row: Record<string, unknown>;
  }) => { code: string; message: string } | undefined;
  /** The org's clock, for the audit trail. */
  now?: () => Date;
}

/**
 * The columns each object has, as the org reads them: a statement naming
 * another is refused `INVALID_FIELD`.
 */
export const USERS_ORG_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  User: [
    'Id',
    'Username',
    'Email',
    'IsActive',
    'ProfileId',
    'Name',
    'FirstName',
    'LastName',
    'UserType',
    'Alias',
    'LastLoginDate',
  ],
  UserLogin: ['Id', 'UserId', 'IsFrozen', 'IsPasswordLocked'],
  Profile: ['Id', 'Name', 'UserLicenseId', 'UserType'],
  UserLicense: ['Id', 'Name', 'TotalLicenses', 'UsedLicenses', 'Status', 'LicenseDefinitionKey'],
  PermissionSet: ['Id', 'Name', 'Label', 'NamespacePrefix', 'IsOwnedByProfile', 'LicenseId'],
  PermissionSetGroup: ['Id', 'DeveloperName', 'MasterLabel', 'NamespacePrefix', 'Status'],
  PermissionSetAssignment: [
    'Id',
    'AssigneeId',
    'PermissionSetId',
    'PermissionSetGroupId',
    'IsActive',
    'ExpirationDate',
  ],
  Group: ['Id', 'Name', 'DeveloperName', 'Type', 'RelatedId', 'Email'],
  GroupMember: ['Id', 'GroupId', 'UserOrGroupId'],
  SetupAuditTrail: ['Id', 'Action', 'Section', 'Display', 'CreatedDate', 'CreatedById'],
  PermissionSetLicenseAssign: ['Id', 'AssigneeId', 'PermissionSetLicenseId'],
  UserPermissionAccess: [
    'PermissionsManageUsers',
    'PermissionsAssignPermissionSets',
    'PermissionsEmailSingle',
  ],
};

/** The relationships a statement may follow, and the object each reaches. */
const RELATIONSHIPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  User: { Profile: 'Profile' },
};

// ─── Errors, as jsforce throws the org's ─────────────────────────────────────

/** An error as jsforce throws the org's: its code on `errorCode` and `name`. */
function refusedByTheOrg(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: errorCode, errorCode });
}

// ─── Statements ──────────────────────────────────────────────────────────────

type Literal =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'dateTime'; ms: number }
  | { kind: 'text'; raw: string };

type RowTest = (row: (column: string) => unknown) => boolean;

const TOKENS =
  /'(?:[^'\\]|\\.)*'|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|-?\d+(?:\.\d+)?|!=|<=|>=|[=<>(),]|[A-Za-z_][\w.]*|\S/g;
const ID_SHAPE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** A string literal's text: its escapes read, a `LIKE`'s wildcards kept as written. */
function unescaped(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** A `LIKE` pattern as a regular expression: `%` any run, `_` any one character, `\x` x itself. */
function likePattern(raw: string): RegExp {
  let source = '';
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at];
    if (char === '\\' && at + 1 < raw.length) {
      at += 1;
      source += raw[at].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '%') source += '.*';
    else if (char === '_') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'is');
}

/** Whether a row's value equals a literal, as the org compares them. */
function equals(value: unknown, literal: Literal): boolean {
  switch (literal.kind) {
    case 'null':
      return value === null || value === undefined;
    case 'boolean':
      return value === literal.value;
    case 'number':
      return Number(value) === literal.value;
    case 'dateTime':
      return typeof value === 'string' && Date.parse(value) === literal.ms;
    case 'text': {
      if (value === null || value === undefined) return false;
      const held = String(value);
      const wanted = unescaped(literal.raw);
      if (ID_SHAPE.test(held) && ID_SHAPE.test(wanted)) {
        return held.slice(0, 15) === wanted.slice(0, 15);
      }
      return held.toLowerCase() === wanted.toLowerCase();
    }
  }
}

/** How a row's value stands to a date-time or a number literal. */
function standing(value: unknown, literal: Literal): number {
  if (literal.kind === 'dateTime' && typeof value === 'string') {
    return Math.sign(Date.parse(value) - literal.ms);
  }
  if (literal.kind === 'number' && value !== null && value !== undefined) {
    return Math.sign(Number(value) - literal.value);
  }
  return Number.NaN;
}

interface Statement {
  object: string;
  columns: string[];
  /** The fields the WHERE clause compares. */
  compared: string[];
  where: RowTest;
  limit?: number;
}

/** Read a statement this org understands; anything else throws, so it never passes for an empty read. */
function parse(soql: string): Statement {
  const tokens = soql.match(TOKENS) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const isWord = (word: string): boolean => peek()?.toUpperCase() === word;
  const take = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`Statement ends too early: ${soql}`);
    return token;
  };
  const expect = (wanted: string): void => {
    const token = take();
    if (token.toUpperCase() !== wanted)
      throw new Error(`Expected ${wanted}, found ${token}: ${soql}`);
  };
  const literal = (): Literal => {
    const token = take();
    const word = token.toLowerCase();
    if (word === 'null') return { kind: 'null' };
    if (word === 'true' || word === 'false') return { kind: 'boolean', value: word === 'true' };
    if (token.startsWith("'")) return { kind: 'text', raw: token.slice(1, -1) };
    if (/^\d{4}-\d{2}-\d{2}T/.test(token)) {
      return { kind: 'dateTime', ms: Math.floor(Date.parse(token) / 1000) * 1000 };
    }
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return { kind: 'number', value: Number(token) };
    throw new Error(`Not a value this org reads: ${token}: ${soql}`);
  };
  const fieldOf = (): string => {
    const token = take();
    if (!/^[A-Za-z_][\w.]*$/.test(token)) throw new Error(`Not a field: ${token}: ${soql}`);
    return token;
  };
  const compared: string[] = [];
  const term = (): RowTest => {
    if (peek() === '(') {
      take();
      const inner = anyOf();
      expect(')');
      return inner;
    }
    const field = fieldOf();
    compared.push(field);
    let operator = take().toUpperCase();
    if (operator === 'NOT') {
      expect('IN');
      operator = 'NOT IN';
    }
    if (operator === 'IN' || operator === 'NOT IN') {
      expect('(');
      const values = [literal()];
      while (peek() === ',') {
        take();
        values.push(literal());
      }
      expect(')');
      const among = (row: (c: string) => unknown): boolean =>
        values.some((value) => equals(row(field), value));
      return operator === 'IN' ? among : (row) => !among(row);
    }
    if (operator === 'LIKE') {
      const pattern = literal();
      if (pattern.kind !== 'text') throw new Error(`LIKE takes a text: ${soql}`);
      const test = likePattern(pattern.raw);
      return (row) => {
        const value = row(field);
        return typeof value === 'string' && test.test(value);
      };
    }
    const value = literal();
    switch (operator) {
      case '=':
        return (row) => equals(row(field), value);
      case '!=':
        return (row) => !equals(row(field), value);
      case '>=':
        return (row) => standing(row(field), value) >= 0;
      case '>':
        return (row) => standing(row(field), value) > 0;
      case '<=':
        return (row) => standing(row(field), value) <= 0;
      case '<':
        return (row) => standing(row(field), value) < 0;
      default:
        throw new Error(`Unsupported operator ${operator}: ${soql}`);
    }
  };
  const allOf = (): RowTest => {
    const tests = [term()];
    while (isWord('AND')) {
      take();
      tests.push(term());
    }
    return (row) => tests.every((test) => test(row));
  };
  const anyOf = (): RowTest => {
    const tests = [allOf()];
    while (isWord('OR')) {
      take();
      tests.push(allOf());
    }
    return (row) => tests.some((test) => test(row));
  };

  expect('SELECT');
  const columns = [fieldOf()];
  while (peek() === ',') {
    take();
    columns.push(fieldOf());
  }
  expect('FROM');
  const object = fieldOf();
  let where: RowTest = () => true;
  if (isWord('WHERE')) {
    take();
    where = anyOf();
  }
  let limit: number | undefined;
  if (isWord('LIMIT')) {
    take();
    limit = Number(take());
  }
  if (at !== tokens.length) throw new Error(`Unread tail from ${tokens[at]}: ${soql}`);
  return { object, columns, compared, where, ...(limit === undefined ? {} : { limit }) };
}

// ─── The org ─────────────────────────────────────────────────────────────────

/** The org, its connection, and what it was sent. */
export interface UsersTestOrg {
  /** The connection a run holds to it. */
  connection: Pick<Connection, 'query' | 'queryMore' | 'identity' | 'sobject'>;
  /** The columns each object has: a test narrows them to prove a read names only real ones. */
  columns: Map<string, string[]>;
  /** Every statement read, in order. */
  queries: string[];
  /** Every write, in order. */
  writes: TestWrite[];
  /** The emails Salesforce sent to people: one per address asked back. */
  emailsSent: () => number;
  /** The org's tables, live. */
  users: TestUser[];
  assignments: TestAssignment[];
  memberships: TestMembership[];
  auditTrail: TestAuditLine[];
  /** The used licenses of a license, as `UserLicense.UsedLicenses` answers it. */
  usedLicenses: (licenseId: string) => number;
  /** Its owner clicks the link sent to the address asked: the address is restored. */
  confirmAddress: (userId: string) => void;
  organizationId: string;
  connectedUserId: string;
}

const PAGE_SIZE = 2_000;

/** A counter-shaped id of an object's prefix, 18 characters. */
function newId(prefix: string, count: number): string {
  return `${prefix}${String(count).padStart(12, '0')}AAA`;
}

/** See the module's comment. */
export function usersTestOrg(setup: UsersTestOrgSetup): UsersTestOrg {
  const organizationId = setup.organizationId ?? '00D000000000011EAA';
  const users = setup.users.map((user) => ({ ...user }));
  const connectedUserId = setup.connectedUserId ?? users[0]?.id ?? '005000000000000AAA';
  const assignments = (setup.assignments ?? []).map((a) => ({ ...a }));
  const memberships = (setup.memberships ?? []).map((m) => ({ ...m }));
  const auditTrail = (setup.auditTrail ?? []).map((line) => ({ ...line }));
  const columns = new Map(Object.entries(USERS_ORG_COLUMNS).map(([o, c]) => [o, [...c]]));
  const queries: string[] = [];
  const writes: TestWrite[] = [];
  const asked = new Map<string, string>();
  const pages = new Map<string, Array<Record<string, unknown>>>();
  const now = setup.now ?? (() => new Date('2026-11-20T08:14:00.000Z'));
  let emails = 0;
  let created = 0;
  let cursors = 0;

  const same = (a: string, b: string): boolean => a.slice(0, 15) === b.slice(0, 15);
  const profileOf = (id: string): TestProfile | undefined =>
    setup.profiles.find((profile) => same(profile.id, id));
  const usedLicenses = (licenseId: string): number =>
    (setup.licenses.find((license) => same(license.id, licenseId))?.outside ?? 0) +
    users.filter((user) => user.isActive && profileOf(user.profileId)?.licenseId === licenseId)
      .length;

  /** Each object's rows, as the org answers them, column by column. */
  const tableOf = (object: string): Array<Record<string, unknown>> => {
    switch (object) {
      case 'User':
        return users.map((user) => ({
          Id: user.id,
          Username: user.username,
          Email: user.email,
          IsActive: user.isActive,
          ProfileId: user.profileId,
          Name: user.name ?? 'Test User',
          UserType: 'Standard',
        }));
      case 'UserLogin':
        return users
          .filter((user) => user.loginId !== null)
          .map((user, at) => ({
            Id: user.loginId ?? newId('060', at + 1),
            UserId: user.id,
            IsFrozen: user.frozen === true,
            IsPasswordLocked: false,
          }));
      case 'Profile':
        return setup.profiles.map((profile) => ({
          Id: profile.id,
          Name: profile.name,
          UserLicenseId: profile.licenseId,
          UserType: 'Standard',
        }));
      case 'UserLicense':
        return setup.licenses.map((license) => ({
          Id: license.id,
          Name: license.name,
          TotalLicenses: license.total,
          UsedLicenses: usedLicenses(license.id),
          Status: 'Active',
        }));
      case 'PermissionSet':
        return (setup.permissionSets ?? []).map((set) => ({
          Id: set.id,
          Name: set.name,
          Label: set.name,
          NamespacePrefix: set.namespace ?? null,
          IsOwnedByProfile: set.ownedByProfile === true,
          LicenseId: set.licenseId ?? null,
        }));
      case 'PermissionSetGroup':
        return (setup.permissionSetGroups ?? []).map((group) => ({
          Id: group.id,
          DeveloperName: group.developerName,
          MasterLabel: group.developerName,
          NamespacePrefix: group.namespace ?? null,
          Status: 'Updated',
        }));
      case 'PermissionSetAssignment':
        return assignments.map((a) => ({
          Id: a.id,
          AssigneeId: a.assigneeId,
          PermissionSetId: a.permissionSetId ?? null,
          PermissionSetGroupId: a.permissionSetGroupId ?? null,
          IsActive: true,
        }));
      case 'Group':
        return (setup.groups ?? []).map((group) => ({
          Id: group.id,
          Name: group.developerName,
          DeveloperName: group.developerName,
          Type: group.type,
        }));
      case 'GroupMember':
        return memberships.map((m) => ({ Id: m.id, GroupId: m.groupId, UserOrGroupId: m.userId }));
      case 'SetupAuditTrail':
        return auditTrail.map((line, at) => ({
          Id: newId('0Ym', at + 1),
          Action: line.action,
          Section: 'Manage Users',
          Display: line.display,
          CreatedDate: line.createdDate,
        }));
      case 'PermissionSetLicenseAssign':
        return (setup.licenseAssignments ?? []).map((a, at) => ({
          Id: newId('2LA', at + 1),
          AssigneeId: a.assigneeId,
          PermissionSetLicenseId: a.permissionSetLicenseId,
        }));
      case 'UserPermissionAccess':
        return [{ PermissionsManageUsers: setup.manageUsers ?? true }];
      default:
        throw refusedByTheOrg(
          'INVALID_TYPE',
          `sObject type '${object}' is not supported. If you are attempting to use a custom ` +
            "object, be sure to append the '__c' after the entity name.",
        );
    }
  };

  /** The value of `column` in a row of `object`, a relationship followed. */
  const valueOf = (object: string, row: Record<string, unknown>, column: string): unknown => {
    const [head, ...rest] = column.split('.');
    if (rest.length === 0) return row[head];
    const reached = RELATIONSHIPS[object]?.[head];
    if (reached === 'Profile') {
      const profile = tableOf('Profile').find((p) =>
        equals(p['Id'], { kind: 'text', raw: String(row['ProfileId']) }),
      );
      return profile ? valueOf('Profile', profile, rest.join('.')) : null;
    }
    return undefined;
  };

  /** Refuse a column the object does not have, as the org refuses the statement. */
  const checkColumn = (object: string, column: string): void => {
    const [head, ...rest] = column.split('.');
    if (rest.length > 0) {
      const reached = RELATIONSHIPS[object]?.[head];
      if (reached === undefined) {
        throw refusedByTheOrg(
          'INVALID_FIELD',
          `Didn't understand relationship '${head}' in field path. If you are attempting to use ` +
            "a custom relationship, be sure to append the '__r' after the custom relationship name.",
        );
      }
      checkColumn(reached, rest.join('.'));
      return;
    }
    if (!(columns.get(object) ?? []).includes(head)) {
      throw refusedByTheOrg('INVALID_FIELD', `No such column '${head}' on entity '${object}'.`);
    }
  };

  /** A page of rows, and the locator of the next one when more are left. */
  const pageOf = (
    rows: Array<Record<string, unknown>>,
  ): {
    records: Array<Record<string, unknown>>;
    done: boolean;
    totalSize: number;
    nextRecordsUrl?: string;
  } => {
    const size = setup.pageSize ?? PAGE_SIZE;
    if (rows.length <= size) return { records: rows, done: true, totalSize: rows.length };
    cursors += 1;
    const locator = `/services/data/v66.0/query/01g000000000${cursors}-${size}`;
    pages.set(locator, rows.slice(size));
    return {
      records: rows.slice(0, size),
      done: false,
      totalSize: rows.length,
      nextRecordsUrl: locator,
    };
  };

  const query = async (soql: string) => {
    queries.push(soql);
    const statement = parse(soql);
    if (statement.object === 'UserPermissionAccess' && setup.manageUsers === 'unreadable') {
      throw refusedByTheOrg(
        'INVALID_TYPE',
        "sObject type 'UserPermissionAccess' is not supported.",
      );
    }
    const table = tableOf(statement.object);
    for (const column of [...statement.columns, ...statement.compared]) {
      checkColumn(statement.object, column);
    }
    const selected = table
      .filter((row) => statement.where((column) => valueOf(statement.object, row, column)))
      .slice(0, statement.limit ?? Number.MAX_SAFE_INTEGER)
      .map((row) => {
        const answered: Record<string, unknown> = { attributes: { type: statement.object } };
        for (const column of statement.columns) {
          const [head, ...rest] = column.split('.');
          if (rest.length === 0) {
            answered[head] = row[head] ?? null;
            continue;
          }
          // A relationship comes back as a nested record, as jsforce gives one.
          const nested = (answered[head] as Record<string, unknown> | undefined) ?? {
            attributes: { type: RELATIONSHIPS[statement.object]?.[head] },
          };
          nested[rest.join('.')] = valueOf(statement.object, row, column) ?? null;
          answered[head] = nested;
        }
        return answered;
      });
    return pageOf(selected);
  };

  const queryMore = async (locator: string) => {
    const rest = pages.get(locator);
    if (!rest) throw refusedByTheOrg('INVALID_QUERY_LOCATOR', 'invalid query locator');
    pages.delete(locator);
    return pageOf(rest);
  };

  type Answer = {
    id?: string;
    success: boolean;
    errors: Array<{ statusCode: string; message: string; fields: string[] }>;
  };
  const refused = (statusCode: string, message: string, fields: string[] = []): Answer => ({
    success: false,
    errors: [{ statusCode, message, fields }],
  });

  /** An update of one `User` row: all of it, or nothing. */
  const updateUser = (row: Record<string, unknown>): Answer => {
    const user = users.find((u) => same(u.id, String(row['Id'])));
    if (!user) return refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id');
    for (const key of Object.keys(row)) {
      if (!['Id', 'attributes', 'IsActive', 'ProfileId', 'Email'].includes(key)) {
        return refused(
          'INVALID_FIELD_FOR_INSERT_UPDATE',
          `Unable to create/update fields: ${key}.`,
          [key],
        );
      }
    }
    const isActive = typeof row['IsActive'] === 'boolean' ? row['IsActive'] : user.isActive;
    const profileId = typeof row['ProfileId'] === 'string' ? row['ProfileId'] : user.profileId;
    const profile = profileOf(profileId);
    if (!profile)
      return refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id', ['ProfileId']);
    const license = setup.licenses.find((l) => l.id === profile.licenseId);
    const takes =
      isActive && (!user.isActive || profileOf(user.profileId)?.licenseId !== profile.licenseId);
    if (takes && license && usedLicenses(license.id) >= license.total) {
      return refused('LICENSE_LIMIT_EXCEEDED', `License Limit Exceeded - ${license.name}`);
    }
    user.isActive = isActive;
    user.profileId = profileId;
    if (typeof row['Email'] === 'string' && row['Email'] !== user.email) {
      // The address is asked, not changed: Salesforce mails a link to it.
      asked.set(user.id, row['Email']);
      emails += 1;
      auditTrail.push({
        action: 'useremailchangesent',
        display:
          `Email change attempted for user ${user.name ?? 'Test User'} (UserID: [` +
          `${user.id.slice(0, 15)}]) from ${user.email} to ${row['Email']}`,
        createdDate: now().toISOString(),
      });
    }
    return { id: user.id, success: true, errors: [] };
  };

  const updateLogin = (row: Record<string, unknown>): Answer => {
    const at = tableOf('UserLogin').find((login) => same(String(login['Id']), String(row['Id'])));
    const user = at && users.find((u) => same(u.id, String(at['UserId'])));
    if (!user) return refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id');
    if (typeof row['IsFrozen'] === 'boolean') user.frozen = row['IsFrozen'];
    return { id: String(at['Id']), success: true, errors: [] };
  };

  const createAssignment = (row: Record<string, unknown>): Answer => {
    const assigneeId = String(row['AssigneeId'] ?? '');
    const setId = typeof row['PermissionSetId'] === 'string' ? row['PermissionSetId'] : undefined;
    const groupId =
      typeof row['PermissionSetGroupId'] === 'string' ? row['PermissionSetGroupId'] : undefined;
    if (!users.some((u) => same(u.id, assigneeId))) {
      return refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id', ['AssigneeId']);
    }
    const known =
      (setId && (setup.permissionSets ?? []).some((s) => same(s.id, setId))) ||
      (groupId && (setup.permissionSetGroups ?? []).some((g) => same(g.id, groupId)));
    if (!known) return refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id');
    const held = assignments.find(
      (a) =>
        same(a.assigneeId, assigneeId) &&
        ((setId !== undefined &&
          a.permissionSetId !== undefined &&
          same(a.permissionSetId, setId)) ||
          (groupId !== undefined &&
            a.permissionSetGroupId !== undefined &&
            same(a.permissionSetGroupId, groupId))),
    );
    if (held) {
      return refused(
        'DUPLICATE_VALUE',
        `Duplicate PermissionSetAssignment. Assignee: ${assigneeId}; Permission Set: ${setId ?? groupId}`,
        ['AssigneeId', 'PermissionSetId'],
      );
    }
    created += 1;
    const id = newId('0Pa', created);
    assignments.push({
      id,
      assigneeId,
      ...(setId ? { permissionSetId: setId } : {}),
      ...(groupId ? { permissionSetGroupId: groupId } : {}),
    });
    return { id, success: true, errors: [] };
  };

  const createMembership = (row: Record<string, unknown>): Answer => {
    const groupId = String(row['GroupId'] ?? '');
    const userId = String(row['UserOrGroupId'] ?? '');
    if (!(setup.groups ?? []).some((g) => same(g.id, groupId))) {
      return refused('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id', ['GroupId']);
    }
    const held = memberships.find((m) => same(m.groupId, groupId) && same(m.userId, userId));
    // A membership already there is answered as if created, with its own id.
    if (held) return { id: held.id, success: true, errors: [] };
    created += 1;
    const id = newId('011', created);
    memberships.push({ id, groupId, userId });
    return { id, success: true, errors: [] };
  };

  const destroyOf = (object: string, id: string): Answer => {
    const table: Array<{ id: string }> =
      object === 'PermissionSetAssignment'
        ? assignments
        : object === 'GroupMember'
          ? memberships
          : [];
    if (object === 'User') {
      return refused('INVALID_TYPE_ON_FIELD_IN_RECORD', 'entity type cannot be deleted');
    }
    const at = table.findIndex((row) => same(row.id, id));
    if (at < 0) return refused('ENTITY_IS_DELETED', 'entity is deleted');
    table.splice(at, 1);
    return { id, success: true, errors: [] };
  };

  /** One collection call: refused whole past 200 rows, else answered row by row. */
  const collection = async (
    kind: TestWrite['kind'],
    object: string,
    rows: Array<Record<string, unknown>>,
    options: { allOrNone?: unknown } | undefined,
    each: (row: Record<string, unknown>) => Answer,
  ): Promise<Answer[]> => {
    writes.push({
      kind,
      object,
      rows: rows.map((row) => ({ ...row })),
      allOrNone: options?.allOrNone,
    });
    if (rows.length > 200) {
      throw refusedByTheOrg(
        'EXCEEDED_ID_LIMIT',
        'record limit reached. cannot submit more than 200 records into this call',
      );
    }
    return rows.map((row) => {
      const own = setup.refuse?.({ kind, object, row });
      return own ? refused(own.code, own.message) : each(row);
    });
  };

  const sobject = (object: string) => ({
    create: (records: Array<Record<string, unknown>>, options?: { allOrNone?: unknown }) =>
      collection('create', object, records, options, (row) =>
        object === 'PermissionSetAssignment'
          ? createAssignment(row)
          : object === 'GroupMember'
            ? createMembership(row)
            : refused('INVALID_TYPE', `cannot create ${object} here`),
      ),
    update: (records: Array<Record<string, unknown>>, options?: { allOrNone?: unknown }) =>
      collection('update', object, records, options, (row) =>
        object === 'User'
          ? updateUser(row)
          : object === 'UserLogin'
            ? updateLogin(row)
            : refused('INVALID_TYPE', `cannot update ${object} here`),
      ),
    destroy: (ids: string[], options?: { allOrNone?: unknown }) =>
      collection(
        'destroy',
        object,
        ids.map((id) => ({ Id: id })),
        options,
        (row) => destroyOf(object, String(row['Id'])),
      ),
  });

  const connectedUser = users.find((u) => u.id === connectedUserId);
  return {
    connection: {
      query,
      queryMore,
      identity: async () => ({
        user_id: connectedUserId,
        organization_id: organizationId,
        username: connectedUser?.username ?? 'admin@example.com',
      }),
      sobject,
    } as unknown as Pick<Connection, 'query' | 'queryMore' | 'identity' | 'sobject'>,
    columns,
    queries,
    writes,
    emailsSent: () => emails,
    users,
    assignments,
    memberships,
    auditTrail,
    usedLicenses,
    confirmAddress: (userId) => {
      const user = users.find((u) => same(u.id, userId));
      const address = user && asked.get(user.id);
      if (user && address) user.email = address;
    },
    organizationId,
    connectedUserId,
  };
}

// ─── A sandbox handed back to its testers ────────────────────────────────────

/** The ids of the sandbox below, shaped as the org's, counters padded with zeros. */
export const ACME = {
  organizationId: '00D000000000011EAA',
  licenses: { salesforce: '100000000000001AAA', platform: '100000000000002AAA' },
  profiles: {
    admin: '00e000000000001AAA',
    standard: '00e000000000002AAA',
    platform: '00e000000000003AAA',
    qa: '00e000000000004AAA',
  },
  users: {
    admin: '005000000000001AAA',
    jane: '005000000000002AAA',
    paul: '005000000000003AAA',
    erp: '005000000000004AAA',
  },
  logins: {
    admin: '060000000000001AAA',
    jane: '060000000000002AAA',
    paul: '060000000000003AAA',
    erp: '060000000000004AAA',
  },
  permissionSets: { qaTools: '0PS000000000001AAA', reports: '0PS000000000002AAA' },
  permissionSetGroups: { support: '0PG000000000001AAA' },
  groups: { qaTeam: '00G000000000001AAA', qaQueue: '00G000000000002AAA' },
} as const;

/**
 * A sandbox as a refresh leaves it: each tester's address under `.invalid`,
 * jane frozen, paul inactive, the integration user active; the connection is
 * the admin's. Salesforce Platform: 2 of 3 used; Salesforce: 1 of 3.
 */
export function acmeSetup(over: Partial<UsersTestOrgSetup> = {}): UsersTestOrgSetup {
  return {
    organizationId: ACME.organizationId,
    connectedUserId: ACME.users.admin,
    users: [
      {
        id: ACME.users.admin,
        username: 'admin@acme.com.uat',
        email: 'admin@acme.com',
        isActive: true,
        profileId: ACME.profiles.admin,
        name: 'Ada Admin',
        loginId: ACME.logins.admin,
      },
      {
        id: ACME.users.jane,
        username: 'jane.qa@acme.com.uat',
        email: 'jane.qa@acme.com.invalid',
        isActive: true,
        profileId: ACME.profiles.platform,
        name: 'Jane Tester',
        frozen: true,
        loginId: ACME.logins.jane,
      },
      {
        id: ACME.users.paul,
        username: 'paul.qa@acme.com.uat',
        email: 'paul.qa@acme.com.invalid',
        isActive: false,
        profileId: ACME.profiles.platform,
        name: 'Paul Tester',
        loginId: ACME.logins.paul,
      },
      {
        id: ACME.users.erp,
        username: 'erp.integration@acme.com.uat',
        email: 'erp.integration@acme.com.invalid',
        isActive: true,
        profileId: ACME.profiles.platform,
        name: 'Erp Integration',
        loginId: ACME.logins.erp,
      },
    ],
    profiles: [
      {
        id: ACME.profiles.admin,
        name: 'System Administrator',
        licenseId: ACME.licenses.salesforce,
      },
      { id: ACME.profiles.standard, name: 'Standard User', licenseId: ACME.licenses.salesforce },
      {
        id: ACME.profiles.platform,
        name: 'Standard Platform User',
        licenseId: ACME.licenses.platform,
      },
      { id: ACME.profiles.qa, name: 'QA Tester', licenseId: ACME.licenses.platform },
    ],
    licenses: [
      { id: ACME.licenses.salesforce, name: 'Salesforce', total: 3 },
      { id: ACME.licenses.platform, name: 'Salesforce Platform', total: 3 },
    ],
    permissionSets: [
      { id: ACME.permissionSets.qaTools, name: 'QA_Tools' },
      { id: ACME.permissionSets.reports, name: 'Report_Builder' },
    ],
    permissionSetGroups: [
      { id: ACME.permissionSetGroups.support, developerName: 'Support_Bundle' },
    ],
    groups: [
      { id: ACME.groups.qaTeam, developerName: 'QA_Team', type: 'Regular' },
      { id: ACME.groups.qaQueue, developerName: 'QA_Queue', type: 'Queue' },
    ],
    ...over,
  };
}
