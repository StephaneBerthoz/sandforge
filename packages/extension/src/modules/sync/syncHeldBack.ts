/**
 * The rows a Sync run holds back because a lookup of theirs names a record of
 * an object the target takes none of, counted before its first write.
 *
 * The gate counts each object's rows under its filter before it reads one
 * (`SELECT COUNT()`), so the rows a run left out of an object would hold back
 * in the objects after it were counted as rows to write. Run against a real
 * target, a run whose account upsert matched on a field the target does not
 * match an upsert on said "4 record(s) to write … Contact 4", and its dry run
 * said 0 contacts written and 4 held back: written without the account their
 * `AccountId` names, the contacts would stand without it (`PARENT_REFUSED`).
 *
 * The run notes every record of such an object it sets out to create as
 * refused, and holds back each row whose lookup names one, and the rows under
 * those in turn. Here the same is read before the gate: the records of each
 * object left out, then those of every object whose write carries a lookup
 * at one of them, through the run's own read of the source, and each row is
 * told apart as the run tells it (`SyncRunLinks`): a record an earlier run of
 * a saved configuration copied stands in for its source, and the row naming
 * it goes, with the copy; so does the standard price book, matched to the
 * target's.
 */
import { PRICEBOOK_ENTRY_OBJECT, PRICEBOOK_OBJECT, type SyncObjectConfig } from '@sandforge/shared';
import type { RunCurrencies } from '../../core/common/recordCurrencies.js';
import { namesAPricebook, settleSyncPrices, type StandardPricebooks } from './syncPrices.js';
import { SyncRunLinks } from './syncRowPreparation.js';
import type { WriteLookup } from './syncWriteOrder.js';

/** An object of a run whose rows the run would hold back, and why. */
export interface SyncHeldBackObject {
  objectApiName: string;
  /** Its rows a lookup of which names a record the run leaves out or holds back. */
  rows: number;
  /** The object of the records the first such lookup names, and that lookup. */
  parent: string;
  field: string;
}

/** A Salesforce id, as a lookup holds one. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** An API name as Salesforce matches one, whatever its case. */
const nameKey = (name: string): string => name.toLowerCase();

/** Whether an object's write sets out to create records: an insert, or an upsert. */
function creates(operation: SyncObjectConfig['operation']): boolean {
  return operation === 'insert' || operation === 'upsert';
}

/**
 * The field of the source record a write sends as `targetField`, a lookup of
 * the target: the field a direct or rename mapping takes there, or the field
 * of that name, sent as read. Undefined where the write sends no source id in
 * it — a value the configuration sets (an add-on, a constant, a formula), or
 * one a rule changes — which no refusal of this run reaches.
 */
export function sourceFieldOf(
  objectConfig: Pick<SyncObjectConfig, 'fieldMappings' | 'addOnFields' | 'transformRules'>,
  targetField: string,
): string | undefined {
  const key = nameKey(targetField);
  if (objectConfig.addOnFields.some((addOn) => nameKey(addOn.fieldApiName) === key)) {
    return undefined;
  }
  if (objectConfig.transformRules.some((rule) => rule.field && nameKey(rule.field) === key)) {
    return undefined;
  }
  const mapping = objectConfig.fieldMappings.find(
    (candidate) => candidate.type !== 'exclude' && nameKey(candidate.targetField) === key,
  );
  if (!mapping) return targetField;
  return (mapping.type === 'direct' || mapping.type === 'rename') &&
    (mapping.transformRules ?? []).length === 0
    ? mapping.sourceField
    : undefined;
}

