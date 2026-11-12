/**
 * The ids of every record of whole objects, read from the org a page at a
 * time and written to disk as they come: what a pass that empties objects
 * deletes, read back from the disk a page at a time (`IdSpool`).
 *
 * Nothing holds more than a page. A spool of a rewind keeps the keys of its
 * records in memory too, some 25 MB a million, for the removal to ask
 * whether a record is one of them; a table read whole asks nothing of the
 * kind, and a full sandbox's tens of millions of records would hold a
 * gigabyte of keys. The files are those of the rewind's spools, one id a
 * line, and the list of the objects is written last: a read stopped, or
 * refused, leaves no spool behind it.
 */

import { appendFile } from 'node:fs/promises';
import type { Connection } from 'jsforce';

import { assertSoqlIdentifier } from '../common/soqlValidator.js';
import {
  CHECKPOINT_FILE_MODE,
  makePrivateDir,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import { closeSpool, idsFileOf, type IdSpool } from '../../modules/checkpoint/spooledRunRecords.js';
import { FORGE_CURSOR_MAX_EMPTY_PAGES, type QueryPage } from '../../modules/forge/queryAllPages.js';

/**
 * The activities an org archives, which a query no longer answers once they
 * are: read through `queryAll`, the recycle bin left out by the statement.
 */
export const ARCHIVED_ACTIVITIES: ReadonlySet<string> = new Set(['Task', 'Event']);

/** A Salesforce id, of either length. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A row of a page, as the org answers it. */
type Row = Record<string, unknown>;

/** What reading a table's ids needs of an org: a query's first page, and the next. */
export interface TableIdSource {
  /** The first page of `soql`; with `scanAll`, read as `queryAll`. */
  query(soql: string, options?: { scanAll?: boolean }): Promise<QueryPage<Row>>;
  /** The page a cursor's `nextRecordsUrl` names. */
  queryMore(nextRecordsUrl: string): Promise<QueryPage<Row>>;
}

/** A jsforce connection, as a read of a table's ids needs it. */
export function tableIdSourceOf(conn: Connection): TableIdSource {
  return {
    query: async (soql, options) =>
      await conn.query<Row>(soql, { scanAll: options?.scanAll === true }),
    queryMore: async (nextRecordsUrl) => await conn.queryMore<Row>(nextRecordsUrl),
  };
}

/** A table whose ids are read, and the records of it the read keeps. */
export interface TableToRead {
  objectApiName: string;
  /**
   * A SOQL condition the records read must meet, as the caller builds it:
   * none, and every record of the table is read.
   */
  filter?: string;
}

/**
 * The statement that reads a table's ids: every record, or those `filter`
 * keeps. An archived task or event is read through `queryAll`, which reads
 * the recycle bin too, so the statement leaves the deleted ones out.
 */
export function tableIdsQuery(table: TableToRead): { soql: string; scanAll: boolean } {
  const object = assertSoqlIdentifier(table.objectApiName);
  const scanAll = ARCHIVED_ACTIVITIES.has(table.objectApiName);
  const conditions = [
    ...(table.filter !== undefined && table.filter.trim() !== '' ? [`(${table.filter})`] : []),
    ...(scanAll ? ['IsDeleted = false'] : []),
  ];
  return {
    soql: `SELECT Id FROM ${object}${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}`,
    scanAll,
  };
}

/** How a read of tables goes. */
export interface TableIdsOptions {
  /** Stops the read before its next page: no spool is written. */
  signal?: AbortSignal;
  /** Told, after each page, how many ids of the table have been read. */
  onPage?: (objectApiName: string, read: number) => void;
}

/** What a read of tables ended with. */
export type TableIdsRead =
  | { stopped: false; spool: IdSpool }
  | {
      stopped: true;
      /** How many ids of each table were read before the stop: no spool holds them. */
      read: Array<{ objectApiName: string; count: number }>;
    };

/**
 * Read the ids of every record of `tables`, each through its own cursor, a
 * page at a time, appended to its file in `dir` as each page comes; then
 * close the spool, its objects in the order given. A stop before a page
 * leaves no spool, and says how far each table was read.
 *
 * @throws When the org answers a row that is no record's id, or a cursor
 *   keeps answering empty pages without saying it is done: a read cut short
 *   is never a spool that passes for the table.
 */
export async function spoolTableIds(
  source: TableIdSource,
  dir: string,
  tables: readonly TableToRead[],
  options: TableIdsOptions = {},
): Promise<TableIdsRead> {
  const stopped = (): boolean => options.signal?.aborted === true;
  const read: Array<{ objectApiName: string; count: number }> = [];
  await makePrivateDir(dir);
  for (const table of tables) {
    const { soql, scanAll } = tableIdsQuery(table);
    const counted = { objectApiName: table.objectApiName, count: 0 };
    read.push(counted);
    if (stopped()) return { stopped: true, read };
    const file = idsFileOf(dir, table.objectApiName);
    let first = true;
    let empty = 0;
    let page = await source.query(soql, { scanAll });
    for (;;) {
      const ids = page.records.map((row) => {
        const id = row.Id;
        if (typeof id !== 'string' || !RECORD_ID.test(id)) {
          throw new Error(
            `The org answered a ${table.objectApiName} row with no record id: its ids are not read.`,
          );
        }
        return id;
      });
      if (ids.length > 0 || first) {
        await appendFile(file, ids.map((id) => `${id}\n`).join(''), {
          encoding: 'utf8',
          mode: CHECKPOINT_FILE_MODE,
          flag: first ? 'w' : 'a',
        });
        first = false;
      }
      counted.count += ids.length;
      options.onPage?.(table.objectApiName, counted.count);
      empty = ids.length === 0 ? empty + 1 : 0;
      if (page.done || !page.nextRecordsUrl) break;
      if (empty >= FORGE_CURSOR_MAX_EMPTY_PAGES) {
        throw new Error(
          `The org kept answering empty pages of ${table.objectApiName} without saying it was ` +
            `done: ${counted.count} id(s) read, the rest not.`,
        );
      }
      if (stopped()) return { stopped: true, read };
      page = await source.queryMore(page.nextRecordsUrl);
    }
  }
  return { stopped: false, spool: await closeSpool(dir, read) };
}
