/**
 * What `sandforge users` reads and writes of an org, as a jsforce connection
 * gives it: who the connection is, a read of every page of a statement, and
 * the three writes of sObject Collections it sends — `PATCH` of `User` and
 * `UserLogin` rows, `POST` and `DELETE` of `PermissionSetAssignment` and
 * `GroupMember` rows —, each with `allOrNone` false, so that every row is
 * answered on its own.
 *
 * A scratch org answered a collection of `UserLogin` rows freezing two users,
 * then one of `User` rows deactivating them, row by row; an activation past
 * the last free license was refused alone, `LICENSE_LIMIT_EXCEEDED`, the user
 * left as it was. A call the org refuses whole — more than 200 rows, a
 * session gone — is said here as a refusal of each of its rows, in the org's
 * code and words, so a run names every user it could not set up.
 *
 * The connection is typed, never loaded: jsforce stays behind its lazy
 * boundary (`core/connection/jsforceEntry.ts`), and the script that opens the
 * connection hands it here.
 */

import type { Connection } from 'jsforce';
import { recordWriteHeaders } from '@sandforge/shared';

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';

/** The rows one sObject Collections call holds at most: the org refuses a 201st. */
export const USERS_COLLECTION_ROWS = 200;

/** The objects whose rows a run updates. */
export type UsersUpdated = 'User' | 'UserLogin';

/** The objects whose rows a run creates and deletes: the accesses it gives. */
export type UsersAccessObject = 'PermissionSetAssignment' | 'GroupMember';

/** A row as the org answers a read: its columns, a relationship as a nested row. */
export type UsersRow = Record<string, unknown>;

/** One error the org answered a row with. */
export interface UsersOrgError {
  code: string;
  message: string;
  fields: string[];
}

/** What the org answered one row of a write: its id, or why it refused it. */
export interface UsersSaveResult {
  id?: string;
  success: boolean;
  errors: UsersOrgError[];
}

/** See the module's comment. */
export interface UsersOrg {
  /** The user the connection is, and its org. */
  identity: () => Promise<{ userId: string; organizationId: string; username: string }>;
  /** Every row `soql` selects, page after page. */
  query: (soql: string) => Promise<UsersRow[]>;
  update: (
    object: UsersUpdated,
    rows: ReadonlyArray<{ Id: string } & UsersRow>,
  ) => Promise<UsersSaveResult[]>;
  create: (object: UsersAccessObject, rows: readonly UsersRow[]) => Promise<UsersSaveResult[]>;
  destroy: (object: UsersAccessObject, ids: readonly string[]) => Promise<UsersSaveResult[]>;
  /** The requests sent to the org so far, reads and writes, pages included. */
  requests: () => number;
}

/** What of a jsforce connection the port uses. */
export type UsersConnection = Pick<Connection, 'query' | 'queryMore' | 'identity' | 'sobject'>;

/** The parts of `values` of `size` at most, in order. */
export function inChunks<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < values.length; at += size) chunks.push(values.slice(at, at + size));
  return chunks;
}

/** A text as a SOQL literal: quoted, its backslashes and quotes escaped. */
export function soqlText(value: string): string {
  return `'${sanitizeSoqlValue(value)}'`;
}

/** Texts as the list of an `IN`. */
export function soqlList(values: readonly string[]): string {
  return `(${values.map(soqlText).join(', ')})`;
}

/**
 * The `LIKE` pattern of every text that starts with `prefix` then a dot:
 * `jane.qa@acme.com.%`. The prefix's own `_` and `%` are escaped, so that
 * `jane_qa@acme.com` never matches `janeXqa@acme.com.uat`.
 */
export function soqlStartsWithDot(prefix: string): string {
  const escaped = sanitizeSoqlValue(prefix).replace(/[%_]/g, (wildcard) => `\\${wildcard}`);
  return `'${escaped}.%'`;
}

/**
 * The org's words with every address in them taken out, the usernames
 * `kept` left: an address is a person's, and the org's words of a refused
 * write may hold one.
 */