/** What {@link heldBackOf} reads. */
export interface HeldBackInput {
  /** The run's objects, in the order it writes them. */
  ordered: readonly SyncObjectConfig[];
  /** Per object, the lookups its write carries (`lookupsOf`). */
  lookups: ReadonlyMap<string, readonly WriteLookup[]>;
  /** The objects the target takes none of, by API name, left out of the run as it writes. */
  leftOut: ReadonlySet<string>;
  /** What earlier runs of the configuration wrote, by the first fifteen characters of each source id. */
  earlier?: ReadonlyMap<string, string>;
  /**
   * Per object an insert writes, the source records an earlier run copied,
   * by the first fifteen characters of their id: left as they are, neither
   * written nor held back.
   */
  copied?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The records an object's read returns, as the run reads them. */
  read: (objectConfig: SyncObjectConfig) => Promise<Record<string, unknown>[]>;
  /**
   * Both orgs' standard price books, as the run reads them: once an object's
   * records name a price book, the source's is matched to the target's, as
   * the run matches it (`pricesSettled`), so it is never noted refused and a
   * row naming it is not held back. Absent, or answering none, the run sends
   * it as read, and it is counted as any other record.
   */
  standardPricebooks?: () => Promise<StandardPricebooks | undefined>;
  /** Both orgs' currencies, as the run reads them: what its prices are settled by. */
  currencies?: () => Promise<RunCurrencies | undefined>;
  /**
   * Receives, per object, the rows the run never writes for a record the
   * target holds the counterpart of: the standard price book, matched to the
   * target's, and each price left out for the source's own in the currency
   * written (`SettledSyncRows.standsFor`), linked to its copy. An object left
   * out counts only the first: none of its prices are written. Given, the
   * price books and the prices the run writes are read for it; a dry run's
   * check counted 9 prices to write where its simulation inserted 6, the 3
   * in GBP standing in, and its refusal said "Pricebook2 (2 records)" of an
   * object whose standard book was matched and the one other refused.
   */
  matched?: Map<string, number>;
}

/** Whether the source holds a currency active the target does not, which the run's prices are settled for. */
function settlesCurrencies(currencies: RunCurrencies | undefined): currencies is RunCurrencies {
  return (
    currencies !== undefined &&
    [...currencies.source.active].some((code) => !currencies.target.active.has(code))
  );
}

/**
 * The rows of each object the run would hold back for a record of an object
 * left out, or for a row it holds back in turn, by object: what its gate
 * counts apart from the rows it writes. An object left out that creates
 * nothing — an update, a delete — names records the target holds, and holds
 * nothing back. Nothing is read when no object of the run carries a lookup
 * at one left out, unless the run's price books and prices are counted for
 * {@link HeldBackInput.matched}.
 */
