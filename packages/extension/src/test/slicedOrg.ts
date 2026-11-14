/**
 * An org of one object's rows, read and written the way Salesforce answers a
 * masking run in slices: what a slice reads and how the org pages it, what it
 * refuses, and what it says of its limits and its clock.
 *
 * - A statement keeps the rows its WHERE does: the run's filter of the shape
 *   `(Field LIKE 'prefix%')`, `Id > '…'`, `Id <= '…'`, `Id IN (…)`,
 *   `CreatedDate >= <datetime>`, `IsDeleted = true|false`; `ORDER BY Id`
 *   orders them as the org does, by the characters of the Id; `LIMIT n`
 *   keeps the first n. `totalSize` is what the statement selects, its LIMIT
 *   included (`min(LIMIT, rows)`).
 * - A page holds `batchSize` rows when `Sforce-Query-Options` asks it, 2,000
 *   otherwise, and points at the next by `nextRecordsUrl`, read with
 *   `queryMore`.
 * - A field the describe does not list is refused, `INVALID_FIELD`, as the
 *   org refuses it; a statement over more rows than `timeoutAbove` runs out
 *   of time, `QUERY_TIMEOUT`, and so does a count when `countTimesOut`.
 * - An update of a row deleted since is refused `ENTITY_IS_DELETED`; an
 *   update of a row in `refuse` is refused with its words.
 * - `/limits` answers its daily API requests, `/limits/recordCount` its own
 *   figure of the rows, `getServerTimestamp` its clock.
 *
 * Every call is kept in `journal`, in order, with the ids each write sent.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

/** A row of the org. */
export type SlicedRow = Record<string, unknown> & { Id: string; CreatedDate?: string };

/** One call the org answered, in order. */
export interface SlicedCall {
  kind: 'query' | 'queryMore' | 'update' | 'upsert' | 'undelete' | 'timestamp' | 'request';
  soql?: string;
  ids?: string[];
}

/** How the org behaves. */
export interface SlicedOrgOptions {
  /** The object the rows are of. */
  objectApiName?: string;
  /** The fields its describe lists; every field of the first row's when absent. */
  fields?: readonly string[];
  /** A statement over more rows than this runs out of time. */
  timeoutAbove?: number;
  /** Whether a count runs out of time. */
  countTimesOut?: boolean;
  /** The org's clock, in milliseconds since the epoch. */
  now?: () => number;
  /** What `/limits` says of the daily API requests. */
  limits?: { Max: number; Remaining: number };
  /** Called with each statement before the org answers it: what a test writes from, between two reads. */
  beforeQuery?: (soql: string) => void;
  /** Called after each update answered, with the ids it sent. */
  afterUpdate?: (ids: readonly string[]) => void;
}

/** An error as jsforce throws the org's refusal: its code, and its words. */
function refusal(code: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(`${code}: ${message}`), { errorCode: code });
}

/** The fields a SELECT names. */
function selectedFields(soql: string): string[] {
  return (/^SELECT (.+?) FROM /.exec(soql)?.[1] ?? '').split(',').map((f) => f.trim());
}