export function wordsWithoutAddresses(words: string, kept: readonly string[]): string {
  const usernames = new Set(kept.map((username) => username.toLowerCase()));
  return words.replace(/[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+/g, (token) =>
    usernames.has(token.toLowerCase()) ? token : '<address>',
  );
}

/** The code of a thrown error of the org, as jsforce gives it. */
function codeOf(err: unknown): string {
  const coded = err as { errorCode?: unknown; name?: unknown } | undefined;
  if (typeof coded?.errorCode === 'string' && coded.errorCode !== '') return coded.errorCode;
  if (typeof coded?.name === 'string' && /^[A-Z][A-Z_]+$/.test(coded.name)) return coded.name;
  return 'REQUEST_FAILED';
}

/** A call the org refused whole, said as the refusal of each of its rows. */
function refusedWhole(err: unknown, count: number): UsersSaveResult[] {
  const error: UsersOrgError = { code: codeOf(err), message: extractErrorMessage(err), fields: [] };
  return Array.from({ length: count }, () => ({ success: false, errors: [error] }));
}

/** One row of what the org answered, its errors' code under either name jsforce gives it. */
function savedOf(answer: unknown): UsersSaveResult {
  const row = answer as
    | {
        id?: unknown;
        success?: unknown;
        errors?: Array<{
          statusCode?: unknown;
          errorCode?: unknown;
          message?: unknown;
          fields?: unknown;
        }>;
      }
    | undefined;
  if (row === undefined || row === null) {
    return {
      success: false,
      errors: [{ code: 'NO_ANSWER', message: 'the org answered nothing for it', fields: [] }],
    };
  }
  const errors = (row.errors ?? []).map((error) => ({
    code:
      typeof error.statusCode === 'string'
        ? error.statusCode
        : typeof error.errorCode === 'string'
          ? error.errorCode
          : 'UNKNOWN_ERROR',
    message: typeof error.message === 'string' ? error.message : 'the org gave no words',
    fields: Array.isArray(error.fields) ? error.fields.filter((f) => typeof f === 'string') : [],
  }));
  const success = row.success === true;
  return {
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    success,
    errors:
      success || errors.length > 0
        ? errors
        : [{ code: 'UNKNOWN_ERROR', message: 'the org refused it', fields: [] }],
  };
}

/** Each row of `count` sent, as answered: a row the org left out is one it said nothing of. */
function answeredRows(answer: unknown, count: number): UsersSaveResult[] {
  const list: unknown[] = Array.isArray(answer) ? answer : [answer];
  return Array.from({ length: count }, (_, at) => savedOf(list[at]));
}

/** The port of a jsforce connection: see the module's comment. */
export function usersOrgOf(conn: UsersConnection): UsersOrg {
  let requests = 0;

  /** Send `rows` in collections of {@link USERS_COLLECTION_ROWS}, each answered row by row. */
  const inCollections = async <T>(
    rows: readonly T[],
    send: (part: T[]) => Promise<unknown>,
  ): Promise<UsersSaveResult[]> => {
    const answered: UsersSaveResult[] = [];
    for (const part of inChunks(rows, USERS_COLLECTION_ROWS)) {
      requests += 1;
      try {
        answered.push(...answeredRows(await send(part), part.length));
      } catch (err: unknown) {
        answered.push(...refusedWhole(err, part.length));
      }
    }
    return answered;
  };

  return {
    identity: async () => {
      requests += 1;
      const identity = await conn.identity();
      return {
        userId: identity.user_id,
        organizationId: identity.organization_id,
        username: identity.username,
      };
    },
    query: async (soql) => {
      requests += 1;
      let page = await conn.query<UsersRow>(soql);
      const rows: UsersRow[] = [...page.records];
      while (!page.done && page.nextRecordsUrl) {
        requests += 1;
        page = await conn.queryMore<UsersRow>(page.nextRecordsUrl);
        rows.push(...page.records);
      }
      return rows;
    },
    update: (object, rows) =>
      inCollections(rows, (part) =>
        conn.sobject(object).update(part, { allOrNone: false, headers: recordWriteHeaders() }),
      ),
    create: (object, rows) =>
      inCollections(rows, (part) =>
        conn.sobject(object).create(part, { allOrNone: false, headers: recordWriteHeaders() }),
      ),
    destroy: (object, ids) =>
      inCollections(ids, (part) => conn.sobject(object).destroy(part, { allOrNone: false })),
    requests: () => requests,
  };
}