export async function heldBackOf(input: HeldBackInput): Promise<Map<string, SyncHeldBackObject>> {
  const held = new Map<string, SyncHeldBackObject>();
  const links = new SyncRunLinks(input.earlier);
  /** The objects some of whose records the run would refuse, by {@link nameKey}. */
  const refusing = new Set<string>();
  const leftOut = new Set([...input.leftOut].map(nameKey));
  /** Both orgs' standard price books, once a read named a price book. */
  let standard: StandardPricebooks | undefined;
  /**
   * An object's records as the run reads them, the standard price book
   * matched before any is noted or told apart: with its price books left
   * out, a sync's gate counted held back for the book the standard book's
   * prices and the lines on them, which the run then wrote.
   */
  const readOf = async (objectConfig: SyncObjectConfig): Promise<Record<string, unknown>[]> => {
    const records = await input.read(objectConfig);
    if (records.length > 0 && namesAPricebook(objectConfig.objectApiName, records)) {
      standard = await input.standardPricebooks?.();
      if (standard) links.noteMatched(standard.source, standard.target);
    }
    return records;
  };
  const matched = input.matched;
  /** Adds to what `name` never writes for a counterpart the target holds. */
  const noteMatchedRows = (name: string, rows: number): void => {
    if (matched && rows > 0) matched.set(name, (matched.get(name) ?? 0) + rows);
  };
  /** The source's standard price book among the records of a read of the price books. */
  const standardAmong = (name: string, records: readonly Record<string, unknown>[]): number => {
    const book = standard?.source;
    return name === PRICEBOOK_OBJECT && book !== undefined
      ? records.filter((record) => record['Id'] === book).length
      : 0;
  };
  for (const objectConfig of input.ordered) {
    const name = objectConfig.objectApiName;
    if (leftOut.has(nameKey(name))) {
      if (!creates(objectConfig.operation)) continue;
      // Every record its read returns is noted refused, as the run notes it.
      const records = await readOf(objectConfig);
      for (const record of records) {
        const id = record['Id'];
        if (typeof id === 'string' && id !== '') links.noteRefused(id, name);
      }
      noteMatchedRows(name, standardAmong(name, records));
      refusing.add(nameKey(name));
      continue;
    }
    if (objectConfig.operation === 'delete') continue;
    const carried = (input.lookups.get(name) ?? []).flatMap(({ field, referenceTo }) => {
      const parents = referenceTo.filter(
        (parent) => nameKey(parent) !== nameKey(name) && refusing.has(nameKey(parent)),
      );
      const source = parents.length > 0 ? sourceFieldOf(objectConfig, field) : undefined;
      return source !== undefined ? [{ field, source }] : [];
    });
    // What the run matches rather than writes: the standard price book among
    // the price books it creates, and the prices it leaves out for the
    // source's own in a currency the target holds.
    const counts = matched !== undefined && creates(objectConfig.operation);
    const books =
      counts && name === PRICEBOOK_OBJECT && (await input.standardPricebooks?.()) !== undefined;
    const currencies =
      counts && name === PRICEBOOK_ENTRY_OBJECT && (await input.standardPricebooks?.())
        ? await input.currencies?.()
        : undefined;
    const prices = settlesCurrencies(currencies);
    if (carried.length === 0 && !books && !prices) continue;
    let rows = 0;
    let first: { parent: string; field: string } | undefined;
    const copied = input.copied?.get(name);
    const records = (await readOf(objectConfig)).filter((record) => {
      const id = record['Id'];
      return !(copied && typeof id === 'string' && copied.has(id.slice(0, 15)));
    });
    /** The rows held back, by source id. */
    const heldIds = new Set<string>();
    for (const record of carried.length > 0 ? records : []) {
      const id = record['Id'];
      const at = carried.find(({ source }) => {
        const value = record[source];
        return (
          typeof value === 'string' &&
          RECORD_ID.test(value) &&
          links.refusedObjectOf(value) !== undefined
        );
      });
      if (!at) continue;
      rows++;
      const parent = links.refusedObjectOf(record[at.source] as string) ?? '';
      first ??= { parent, field: at.field };
      if (typeof id === 'string' && id !== '') heldIds.add(id);
      // A row held back is refused too, for the objects after it.
      if (creates(objectConfig.operation) && typeof id === 'string' && id !== '') {
        links.noteRefused(id, name);
      }
    }
    if (books) noteMatchedRows(name, standardAmong(name, records));
    if (prices) {
      // Settled as the run settles them (`pricesSettled`): one under a book
      // or a product the run refused is held back, and stands for none.
      const settled = settleSyncPrices(
        PRICEBOOK_ENTRY_OBJECT,
        {
          records,
          sources: records,
          sourceIds: records.map((record) =>
            typeof record['Id'] === 'string' ? record['Id'] : undefined,
          ),
        },
        standard,
        currencies,
        (id) => links.refusedObjectOf(id) !== undefined,
      );
      let standingIn = 0;
      for (const [left, stand] of settled.standsFor) {
        if (heldIds.has(left)) continue;
        standingIn++;
        // Refused with the price it is left out for, as the run refuses it
        // (`linkWhatStoodIn`), when the run holds that one back.
        if (links.refusedObjectOf(stand) !== undefined) links.noteRefused(left, name);
      }
      noteMatchedRows(name, standingIn);
    }
    if (rows > 0 && first) {
      held.set(name, { objectApiName: name, rows, ...first });
      if (creates(objectConfig.operation)) refusing.add(nameKey(name));
    }
  }
  return held;
}
