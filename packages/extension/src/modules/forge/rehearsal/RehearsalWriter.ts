import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import type { ForgeExecutorDeps, InsertResult, UpdateResult } from '../ForgeExecutor.js';

/** One row the run would create, as the executor handed it to its writer. */
export interface RehearsedRow {
  /** Where the run would create it among the rows it creates, from 0. */
  seq: number;
  objectApiName: string;
  /**
   * The row as the run would send it: read, cleaned, its picklists checked,
   * its contact points neutralized, the run's decisions applied. A lookup to a
   * record the run creates holds that record's placeholder id.
   */
  fields: Record<string, unknown>;
  /** The id the executor was handed for the record, standing for the one the run would create. */
  placeholderId: string;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * What every placeholder carries after its key prefix: an instance `RH` and,
 * where a real id always holds `0`, a `Z`. No record of any org has an id of
 * this shape, so a placeholder never names one, and a query that names a
 * placeholder is a question about a record that does not exist.
 */
const PLACEHOLDER_MARK = 'RHZ';

/** A placeholder anywhere in a text: its key prefix, the mark, its number and checksum. */
const PLACEHOLDER_IN_TEXT_RE = /[A-Za-z0-9]{3}RHZ[A-Za-z0-9]{12}/g;

/** The key prefix a placeholder takes when the target's describe gives the object none. */
const NO_KEY_PREFIX = '000';

/**
 * The placeholder id of the `seq`-th record the run would create: 18
 * characters, the object's key prefix, the mark, the number in base 62 and the
 * checksum, as a real id of the object is shaped. The executor checks the ids
 * its writer hands back as it checks the target's, and puts them in the
 * lookups of the rows that name the record.
 */
export function placeholderId(keyPrefix: string | null, seq: number): string {
  const prefix =
    keyPrefix !== null && /^[A-Za-z0-9]{3}$/.test(keyPrefix) ? keyPrefix : NO_KEY_PREFIX;
  let digits = '';
  for (let rest = seq; digits.length === 0 || rest > 0; rest = Math.floor(rest / 62)) {
    digits = BASE62[rest % 62] + digits;
  }
  const id = canonicalRecordId(`${prefix}${PLACEHOLDER_MARK}${digits.padStart(9, '0')}`);
  if (id === undefined) throw new Error(`No placeholder id for record ${seq}`);
  return id;
}

/**
 * The writer a rehearsal hands the executor in place of the target's: it
 * keeps every row the run would create, in the order the run would create
 * them, and answers each with a placeholder id, as if the row had been
 * written. Nothing reaches the target through it.
 *
 * The run's preparation is the executor's own — the read, the cleaning, the
 * picklist checks, the contact points neutralized, the decisions — run whole
 * with this writer: extracting it would have made a second copy of what a run
 * sends, and a rehearsal of that copy judges rows no run writes.
 */
export class RehearsalWriter {
  /** The rows the run would create, in order. */
  readonly rows: RehearsedRow[] = [];
  /** The rows the run would update after its inserts, which a rehearsal does not send. */
  updates = 0;
  /** Each placeholder, by its first 15 characters, to the row it stands for. */
  private readonly byId = new Map<string, RehearsedRow>();
  /** Key prefix per object, asked once. */
  private readonly prefixes = new Map<string, Promise<string | null>>();

  /**
   * @param keyPrefixOf - The target's key prefix of an object, from the
   *   describe the run holds; `null` when it gives none.
   */
  constructor(private readonly keyPrefixOf: (objectApiName: string) => Promise<string | null>) {}

  /** Keep the rows, and hand each back a placeholder id: the executor's `insertRecords`. */
  readonly insertRecords = async (
    _orgId: string,
    objectApiName: string,
    records: Record<string, unknown>[],
  ): Promise<InsertResult[]> => {
    const prefix = await this.prefixOf(objectApiName);
    return records.map((record) => {
      const seq = this.rows.length;
      const row: RehearsedRow = {
        seq,
        objectApiName,
        fields: { ...record },
        placeholderId: placeholderId(prefix, seq),
      };
      this.rows.push(row);
      this.byId.set(row.placeholderId.slice(0, 15), row);
      return { id: row.placeholderId, success: true, errors: [] };
    });
  };

  /**
   * Count the rows, and answer each as updated: the executor's
   * `updateRecords`. What a run updates after its inserts is a record the
   * rehearsal never created; it is counted, never sent.
   */
  readonly updateRecords = async (
    _orgId: string,
    _objectApiName: string,
    records: Record<string, unknown>[],
  ): Promise<UpdateResult[]> => {
    this.updates += records.length;
    return records.map((record) => ({
      id: typeof record['Id'] === 'string' ? record['Id'] : '',
      success: true,
      errors: [],
    }));
  };

  /** The row a value stands for, when it is one of this writer's placeholders. */
  rowOf(value: unknown): RehearsedRow | undefined {
    if (typeof value !== 'string' || (value.length !== 15 && value.length !== 18)) return undefined;
    return this.byId.get(value.slice(0, 15));
  }

  /**
   * The executor's `queryRecords`, answering with no row a query that names a
   * placeholder: the run reads back from the target what it created — the
   * dates of its writes, the contact of a person account — and no record
   * stands behind a placeholder. Every other query goes to `query`.
   */
  guardQueries(query: ForgeExecutorDeps['queryRecords']): ForgeExecutorDeps['queryRecords'] {
    return async (orgId, soql, onTruncated) =>
      this.namesAPlaceholder(soql) ? [] : query(orgId, soql, onTruncated);
  }

  private namesAPlaceholder(text: string): boolean {
    for (const [candidate] of text.matchAll(PLACEHOLDER_IN_TEXT_RE)) {
      if (this.rowOf(candidate)) return true;
    }
    return false;
  }

  private prefixOf(objectApiName: string): Promise<string | null> {
    let prefix = this.prefixes.get(objectApiName);
    if (!prefix) {
      prefix = this.keyPrefixOf(objectApiName).catch(() => null);
      this.prefixes.set(objectApiName, prefix);
    }
    return prefix;
  }
}

/**
 * The executor's deps for a rehearsal: the run's reads, every query that
 * names a placeholder answered with none, and the rehearsal's writer in place
 * of each that writes. No upsert — a rehearsal judges what a row would become
 * created — and no file: what copies files is left out, so a run asked to
 * copy them would be refused, and the caller asks for none.
 */
export function rehearsalExecutorDeps(
  reads: ForgeExecutorDeps,
  writer: RehearsalWriter,
): ForgeExecutorDeps {
  return {
    queryRecords: writer.guardQueries(reads.queryRecords),
    describeFields: reads.describeFields,
    isObjectCreatable: reads.isObjectCreatable,
    describeObject: reads.describeObject,
    recordTypePicklists: reads.recordTypePicklists,
    batchStrategy: reads.batchStrategy,
    anonymize: reads.anonymize,
    requestsSent: reads.requestsSent,
    insertRecords: writer.insertRecords,
    updateRecords: writer.updateRecords,
  };
}