/** Whether a row meets every condition of a statement's WHERE. */
function meets(row: SlicedRow, soql: string): boolean {
  const where = /\bWHERE (.+?)(?: ORDER BY | LIMIT |$)/.exec(soql)?.[1] ?? '';
  const id = row.Id;
  const like = /\((\w+) LIKE '([^']*)%'\)/.exec(where);
  if (like && !String(row[like[1]] ?? '').startsWith(like[2])) return false;
  const after = /\bId > '(\w+)'/.exec(where)?.[1];
  if (after !== undefined && !(id > after)) return false;
  const until = /\bId <= '(\w+)'/.exec(where)?.[1];
  if (until !== undefined && !(id <= until)) return false;
  const inList = /\bId IN \(([^)]*)\)/.exec(where)?.[1];
  if (inList !== undefined) {
    const ids = inList.split(',').map((v) => v.trim().replace(/'/g, ''));
    if (!ids.includes(id)) return false;
  }
  const since = /\bCreatedDate >= (\S+Z)/.exec(where)?.[1];
  if (since !== undefined && !(Date.parse(String(row.CreatedDate ?? '')) >= Date.parse(since))) {
    return false;
  }
  return true;
}

/** The org: see the module's comment. */
export class SlicedOrg {
  /** The live rows, as the org holds them now. */
  readonly rows: SlicedRow[];
  /** The rows in the recycle bin. */
  readonly bin: SlicedRow[] = [];
  /** Every call, in order. */
  readonly journal: SlicedCall[] = [];
  /** Rows whose update the org refuses, with its words. */
  readonly refuse = new Map<string, string>();
  /** What jsforce keeps of the org's last answer of its API usage. */
  limitInfo: { apiUsage?: { used: number; limit: number } } | undefined;
  readonly version = '62.0';

  private readonly objectApiName: string;
  private readonly fields: readonly string[];
  private readonly pages = new Map<string, { rows: SlicedRow[]; size: number; total: number }>();
  private cursors = 0;

  constructor(
    rows: readonly SlicedRow[],
    private readonly options: SlicedOrgOptions = {},
  ) {
    this.rows = rows.map((row) => ({ ...row }));
    this.objectApiName = options.objectApiName ?? 'Contact';
    this.fields = options.fields ?? Object.keys(rows[0] ?? { Id: '' });
  }

  /** The org's clock now. */
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Add a row, created now on the org's clock, as another session of the org would. */
  insert(row: SlicedRow): void {
    this.rows.push({ ...row, CreatedDate: row.CreatedDate ?? new Date(this.now()).toISOString() });
  }

  /** Delete a row to the recycle bin. */
  delete(id: string): void {
    const at = this.rows.findIndex((row) => row.Id === id);
    if (at >= 0) this.bin.push(...this.rows.splice(at, 1));
  }

  /** A row as the org holds it now. */
  row(id: string): SlicedRow | undefined {
    return this.rows.find((row) => row.Id === id);
  }

  /** The connection a handler reads and writes through, its `limitInfo` read live as jsforce's is. */
  get connection(): Record<string, unknown> {
    const connection: Record<string, unknown> = {
      query: (soql: string, options?: { headers?: Record<string, string>; scanAll?: boolean }) =>
        this.query(soql, options),
      queryMore: (url: string) => this.queryMore(url),
      describe: async () => ({
        name: this.objectApiName,
        label: this.objectApiName,
        createable: true,
        updateable: true,
        deletable: true,
        queryable: true,
        fields: this.fields.map((name) => ({
          name,
          label: name,
          type: name === 'Id' ? 'id' : name === 'CreatedDate' ? 'datetime' : 'string',
          createable: name !== 'Id' && name !== 'CreatedDate',
          updateable: name !== 'Id' && name !== 'CreatedDate',
          permissionable: name !== 'Id' && name !== 'CreatedDate',
        })),
        recordTypeInfos: [],
        childRelationships: [],
      }),
      sobject: () => ({
        update: async (batch: Array<Record<string, unknown>>) => this.write('update', batch),
        upsert: async (batch: Array<Record<string, unknown>>) => this.write('upsert', batch),
      }),
      soap: {
        getServerTimestamp: async () => {
          this.journal.push({ kind: 'timestamp' });
          return { timestamp: new Date(this.now()).toISOString() };
        },
        undelete: async (ids: string[]) => {
          this.journal.push({ kind: 'undelete', ids: [...ids] });
          return ids.map((id) => {
            const at = this.bin.findIndex((row) => row.Id === id);
            if (at < 0) return { success: false, id };
            this.rows.push(...this.bin.splice(at, 1));
            return { success: true, id };
          });
        },
      },
      request: async (request: string | { url: string }) => {
        const url = typeof request === 'string' ? request : request.url;
        this.journal.push({ kind: 'request', soql: url });
        if (url.includes('/limits/recordCount')) {
          return { sObjects: [{ name: this.objectApiName, count: this.rows.length }] };
        }
        if (url.endsWith('/limits')) {
          return {
            DailyApiRequests: this.options.limits ?? { Max: 5_000_000, Remaining: 4_900_000 },
          };
        }
        throw refusal('NOT_FOUND', `The requested resource does not exist: ${url}`);
      },
      version: this.version,
    };
    Object.defineProperty(connection, 'limitInfo', { get: () => this.limitInfo });
    return connection;
  }

  private async query(
    soql: string,
    options?: { headers?: Record<string, string>; scanAll?: boolean },
  ): Promise<Record<string, unknown>> {
    this.journal.push({ kind: 'query', soql });
    this.options.beforeQuery?.(soql);
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    // What a duplicate rule wrote: nothing, in an org whose rules matched nothing.
    if (/ FROM DuplicateRecord(?:Item|Set) /.test(soql)) {
      return { records: [], done: true, totalSize: 0 };
    }
    const deletedOnly = /\bIsDeleted = true\b/.test(soql);
    const pool = deletedOnly ? (options?.scanAll ? this.bin : []) : this.rows;
    const kept = pool.filter((row) => meets(row, soql));
    if (soql.startsWith('SELECT COUNT() ')) {
      if (this.options.countTimesOut) {
        throw refusal('QUERY_TIMEOUT', 'Your query request was running for too long.');
      }
      return { records: [], done: true, totalSize: kept.length };
    }
    const fields = selectedFields(soql);
    const unknown = fields.find((f) => !this.fields.includes(f));
    if (unknown !== undefined) {
      throw refusal(
        'INVALID_FIELD',
        `No such column '${unknown}' on entity '${this.objectApiName}'.`,
      );
    }
    if (/ ORDER BY Id\b/.test(soql)) kept.sort((a, b) => (a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0));
    const limit = /\bLIMIT (\d+)/.exec(soql);
    const selected = limit ? kept.slice(0, Number(limit[1])) : kept;
    const above = this.options.timeoutAbove;
    if (above !== undefined && (limit ? Number(limit[1]) : kept.length) > above) {
      throw refusal('QUERY_TIMEOUT', 'Your query request was running for too long.');
    }
    const batch = /batchSize=(\d+)/.exec(options?.headers?.['Sforce-Query-Options'] ?? '');
    const size = batch ? Number(batch[1]) : 2_000;
    const rows = selected.map((row) =>
      Object.fromEntries([
        ['attributes', { type: this.objectApiName }],
        ...fields.map((f) => [f, row[f] ?? null]),
      ]),
    ) as SlicedRow[];
    return this.page(rows, size, selected.length, 0);
  }

  /** The page of a cursor's rows from `from`, pointing at the next when more follow. */
  private page(
    rows: SlicedRow[],
    size: number,
    total: number,
    from: number,
  ): Record<string, unknown> {
    const records = rows.slice(from, from + size);
    const done = from + size >= rows.length;
    const answer: Record<string, unknown> = { records, done, totalSize: total };
    if (!done) {
      const url = `/services/data/v62.0/query/cursor-${++this.cursors}-${from + size}`;
      this.pages.set(url, { rows, size, total });
      answer.nextRecordsUrl = url;
    }
    return answer;
  }

  private async queryMore(url: string): Promise<Record<string, unknown>> {
    this.journal.push({ kind: 'queryMore', soql: url });
    const cursor = this.pages.get(url);
    if (!cursor) throw refusal('INVALID_QUERY_LOCATOR', 'invalid query locator');
    const from = Number(/-(\d+)$/.exec(url)?.[1] ?? 0);
    return this.page(cursor.rows, cursor.size, cursor.total, from);
  }

  private write(
    kind: 'update' | 'upsert',
    batch: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const ids = batch.map((sent) => String(sent.Id));
    this.journal.push({ kind, ids });
    const results = batch.map((sent) => {
      const id = String(sent.Id);
      const refused = this.refuse.get(id);
      if (refused !== undefined) {
        return {
          success: false,
          errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: refused }],
        };
      }
      const row = this.rows.find((r) => r.Id === id);
      if (!row) {
        return {
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }],
        };
      }
      Object.assign(row, sent);
      return { success: true, id };
    });
    this.options.afterUpdate?.(ids);
    return results;
  }
}
