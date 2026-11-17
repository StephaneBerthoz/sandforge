/**
 * An org in miniature for the audits' tests: tables of rows, and what the
 * REST and Tooling query endpoints answer of them.
 *
 * It answers as the org does, and refuses what the org refuses: only the
 * fields a query names, a relationship's nested as the API nests it
 * (`CronJobDetail.Name` under `CronJobDetail`), each under the table's own
 * name for it whatever case the query gave; pages of `pageSize` rows behind
 * a locator; a field the table does not have refused `INVALID_FIELD`, a table
 * the endpoint does not hold `INVALID_TYPE`. A statement it cannot read
 * throws, so a query it does not understand never passes for one that found
 * nothing.
 *
 * The deliverability probe's line of Apex is answered as an org on All email
 * answers it, or as one on System email only or No access, its user holding
 * Send Email.
 *
 * Lives beside the audits with no `.test.ts` suffix: a helper, not a suite.
 */

import {
  DELIVERABILITY_APEX,
  EMAIL_NOT_PERMITTED,
} from '../../../src/modules/forge/targetDeliverability.js';
import type { AuditTransport } from './auditOrg.js';

/** A row of a table, field by field. */
export type FakeAuditRow = Record<string, string | number | boolean | null>;

/** A table: the fields it has, in their own case, and its rows. */
export interface FakeAuditTable {
  columns: string[];
  rows: FakeAuditRow[];
}

/** What the fake org holds, and how it answers. */
export interface FakeAuditOrgInit {
  /** The tables the REST query endpoint answers. */
  data?: Record<string, FakeAuditTable>;
  /** The tables the Tooling query endpoint answers. */
  tooling?: Record<string, FakeAuditTable>;
  /** What the deliverability probe reads: open, closed, or the error the org answers. */
  deliverability?: 'open' | 'closed' | Error;
  /** Rows a page; 2,000 unless told. */
  pageSize?: number;
  /** Tables any query of which the org refuses, with the error it answers. */
  refuse?: Record<string, Error>;
}

/** An error as jsforce gives one of the API's: its code on `errorCode` and `name`. */
export function sfError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: code, errorCode: code });
}

/** A table by its name, whatever the case the query gave it. */
function tableOf(
  tables: Record<string, FakeAuditTable> | undefined,
  name: string,
): [string, FakeAuditTable] | undefined {
  const key = Object.keys(tables ?? {}).find((one) => one.toLowerCase() === name.toLowerCase());
  return key !== undefined && tables?.[key] !== undefined ? [key, tables[key]] : undefined;
}

/** A row as the API answers it: the fields named, a relationship's nested. */
function answerRow(
  table: string,
  columns: readonly string[],
  row: FakeAuditRow,
): Record<string, unknown> {
  const out: Record<string, unknown> = { attributes: { type: table } };
  for (const column of columns) {
    const value = row[column] ?? null;
    const at = column.indexOf('.');
    if (at < 0) {
      out[column] = value;
      continue;
    }
    const parent = column.slice(0, at);
    const nested = (out[parent] as Record<string, unknown> | undefined) ?? {
      attributes: { type: parent },
    };
    nested[column.slice(at + 1)] = value;
    out[parent] = nested;
  }
  return out;
}

/** The fake org's transport, and the URLs it was asked, in order. */
export function fakeAuditOrg(init: FakeAuditOrgInit): {
  transport: AuditTransport;
  requests: string[];
} {
  const requests: string[] = [];
  const pageSize = init.pageSize ?? 2_000;
  const cursors = new Map<string, Array<Record<string, unknown>>>();
  let cursorCount = 0;

  const page = (records: Array<Record<string, unknown>>): Record<string, unknown> => {
    if (records.length <= pageSize) return { totalSize: records.length, done: true, records };
    const locator = `/services/data/v62.0/query/01gFAKE${++cursorCount}-${pageSize}`;
    cursors.set(locator, records.slice(pageSize));
    return { done: false, nextRecordsUrl: locator, records: records.slice(0, pageSize) };
  };

  const query = (soql: string, tooling: boolean): Record<string, unknown> => {
    const statement = /^SELECT (.+?) FROM (\w+)(?: WHERE (\w+) IN \(([^)]*)\))?$/i.exec(soql);
    if (statement === null) throw new Error(`Not a statement the fake org reads: ${soql}`);
    const [, fieldList = '', name = '', whereField, inList] = statement;
    const refused = Object.entries(init.refuse ?? {}).find(
      ([table]) => table.toLowerCase() === name.toLowerCase(),
    );
    if (refused !== undefined) throw refused[1];
    const found = tableOf(tooling ? init.tooling : init.data, name);
    if (found === undefined) {
      throw sfError('INVALID_TYPE', `sObject type '${name}' is not supported.`);
    }
    const [table, { columns, rows }] = found;
    const columnOf = (asked: string): string => {
      const own = columns.find((one) => one.toLowerCase() === asked.trim().toLowerCase());
      if (own === undefined) {
        throw sfError('INVALID_FIELD', `No such column '${asked.trim()}' on entity '${table}'.`);
      }
      return own;
    };
    const selected = fieldList.split(',').map(columnOf);
    let chosen = rows;
    if (whereField !== undefined && inList !== undefined) {
      const field = columnOf(whereField);
      const values = inList.split(',').map((one) => one.trim().replace(/^'|'$/g, ''));
      chosen = rows.filter((row) =>
        values.some((value) => String(row[field] ?? '').startsWith(value)),
      );
    }
    return page(chosen.map((row) => answerRow(table, selected, row)));
  };

  const transport: AuditTransport = {
    request: async ({ url }) => {
      requests.push(url);
      // The probe's one request: its line of Apex, whole, in the URL.
      if (url.endsWith(`=${encodeURIComponent(DELIVERABILITY_APEX)}`)) {
        if (init.deliverability instanceof Error) throw init.deliverability;
        return init.deliverability === 'open'
          ? { compiled: true, success: true }
          : { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };
      }
      if (
        url ===
        `/query?q=${encodeURIComponent('SELECT PermissionsEmailSingle FROM UserPermissionAccess')}`
      ) {
        return { done: true, records: [{ PermissionsEmailSingle: true }] };
      }
      const rest = cursors.get(url);
      if (rest !== undefined) {
        cursors.delete(url);
        return page(rest);
      }
      const asked = /^\/(tooling\/)?query\?q=(.*)$/.exec(url);
      if (asked === null) throw new Error(`Not a request the fake org answers: ${url}`);
      return query(decodeURIComponent(asked[2] ?? ''), asked[1] !== undefined);
    },
  };
  return { transport, requests };
}
