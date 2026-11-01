/**
 * A target org in miniature, shaped as the jsforce connection the panel's
 * hosts get (`getJsforceConnection`), for the tests of a removal's sweep told
 * what ties a record to the run: records with their lookups, each object's
 * fields and child relationships by describe, and what the org does as a
 * record goes — it takes along what hangs from it in cascade, clears a lookup
 * that only names it, and refuses its delete while a restricting lookup names
 * it (`Case.AssetId`, `DELETE_FAILED`, as P2-3 saw). Deleted records go to a
 * recycle bin a query reads with `scanAll`.
 *
 * It answers the statements a removal and a sweep send: `SELECT <fields> |
 * COUNT() FROM <object>`, a WHERE of `IN (…)`, `=`, `!=`, `>=`, `<=` and `>`
 * terms under AND, then `ORDER BY Id` and `LIMIT`; an id compares by its
 * first fifteen characters, a polymorphic lookup's too. A column the object
 * does not have is refused as the org refuses it (`INVALID_FIELD`, "No such
 * column"): a read that asks for one the real object lacks fails here as it
 * failed on a real org (a feed item keeps no `LastModifiedById`). Its counts
 * also go five to a `/composite` (`compositeOver`).
 *
 * Every read and every write is noted in order (`events`), as a write path's
 * order test counts them.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { compositeOver } from './compositeOver.js';

/** A record of the fake org. */
export type TiedRow = Record<string, unknown> & { Id: string };

/** A child relationship, as a describe lists it. */
export interface TiedChild {
  childSObject: string;
  field: string;
  cascadeDelete?: boolean;
  restrictedDelete?: boolean;
}

/** What an object is: its lookups, by field, to the objects each names; and its children. */
export interface TiedShape {
  references?: Record<string, readonly string[]>;
  children?: readonly TiedChild[];
  /** Columns it keeps beside its lookups; {@link TIED_DEFAULT_FIELDS} unless told. */
  fields?: readonly string[];
}

/** The columns an object keeps unless told otherwise. */
export const TIED_DEFAULT_FIELDS: readonly string[] = [
  'Id',
  'Name',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
];

/** A 15- or 18-character id, as the org compares two: by its first fifteen characters. */
const ID_LIKE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

function sameValue(held: unknown, asked: string): boolean {
  if (typeof held === 'string' && ID_LIKE.test(held) && ID_LIKE.test(asked)) {
    return held.slice(0, 15) === asked.slice(0, 15);
  }
  if (asked === 'true' || asked === 'false') return held === (asked === 'true');
  return held === asked;
}

/** A step of what the org was asked, as an order test counts it. */
export type TiedEvent = 'reads' | 'write';

/** What a test reads of the org, and changes in it. */
export interface TiedOrgState {
  rows: Map<string, TiedRow[]>;
  bin: Map<string, TiedRow[]>;
  deletes: Array<{ object: string; ids: string[] }>;
  queries: string[];
  events: TiedEvent[];
  /** What a delete does to other records beside what the shapes say: a roll-up restamping its parent. */
  hooks: { onDestroy?: (object: string, row: TiedRow) => void };
  /** The subrequests of each composite sent. */
  composites: number[];
  add(object: string, ...rows: TiedRow[]): void;
  shape(object: string, shape: TiedShape): void;
  ids(object: string): string[];
  row(object: string, recordId: string): TiedRow | undefined;
}

/** The org, its connection as a host gets it, and what a test reads of it. */
export type TiedTargetOrg = TiedOrgState & { conn: ReturnType<typeof connOf> };

