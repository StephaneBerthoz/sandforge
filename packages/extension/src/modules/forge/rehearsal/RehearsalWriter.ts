import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import {
  ACCOUNT,
  CONTACT,
  PERSON_CONTACT_FIELD,
  accountsOfPersonContactsSoql,
  personContactsSoql,
} from '../../../core/common/platformRecords.js';
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

/** One update the run would make after its inserts, as the executor handed it to its writer. */
export interface RehearsedUpdate {
  /** Where the run would send it among the updates it makes, from 0. */
  seq: number;
  objectApiName: string;
  /**
   * The record it updates: the placeholder of a row the run creates, or the
   * id of a record the target held, which a rehearsal never writes.
   */
  recordId: string;
  /** What it sets, without the id. A lookup to a record the run creates holds its placeholder. */
  fields: Record<string, unknown>;
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
export const NO_KEY_PREFIX = '000';

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
 * written; and every update the run would make after, answered as made.
 * Nothing reaches the target through it.
 *
 * The run's preparation is the executor's own — the read, the cleaning, the
 * picklist checks, the contact points neutralized, the decisions — run whole
 * with this writer: extracting it would have made a second copy of what a run
 * sends, and a rehearsal of that copy judges rows no run writes.
 */
export class RehearsalWriter {
  /** The rows the run would create, in order. */
  readonly rows: RehearsedRow[] = [];
  /** The updates the run would make after its inserts, in order. */
  readonly updated: RehearsedUpdate[] = [];
  /** Each placeholder, by its first 15 characters, to the row it stands for. */
  private readonly byId = new Map<string, RehearsedRow>();
  /**
   * The placeholder of the contact the platform writes with a person account
   * the run creates, by its first 15 characters, to the account's row.
   */
  private readonly personContacts = new Map<string, RehearsedRow>();
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

  /** How many updates the run would make after its inserts. */
  get updates(): number {
    return this.updated.length;
  }

  /**
   * Keep the updates, and answer each as made: the executor's
   * `updateRecords`. The rehearsal sends one of a record the run creates in
   * the call that creates it, after its inserts; nothing here reaches the
   * target.
   */
  readonly updateRecords = async (
    _orgId: string,
    objectApiName: string,
    records: Record<string, unknown>[],
  ): Promise<UpdateResult[]> =>
    records.map((record) => {
      const recordId = typeof record['Id'] === 'string' ? record['Id'] : '';
      const fields: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(record)) {
        if (field !== 'Id' && field !== 'attributes') fields[field] = value;
      }
      this.updated.push({ seq: this.updated.length, objectApiName, recordId, fields });
      return { id: recordId, success: true, errors: [] };
    });

  /** The row a value stands for, when it is one of this writer's placeholders. */
  rowOf(value: unknown): RehearsedRow | undefined {
    if (typeof value !== 'string' || (value.length !== 15 && value.length !== 18)) return undefined;
    return this.byId.get(value.slice(0, 15));
  }

  /**
   * The person account whose contact a value stands for, when it is the
   * placeholder of the contact the platform writes with an account the run
   * creates ({@link guardQueries}).
   */
  personContactOf(value: unknown): RehearsedRow | undefined {
    if (typeof value !== 'string' || (value.length !== 15 && value.length !== 18)) return undefined;
    return this.personContacts.get(value.slice(0, 15));
  }

  /**
   * The executor's `queryRecords`, answering with no row a query that names a
   * placeholder: the run reads back from the target what it created — the
   * dates of its writes — and no record stands behind a placeholder. Every
   * other query goes to `query`.
   *
   * But the read of the contact the platform wrote with each person account
   * (`personContactsSoql`), which this writer answers for the accounts the
   * run creates as the target would. Answered with none, every person
   * account's contact went on its own, as the contact of an account the
   * target holds as a business one does: run on a large client sandbox, the
   * rehearsal sent the contact the run leaves to the platform, the target
   * refused it (`INVALID_CROSS_REFERENCE_KEY: Cannot select a person
   * account`), and the five records under it were judged under a refusal no
   * run meets.
   */
  guardQueries(query: ForgeExecutorDeps['queryRecords']): ForgeExecutorDeps['queryRecords'] {
    return async (orgId, soql, onTruncated) => {
      const accounts = accountsOfPersonContactsSoql(soql);
      if (accounts) {
        return this.personContactsOf(accounts, (held) =>
          query(orgId, personContactsSoql(held), onTruncated),
        );
      }
      return this.namesAPlaceholder(soql) ? [] : query(orgId, soql, onTruncated);
    };
  }

  /**
   * The answer to the read of the contact of each of `ids`: the target's for
   * the accounts it holds, and, for each the run creates, the placeholder of
   * the contact the platform writes with it — or none, the row going as a
   * business account. The run sends a person account without its name, which
   * the platform computes, and one the target takes as a business account
   * with it (`RecordCleaner`): the platform writes a contact with the first
   * alone.
   */
  private async personContactsOf(
    ids: readonly string[],
    askTheTarget: (held: string[]) => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    const held = ids.filter((id) => !this.rowOf(id));
    const answered = held.length > 0 ? await askTheTarget(held) : [];
    const ours = ids.flatMap((id) => (this.rowOf(id)?.objectApiName === ACCOUNT ? [id] : []));
    if (ours.length === 0) return answered;
    const prefix = await this.prefixOf(CONTACT);
    return [
      ...answered,
      ...ours.map((id) => {
        const account = this.rowOf(id) as RehearsedRow;
        if ('Name' in account.fields) return { Id: id, [PERSON_CONTACT_FIELD]: null };
        const contact = placeholderId(prefix, account.seq);
        this.personContacts.set(contact.slice(0, 15), account);
        return { Id: id, [PERSON_CONTACT_FIELD]: contact };
      }),
    ];
  }

  private namesAPlaceholder(text: string): boolean {
    for (const [candidate] of text.matchAll(PLACEHOLDER_IN_TEXT_RE)) {
      if (this.rowOf(candidate) || this.personContactOf(candidate)) return true;
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
