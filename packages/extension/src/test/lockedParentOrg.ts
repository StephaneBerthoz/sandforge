/**
 * A target where another transaction holds one record — a parent account that
 * many rows hang from — for the first calls it is sent, as a job, an
 * integration or the target's own automation holds one past the ten seconds
 * the platform waits for a lock:
 *
 * - a REST call, each row on its own (`allOrNone` false), refuses each row
 *   naming the record with `UNABLE_TO_LOCK_ROW`, "unable to obtain exclusive
 *   access to this record or 1 records: <id>", and saves the others;
 * - a Bulk API 2.0 job does the same in its failed results,
 *   `UNABLE_TO_LOCK_ROW:<message>:--`, its rows echoing the cells they were
 *   uploaded with, apart from the saved ones;
 * - `trigger` words the refusal as a trigger's whose update of the record met
 *   the lock: `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`, the lock in its message.
 *
 * A refused row is not written; once the record is let go, the same row is.
 * Every call is kept, and every record written with the row it came from, so
 * that a row written twice shows. Ids are made in order, unique to the org.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

/** A row the org was sent, as its cells. */
export type SentRow = Record<string, unknown>;

/** A row the org answered over REST, as jsforce hands it on. */
export interface RestAnswer {
  success: boolean;
  id?: string;
  created?: boolean;
  errors: Array<{ statusCode: string; message: string; fields: string[] }>;
}

/** The answer of a Bulk API job, as jsforce's `getAllResults` gives it. */
export interface JobResults {
  successfulResults: Array<Record<string, string>>;
  failedResults: Array<Record<string, string>>;
  unprocessedRecords: Array<Record<string, string>>;
}

/** What {@link lockedParentOrg} answers to. */
export interface LockedParentOrg {
  /** The connection a writer is given: `sobject(name)`, `bulk2`, and the query a seed reads its duplicate rules with. */
  connection: {
    sobject: (objectApiName: string) => {
      create: (
        rows: SentRow[],
        options?: { headers?: Record<string, string> },
      ) => Promise<RestAnswer[]>;
      upsert: (
        rows: SentRow[],
        externalIdField: string,
        options?: { headers?: Record<string, string> },
      ) => Promise<RestAnswer[]>;
      update: (
        rows: SentRow[],
        options?: { headers?: Record<string, string> },
      ) => Promise<RestAnswer[]>;
      destroy: (ids: string[]) => Promise<RestAnswer[]>;
    };
    bulk2: { createJob: (options: { operation: string; object: string }) => unknown };
    query: (soql: string) => Promise<{ records: Array<Record<string, unknown>> }>;
  };
  /** The REST calls, in order: their object and rows. */
  rest: Array<{ object: string; rows: SentRow[] }>;
  /** The Bulk API jobs, in order: their object and the rows uploaded. */
  jobs: Array<{ object: string; rows: SentRow[] }>;
  /** Every record the org wrote, in order, with the row it was written from. */
  written: Array<{ object: string; id: string; row: SentRow }>;
  /** The calls made while the record was held, refused rows or not. */
  callsUnderTheLock: () => number;
}

/** The message the platform refuses a row with when it could not lock `id`. */
export function lockMessage(id: string): string {
  return `unable to obtain exclusive access to this record or 1 records: ${id}`;
}

/** The message of a trigger whose update of `id` met the lock. */
export function triggerLockMessage(id: string): string {
  return (
    'ParentRollup: execution of AfterInsert caused by: System.DmlException: Update failed. ' +
    `First exception on row 0 with id ${id}; first error: UNABLE_TO_LOCK_ROW, unable to ` +
    'obtain exclusive access to this record: []'
  );
}

/** The rows of a Bulk API CSV upload, by its header's columns: quoted fields with no comma or quote in them. */
function rowsOfCsv(csv: string): Array<Record<string, string>> {
  const [header = '', ...lines] = csv.trim().split('\n');
  const columns = header.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
  return lines.map((line) => {
    const cells = line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
    return Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']));
  });
}

/**
 * The org.
 *
 * @param options.parent - The record held: a row naming it in any field is refused while it is.
 * @param options.heldFor - Calls — REST or job — the record is held for, from the first; `Infinity` never lets it go.
 * @param options.trigger - Whether the refusal comes as a trigger's that met the lock.
 */
export function lockedParentOrg(options: {
  parent: string;
  heldFor: number;
  trigger?: boolean;
}): LockedParentOrg {
  const rest: LockedParentOrg['rest'] = [];
  const jobs: LockedParentOrg['jobs'] = [];
  const written: LockedParentOrg['written'] = [];
  let calls = 0;
  let made = 0;
  const newId = (object: string): string =>
    `${object === 'Account' ? '001' : object === 'Contact' ? '003' : 'a00'}${String(++made).padStart(12, '0')}AAA`;
  const refusal = options.trigger
    ? {
        statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
        message: triggerLockMessage(options.parent),
      }
    : { statusCode: 'UNABLE_TO_LOCK_ROW', message: lockMessage(options.parent) };
  /** Whether this call comes while the record is held. */
  const held = (): boolean => ++calls <= options.heldFor;
  const names = (row: SentRow): boolean => Object.values(row).includes(options.parent);
  const save = (object: string, row: SentRow): string => {
    const id = typeof row['Id'] === 'string' && row['Id'] !== '' ? row['Id'] : newId(object);
    written.push({ object, id, row });
    return id;
  };
  const restCall =
    (object: string) =>
    async (rows: SentRow[]): Promise<RestAnswer[]> => {
      rest.push({ object, rows });
      const locked = held();
      return rows.map((row) =>
        locked && names(row)
          ? { success: false, errors: [{ ...refusal, fields: [] }] }
          : { success: true, id: save(object, row), created: true, errors: [] },
      );
    };
  return {
    rest,
    jobs,
    written,
    callsUnderTheLock: () => Math.min(calls, options.heldFor),
    connection: {
      sobject: (object) => ({
        create: (rows) => restCall(object)(rows),
        upsert: (rows) => restCall(object)(rows),
        update: (rows) => restCall(object)(rows),
        destroy: (ids) => restCall(object)(ids.map((Id) => ({ Id }))),
      }),
      query: async () => ({ records: [] }),
      bulk2: {
        createJob: ({ object }) => {
          const job = { object, rows: [] as SentRow[] };
          jobs.push(job);
          const id = `750${String(jobs.length).padStart(12, '0')}AAA`;
          let uploaded: Array<Record<string, string>> = [];
          let results: JobResults | undefined;
          return {
            id,
            open: async () => {},
            uploadData: async (csv: string) => {
              uploaded = rowsOfCsv(csv);
              job.rows = uploaded;
            },
            close: async () => {
              const locked = held();
              const answer: JobResults = {
                successfulResults: [],
                failedResults: [],
                unprocessedRecords: [],
              };
              for (const cells of uploaded) {
                if (locked && names(cells)) {
                  answer.failedResults.push({
                    sf__Id: '',
                    sf__Error: `${refusal.statusCode}:${refusal.message}:--`,
                    ...cells,
                  });
                } else {
                  answer.successfulResults.push({
                    sf__Id: save(object, cells),
                    sf__Created: 'true',
                    ...cells,
                  });
                }
              }
              results = answer;
            },
            abort: async () => {},
            check: async () => ({
              id,
              state: 'JobComplete',
              numberRecordsProcessed: uploaded.length,
            }),
            getAllResults: async () => results,
          };
        },
      },
    },
  };
}