function connOf(org: TiedOrgState, shapes: Map<string, TiedShape>, user: string) {
  const fieldsOf = (object: string): string[] => {
    const shape = shapes.get(object) ?? {};
    return [...(shape.fields ?? TIED_DEFAULT_FIELDS), ...Object.keys(shape.references ?? {})];
  };
  const answer = (soql: string, scanAll: boolean) => {
    const parts = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?( ORDER BY Id)?(?: LIMIT (\d+))?$/.exec(
      soql,
    );
    if (!parts) throw new Error(`MALFORMED_QUERY: ${soql}`);
    const [, columns, object, where, ordered, limit] = parts;
    if (!org.rows.has(object)) {
      throw Object.assign(new Error(`INVALID_TYPE: sObject type '${object}' is not supported.`), {
        errorCode: 'INVALID_TYPE',
      });
    }
    const known = new Set([...fieldsOf(object), 'IsDeleted']);
    const names = columns === 'COUNT()' ? [] : columns.split(', ');
    for (const name of names) {
      if (!known.has(name)) {
        throw Object.assign(
          new Error(`INVALID_FIELD: No such column '${name}' on entity '${object}'.`),
          { errorCode: 'INVALID_FIELD' },
        );
      }
    }
    let kept: TiedRow[] = [
      ...(org.rows.get(object) ?? []),
      ...(scanAll ? (org.bin.get(object) ?? []).map((row) => ({ ...row, IsDeleted: true })) : []),
    ];
    for (const term of where ? where.split(' AND ') : []) {
      const inList = /^(\w+) IN \((.*)\)$/.exec(term);
      if (inList) {
        const values = inList[2].split(', ').map((quoted) => quoted.slice(1, -1));
        kept = kept.filter((row) => values.some((value) => sameValue(row[inList[1]], value)));
        continue;
      }
      const compared = /^(\w+) (=|!=|>=|<=|>) (.+)$/.exec(term);
      if (!compared) throw new Error(`MALFORMED_QUERY: ${term}`);
      const [, field, op, raw] = compared;
      if (!known.has(field)) {
        throw Object.assign(
          new Error(`INVALID_FIELD: No such column '${field}' on entity '${object}'.`),
          { errorCode: 'INVALID_FIELD' },
        );
      }
      const quoted = raw.startsWith("'") ? raw.slice(1, -1) : undefined;
      kept = kept.filter((row) => {
        const held = row[field];
        if (op === '!=' && raw === 'null') return held !== null && held !== undefined;
        if (op === '=')
          return sameValue(held ?? (field === 'IsDeleted' ? false : held), quoted ?? raw);
        if (op === '>') return String(held) > (quoted ?? raw);
        const time = Date.parse(String(held));
        return op === '>=' ? time >= Date.parse(raw) : time <= Date.parse(raw);
      });
    }
    if (ordered) kept.sort((a, b) => a.Id.localeCompare(b.Id));
    if (limit) kept = kept.slice(0, Number(limit));
    if (columns === 'COUNT()') return { totalSize: kept.length, done: true, records: [] };
    return {
      totalSize: kept.length,
      done: true,
      records: kept.map((row) =>
        Object.fromEntries(names.map((name) => [name, row[name] ?? null])),
      ),
    };
  };
  const naming = (child: string, field: string, recordId: string): TiedRow[] =>
    (org.rows.get(child) ?? []).filter((row) => sameValue(row[field], recordId));
  const remove = (object: string, row: TiedRow): void => {
    org.rows.set(
      object,
      (org.rows.get(object) ?? []).filter((r) => r.Id !== row.Id),
    );
    org.bin.set(object, [...(org.bin.get(object) ?? []), row]);
    org.hooks.onDestroy?.(object, row);
    for (const relation of shapes.get(object)?.children ?? []) {
      for (const child of naming(relation.childSObject, relation.field, row.Id)) {
        if (relation.cascadeDelete) remove(relation.childSObject, child);
        else if (!relation.restrictedDelete) child[relation.field] = null;
      }
    }
  };
  const query = async (soql: string, options?: { scanAll?: boolean }) => {
    org.events.push('reads');
    org.queries.push(soql);
    return answer(soql, options?.scanAll === true);
  };
  const composite = compositeOver(query);
  return {
    limitInfo: undefined,
    version: composite.version,
    request: async (request: { method?: string; url: string; body?: string }) => {
      const before = composite.calls.length;
      const answered = await composite.request(request);
      org.composites.push(...composite.calls.slice(before));
      return answered;
    },
    query,
    describe: async (object: string) => {
      org.events.push('reads');
      if (!org.rows.has(object)) {
        throw new Error(`INVALID_TYPE: sObject type '${object}' is not supported.`);
      }
      const shape = shapes.get(object) ?? {};
      return {
        name: object,
        label: object,
        queryable: true,
        deletable: true,
        createable: true,
        updateable: true,
        fields: [
          ...(shape.fields ?? TIED_DEFAULT_FIELDS).map((name) => ({
            name,
            label: name,
            type: name.endsWith('ById') ? 'reference' : name === 'Id' ? 'id' : 'string',
            ...(name.endsWith('ById') ? { referenceTo: ['User'] } : {}),
            ...(name === 'Name' ? { nameField: true } : {}),
          })),
          ...Object.entries(shape.references ?? {}).map(([name, referenceTo]) => ({
            name,
            label: name,
            type: 'reference',
            referenceTo: [...referenceTo],
          })),
        ],
        childRelationships: [...(shape.children ?? [])],
      };
    },
    describeGlobal: async () => {
      org.events.push('reads');
      return {
        sobjects: [...org.rows.keys()].map((name) => ({
          name,
          label: name,
          queryable: true,
          deletable: true,
          createable: true,
          layoutable: true,
        })),
      };
    },
    identity: async () => ({ user_id: user }),
    soap: {
      getServerTimestamp: async () => ({ timestamp: new Date().toISOString() }),
      getUserInfo: async () => ({ userId: user }),
    },
    sobject: (object: string) => ({
      destroy: async (ids: string[]) => {
        org.events.push('write');
        org.deletes.push({ object, ids: [...ids] });
        return ids.map((recordId) => {
          const row = (org.rows.get(object) ?? []).find((r) => r.Id === recordId);
          if (!row) {
            return {
              id: recordId,
              success: false,
              errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
            };
          }
          const holders = (shapes.get(object)?.children ?? [])
            .filter((relation) => relation.restrictedDelete)
            .flatMap((relation) => naming(relation.childSObject, relation.field, recordId));
          if (holders.length > 0) {
            return {
              id: recordId,
              success: false,
              errors: [
                {
                  statusCode: 'DELETE_FAILED',
                  message: `Your attempt to delete ${String(row.Name)} could not be completed because it is associated with the following cases.: ${holders.length}`,
                },
              ],
            };
          }
          remove(object, row);
          return { id: recordId, success: true, errors: [] };
        });
      },
      update: async (records: Array<Record<string, unknown>>) => {
        org.events.push('write');
        return records.map((record) => {
          const row = (org.rows.get(object) ?? []).find((r) => r.Id === record.Id);
          if (row) {
            Object.assign(row, record, {
              LastModifiedDate: new Date().toISOString(),
              LastModifiedById: user,
            });
          }
          return { id: record.Id, success: row !== undefined, errors: [] };
        });
      },
    }),
  };
}

