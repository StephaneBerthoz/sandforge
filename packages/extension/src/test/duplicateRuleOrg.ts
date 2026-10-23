/**
 * A target whose duplicate rule matches every row named "Twin …" (its
 * `Name`, or a contact's or a lead's `LastName`), as a Developer Edition's
 * standard rules matched the twins of its records:
 *
 * - a Bulk API 2.0 job, which carries no header, has each such row refused,
 *   `DUPLICATES_DETECTED:<the rule's message>:--`, and saves the others;
 * - a REST call saves it when it carries `Sforce-Duplicate-Rule-Header:
 *   allowSave=true` and the rule only alerts; a rule that blocks refuses it
 *   all the same, and so does any call without the header.
 *
 * Every call is kept: the jobs with the rows each was sent, the REST calls
 * with theirs and their headers. Ids are made in order, unique to the org.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

/** A row the org was sent, as its cells. */
export type SentRow = Record<string, unknown>;

/** What {@link duplicateRuleOrg} answers to. */
export interface DuplicateRuleOrg {
  /** The connection a writer is given: `sobject(name)` and `bulk2`. */
  connection: {
    sobject: (objectApiName: string) => {
      create: (
        rows: SentRow[],
        options?: { headers?: Record<string, string> },
      ) => Promise<unknown[]>;
      upsert: (
        rows: SentRow[],
        externalIdField: string,
        options?: { headers?: Record<string, string> },
      ) => Promise<unknown[]>;
      update: (
        rows: SentRow[],
        options?: { headers?: Record<string, string> },
      ) => Promise<unknown[]>;
    };
    bulk2: { createJob: (options: { operation: string; object: string }) => unknown };
  };
  /** The Bulk API jobs, in order: their object and the rows uploaded. */
  jobs: Array<{ object: string; rows: SentRow[] }>;
  /** The REST calls, in order: their object, rows and headers. */
  rest: Array<{ object: string; rows: SentRow[]; headers: Record<string, string> | undefined }>;
}

/** The rule's message, as the org words it. */
export const DUPLICATE_RULE_MESSAGE = 'Another record already has this name.';

/** Whether a row is one the rule matches. */
function isTwin(row: SentRow): boolean {
  const name = row['Name'] ?? row['LastName'];
  return typeof name === 'string' && name.startsWith('Twin');
}

/** The rows of a Bulk API CSV upload, by its header's columns: quoted fields with no comma or quote in them. */
function rowsOfCsv(csv: string): SentRow[] {
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
 * @param options.blocks - Whether the rule blocks, refusing a twin over REST whatever the header.
 */
export function duplicateRuleOrg(options: { blocks?: boolean } = {}): DuplicateRuleOrg {
  const jobs: DuplicateRuleOrg['jobs'] = [];
  const rest: DuplicateRuleOrg['rest'] = [];
  let made = 0;
  const newId = (): string => `001${String(++made).padStart(12, '0')}AAA`;
  const refusal = {
    success: false,
    errors: [{ statusCode: 'DUPLICATES_DETECTED', message: DUPLICATE_RULE_MESSAGE, fields: [] }],
  };
  const saved = (headers: Record<string, string> | undefined) => (row: SentRow) =>
    isTwin(row) &&
    (options.blocks === true || headers?.['Sforce-Duplicate-Rule-Header'] !== 'allowSave=true')
      ? refusal
      : { success: true, id: typeof row['Id'] === 'string' ? row['Id'] : newId(), created: true };
  const restCall =
    (object: string) =>
    async (rows: SentRow[], headers: Record<string, string> | undefined): Promise<unknown[]> => {
      rest.push({ object, rows, headers });
      return rows.map(saved(headers));
    };
  return {
    jobs,
    rest,
    connection: {
      sobject: (object) => ({
        create: (rows, call) => restCall(object)(rows, call?.headers),
        upsert: (rows, _key, call) => restCall(object)(rows, call?.headers),
        update: (rows, call) => restCall(object)(rows, call?.headers),
      }),
      bulk2: {
        createJob: ({ object }) => {
          const job = { object, rows: [] as SentRow[] };
          jobs.push(job);
          return {
            id: `750${String(jobs.length).padStart(12, '0')}AAA`,
            open: async () => {},
            uploadData: async (csv: string) => {
              job.rows = rowsOfCsv(csv);
            },
            close: async () => {},
            abort: async () => {},
            check: async () => ({ state: 'JobComplete', numberRecordsProcessed: job.rows.length }),
            getAllResults: async () =>
              job.rows.map((row) =>
                isTwin(row)
                  ? { success: false, errors: [`DUPLICATES_DETECTED:${DUPLICATE_RULE_MESSAGE}:--`] }
                  : { success: true, id: newId() },
              ),
          };
        },
      },
    },
  };
}