/** What {@link addSyncedQuote} put in the org: the run's records, per object, and the copy. */
export interface SyncedQuote {
  created: Array<{ objectApiName: string; ids: string[] }>;
  /** The quote line the platform copied from the run's line item. */
  copy: string;
}

/**
 * What a run left under a quote it synced with its opportunity: an opportunity
 * and a quote with a line each, and the quote line the platform copied from
 * the run's line item as it went in, created as the run's user.
 */
export function addSyncedQuote(org: TiedOrgState, user: string, at: string): SyncedQuote {
  const row = (Id: string, lookups: Record<string, string>): TiedRow => ({
    Id,
    Name: Id,
    CreatedById: user,
    CreatedDate: at,
    LastModifiedDate: at,
    LastModifiedById: user,
    SystemModstamp: at,
    ...lookups,
  });
  const opportunity = '006000000000001AAA';
  const quote = '0Q0000000000001AAA';
  const lineItem = '00k000000000001AAA';
  const runLine = '0QL000000000001AAA';
  const copy = '0QL000000000002AAA';
  org.shape('Opportunity', {
    references: { SyncedQuoteId: ['Quote'] },
    children: [
      { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
      { childSObject: 'Quote', field: 'OpportunityId', cascadeDelete: true },
    ],
  });
  org.shape('Quote', {
    references: { OpportunityId: ['Opportunity'] },
    children: [{ childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true }],
  });
  org.shape('OpportunityLineItem', { references: { OpportunityId: ['Opportunity'] } });
  org.shape('QuoteLineItem', {
    references: { QuoteId: ['Quote'], OpportunityLineItemId: ['OpportunityLineItem'] },
  });
  org.add('Opportunity', row(opportunity, { SyncedQuoteId: quote }));
  org.add('Quote', row(quote, { OpportunityId: opportunity }));
  org.add('OpportunityLineItem', row(lineItem, { OpportunityId: opportunity }));
  const line = { QuoteId: quote, OpportunityLineItemId: lineItem };
  org.add('QuoteLineItem', row(runLine, line), row(copy, line));
  return {
    created: [
      { objectApiName: 'Opportunity', ids: [opportunity] },
      { objectApiName: 'Quote', ids: [quote] },
      { objectApiName: 'OpportunityLineItem', ids: [lineItem] },
      { objectApiName: 'QuoteLineItem', ids: [runLine] },
    ],
    copy,
  };
}

/**
 * An empty fake org whose session writes as `user`.
 */
export function tiedTargetOrg(user: string): TiedTargetOrg {
  const shapes = new Map<string, TiedShape>();
  const org: TiedOrgState = {
    rows: new Map(),
    bin: new Map(),
    deletes: [],
    queries: [],
    events: [],
    hooks: {},
    composites: [],
    add(object, ...rows) {
      org.rows.set(object, [...(org.rows.get(object) ?? []), ...rows]);
    },
    shape(object, shape) {
      shapes.set(object, { ...shapes.get(object), ...shape });
      if (!org.rows.has(object)) org.rows.set(object, []);
    },
    ids(object) {
      return (org.rows.get(object) ?? []).map((row) => row.Id);
    },
    row(object, recordId) {
      return (org.rows.get(object) ?? []).find((row) => row.Id === recordId);
    },
  };
  return { ...org, conn: connOf(org, shapes, user) };
}
