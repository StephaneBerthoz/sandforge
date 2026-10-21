/**
 * What a Sync write sends of each row, and the rows it holds back before the
 * write: one preparation, read by the write (`DataSync`) and by the simulation
 * that says what the write would do (`SyncOrchestrator.simulate`), so the two
 * cannot tell different stories.
 *
 * Run into a large client sandbox with person accounts and record types per
 * profile, a Sync of accounts and contacts was simulated as 654 accounts and
 * 1 274 contacts inserted, none refused, and wrote no account and 12 contacts:
 *
 * - every business account went with the fields only a person account holds,
 *   empty, and was refused for them (`leftOutForAccountKind`, Forge's rule);
 * - every row went with the source's `RecordTypeId`, an id the target does not
 *   hold: it is now the target's type of the same object and API name, as
 *   Forge maps it, and a row whose type has no counterpart there, or one the
 *   running user may not use, is held back with the reason, as Forge holds it;
 * - the contacts went with their `AccountId` pointing at accounts the target
 *   had just refused, and twelve were written without it to get them in. A
 *   lookup at a record the run wrote now names its copy in the target; a row
 *   whose lookup names a record the run set out to create and could not is
 *   held back ("parent refused", as Forge's rehearsal says it), never written
 *   without its parent.
 */

import type {
  AddOnField,
  CurrencyReplaced,
  FieldMapping,
  SyncObjectConfig,
} from '@sandforge/shared';
import { exclusiveFieldsToDrop } from '@sandforge/shared';
import {
  accountKindOf,
  isPersonAccountRow,
  leftOutForAccountKind,
} from '../../core/common/platformRecords.js';
import {
  defaultRecordTypeOf,
  recordTypeBlockedMessage,
  type RecordTypeAvailability,
} from '../../core/metadata/recordTypeAvailability.js';
import type { SyncRecordTypes } from './syncRecordTypes.js';
import type { TargetWriteFields } from './targetWriteFields.js';
import type { ContactPointNeutralizer } from '../forge/stages/ContactPointNeutralizer.js';
import {
  CURRENCY_FIELD,
  CurrencyReplacementTally,
  currencyFieldsOf,
  datedRateOf,
  followParentCurrency,
  parentCurrencyChange,
  replaceRowCurrency,
  type CurrencyChange,
  type RunCurrencies,
} from '../../core/common/recordCurrencies.js';

/** A Salesforce id, as a lookup holds one. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/**
 * The master record type: an object with no record type of its own stores
 * this id, the same in every org, and it is never in a mapping.
 */
const MASTER_RECORD_TYPE = /^012000000000000(AAA)?$/;

/** An id by its first fifteen characters: the case-sensitive id both forms share. */
function idKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * What a run has written and refused so far, by the source id of each row:
 * what the rows of the objects written after read their lookups against.
 *
 * A record is refused when the run set out to create it — an insert, or an
 * upsert — and the target did not take it, or the run held it back. A record
 * an update or a delete did not reach is the target's already: its children's
 * lookups name it as they did.
 *
 * Begun with what earlier runs of a saved configuration wrote (`SyncIdMap`),
 * a lookup at a record one of them wrote names that copy, unless this run
 * writes the record again; and a record this run refuses is not taken for
 * refused when an earlier run's copy of it is in the target.
 */
export class SyncRunLinks {
  private readonly written = new Map<string, string>();
  private readonly refused = new Map<string, string>();
  /** Copies in the target the run deleted, by the first fifteen characters of their id. */
  private readonly deleted = new Set<string>();
  /** Owners of the source the target refused in this run, by the first fifteen characters of their id. */
  private readonly ownersRefused = new Set<string>();

  /**
   * An owner of the source the target refused in this run, on `OwnerId`, for
   * an id it does not have: the objects written after send their rows
   * without it from the start (`DataSync.write`).
   */
  noteOwnerRefused(ownerId: string): void {
    this.ownersRefused.add(idKey(ownerId));
  }

  /** Whether the target refused this owner of the source earlier in the run. */
  isOwnerRefused(ownerId: string): boolean {
    return this.ownersRefused.has(idKey(ownerId));
  }

  /**
   * @param earlier - What earlier runs of the configuration wrote, by the
   *   first fifteen characters of each source id; none for a run on its own.
   */
  constructor(private readonly earlier: ReadonlyMap<string, string> = new Map()) {}

  /**
   * Records of the target the run deleted, as the source had deleted theirs:
   * a lookup no longer names one of them, which the target would refuse.
   */
  noteDeleted(targetIds: readonly string[]): void {
    for (const id of targetIds) this.deleted.add(idKey(id));
  }

  /** The copy of a source record, unless the run deleted it. */
  private standing(copy: string | undefined): string | undefined {
    return copy !== undefined && this.deleted.has(idKey(copy)) ? undefined : copy;
  }

  /**
   * A source record the target holds the counterpart of, which the run never
   * writes — the standard price book, or a price left out for the source's
   * own in the currency written — and that counterpart's id: a lookup at it
   * names that one.
   */
  noteMatched(sourceId: string, targetId: string): void {
    this.noteWritten(sourceId, targetId);
  }

  /** A source record the run wrote, and the id of its copy in the target. */
  noteWritten(sourceId: string, targetId: string): void {
    this.written.set(idKey(sourceId), targetId);
    this.refused.delete(idKey(sourceId));
  }

  /** A source record of `objectApiName` the run set out to create and did not. */
  noteRefused(sourceId: string, objectApiName: string): void {
    if (this.written.has(idKey(sourceId))) return;
    this.refused.set(idKey(sourceId), objectApiName);
  }

  /**
   * The copy in the target of a source record the run wrote, or else one an
   * earlier run of the configuration wrote, if either did.
   */
  targetOf(sourceId: string): string | undefined {
    return (
      this.standing(this.written.get(idKey(sourceId))) ??
      this.standing(this.earlier.get(idKey(sourceId)))
    );
  }

  /**
   * The object of a source record the run refused, if it refused it and no
   * earlier run's copy of it stands in for it.
   */
  refusedObjectOf(sourceId: string): string | undefined {
    if (this.standing(this.earlier.get(idKey(sourceId))) !== undefined) return undefined;
    return this.refused.get(idKey(sourceId));
  }
}

/** What a write is handed beside the records, from the run it is part of. */
export interface SyncWriteRun {
  /** What the run wrote and refused before this object. */
  links: SyncRunLinks;
  /**
   * Each record as the source read it, in the order of the records: its id,
   * which the run's links are kept by, and whether it is a person account's.
   */
  sources: ReadonlyArray<Record<string, unknown> | undefined>;
  /** The record types of both orgs; absent, `RecordTypeId` goes as it was read. */
  recordTypes?: SyncRecordTypes;
  /**
   * Both orgs' currencies: a row in a currency the target does not hold
   * active goes in its corporate currency, its amounts converted at the
   * source's rates (`core/common/recordCurrencies.ts`). Absent, the row's
   * currency goes as read.
   */
  currencies?: RunCurrencies;
  /**
   * The currency change each row the run sent in another currency went
   * through, by its source id: a row whose currency is its parent's — an
   * opportunity's products — has its amounts converted as its parent's were
   * (`followParentCurrency`). Filled in as the run prepares its rows.
   */
  currencyChangesById?: Map<string, CurrencyChange>;
  /**
   * What neutralizes the emails and phone numbers of the rows before they
   * are written (`neutralizeSyncRows`); absent for a run that keeps them as
   * read (`SyncConfig.keepContactPoints`), and for a write on its own.
   */
  contactPoints?: ContactPointNeutralizer;
  /**
   * How many records, from the first, are standard prices, sent in calls of
   * their own before the others: the platform refuses a custom price sent in
   * the same call as the standard one it needs (`settleSyncPrices`).
   */
  standardFirst?: number;
  /**
   * The objects the run writes after this one that a cycle of lookups ties
   * to it (`SyncWriteOrder.cycles`): a lookup of a row it creates at one of
   * them waits for that record's copy (`deferredAcross`), which the run sets
   * once they are written.
   */
  later?: ReadonlySet<string>;
}

/** A row held back before the write. */
export interface HeldRow {
  /** Its place among the records handed over. */
  index: number;
  /** Why, as the row's own outcome says it. */
  reason: string;
}

/**
 * A lookup of a row left out of the write that creates the row and set by an
 * update once the record it names has its copy: one at another row of the
 * same write — an account's parent account — set by a second write, or one
 * at a record of an object the run writes after it, set by the run once that
 * object is written. See `DataSync.write`.
 */
export interface DeferredLookup {
  /** The row's place among the records handed over. */
  index: number;
  /** The lookup. */
  field: string;
  /** The source id of the record it names. */
  parent: string;
}

/** What a write of one object sends, and what it holds back. */
export interface PreparedSyncRows {
  /** The payloads to send, in the order of the records they come from. */
  payloads: Record<string, unknown>[];
  /** For each payload, the place of its record among those handed over. */
  sentAt: number[];
  /**
   * For each payload, the lookups the run settled — at a record it wrote, or
   * a record type it mapped: a retry never sends the row without them.
   */
  settled: ReadonlySet<string>[];
  /** The rows held back, each with its reason. */
  held: HeldRow[];
  /** The lookups at rows of the same write, set by a second write. */
  deferred: DeferredLookup[];
  /**
   * The lookups at records of an object written after this one, which a
   * cycle ties to it (`SyncWriteRun.later`): left out of the write, and set
   * by the run once that object is written.
   */
  deferredAcross: DeferredLookup[];
  /** What was held back, one line per reason, counted. */
  notes: string[];
  /**
   * The rows sent in another currency than they were read in, by object,
   * currency and why, and what became of their amounts: said apart from the
   * notes, in the user's language where the panel shows them.
   */
  currencies: CurrencyReplaced[];
}

/** What {@link prepareSyncRows} reads. */
export interface PrepareSyncRowsInput {
  readonly config: SyncObjectConfig;
  readonly records: readonly Record<string, unknown>[];
  /** The target's describe of the object; `null` when it could not be read. */
  readonly target: TargetWriteFields | null;
  /** The run the write is part of; absent for a write on its own (Real-time). */
  readonly run?: SyncWriteRun;
}

/**
 * The field a write finds its record by, which has to reach the org whatever
 * the target lets anyone create: `Id` is never creatable, so a filter on the
 * creatable fields alone sent an update without the id it updates, and handed
 * a delete no id at all. An insert is addressed by nothing.
 */
export function addressedBy(config: SyncObjectConfig): string | null {
  switch (config.operation) {
    case 'insert':
      return null;
    case 'upsert':
      return config.externalIdField ?? 'Id';
    case 'update':
    case 'delete':
      return 'Id';
  }
}

/**
 * Apply field mappings and add-on fields to a single source record, and keep
 * the fields the target lets a write carry.
 */
export function applyMappingsAndAddOns(
  record: Record<string, unknown>,
  mappings: FieldMapping[],
  addOns: AddOnField[],
  creatable: ReadonlySet<string> | null,
  key: string | null,
): Record<string, unknown> {
  let result: Record<string, unknown>;

  if (mappings.length === 0) {
    result = { ...record };
  } else {
    result = {};
    for (const mapping of mappings) {
      if (mapping.type === 'exclude') {
        continue;
      }
      result[mapping.targetField] = record[mapping.sourceField];
    }
  }

  // Add-ons are set by the person running the sync, so they are applied
  // before the filter rather than after: an add-on naming a field the target
  // will not take is a mistake worth surfacing, not one to hide.
  for (const addOn of addOns) {
    const fieldExists = addOn.fieldApiName in result;
    if (!fieldExists || addOn.overwriteExisting) {
      result[addOn.fieldApiName] = addOn.value;
    }
  }

  if (!creatable) return result;

  // `attributes` is jsforce's own envelope and is never a field.
  const filtered: Record<string, unknown> = {};
  for (const field of Object.keys(result)) {
    if (field === 'attributes') continue;
    if (creatable.has(field) || field === key) filtered[field] = result[field];
  }
  return filtered;
}

/** What one reason held back, counted, to be said once. */
interface HeldGroup {
  count: number;
  say: (count: number) => string;
}

/** `1 Contact record`, `12 Contact records`. */
function recordsOf(count: number, objectApiName: string): string {
  return `${count} ${objectApiName} record${count === 1 ? '' : 's'}`;
}

/**
 * The record type a row goes in with in the target, or why it cannot go.
 *
 * Mapped from the source's by object and API name when the run read both
 * orgs' record types; a value the target's describe knows already — two orgs
 * that share their ids — goes as it is. A type the target has no counterpart
 * of, or one the running user may not use there, holds the row back, as Forge
 * holds back the rows of a record type it cannot write: written without it,
 * the row would take the running user's default — a business account's type
 * for a person account, an unrelated one for any other — and nothing would
 * say so but the record itself.
 */
function recordTypeOf(
  value: string,
  infos: readonly RecordTypeAvailability[],
  recordTypes: SyncRecordTypes | undefined,
):
  | { sent: string; info?: RecordTypeAvailability }
  | { unmapped: string }
  | { unavailable: RecordTypeAvailability } {
  const known = (id: string): RecordTypeAvailability | undefined =>
    infos.find((info) => idKey(info.recordTypeId) === idKey(id));
  let sent = value;
  if (!known(value) && recordTypes) {
    const mapped = recordTypes.mappings.find((m) => idKey(m.sourceId) === idKey(value));
    if (!mapped) {
      const named = recordTypes.source.find((t) => idKey(t.id) === idKey(value));
      return { unmapped: named?.developerName ?? '' };
    }
    sent = mapped.targetId;
  }
  const info = known(sent);
  if (info && !info.available && !info.master) return { unavailable: info };
  return info ? { sent, info } : { sent };
}

/**
 * Whether the target takes a person account's row as a business account, as
 * Forge tells it (`takenAsBusinessAccounts`): it has no person accounts, or
 * the record type the row goes in with — the one it carries, or the running
 * user's default when it carries none — is no person account's.
 */
function takenAsBusiness(
  target: TargetWriteFields | null,
  recordTypeId: string | undefined,
  personTypes: ReadonlySet<string> | undefined,
): boolean {
  if (target?.personAccounts === false) return true;
  if (!personTypes) return false;
  const type = recordTypeId ?? defaultRecordTypeOf(target?.recordTypes ?? [])?.recordTypeId;
  return type !== undefined && !personTypes.has(idKey(type));
}

/** `PARENT_REFUSED`, said of the rows under a record of `parent` the run refused. */
function parentRefused(
  objectApiName: string,
  field: string,
  parent: string,
): { group: string; reason: string; say: HeldGroup['say'] } {
  return {
    group: `parent:${field}:${parent}`,
    reason: `PARENT_REFUSED: the ${parent} record its ${field} names was refused in this run.`,
    say: (count) =>
      `PARENT_REFUSED: ${recordsOf(count, objectApiName)} held back, not sent: the ` +
      `${parent} record their ${field} names was refused in this run, and written ` +
      `without it they would stand without their ${parent}.`,
  };
}

/**
 * The payloads a write of one object sends, and the rows it holds back, with
 * why: see the module's comment. A delete sends ids alone, and is left as it
 * was mapped.
 *
 * A lookup at another row of the same write — an account's parent account,
 * any lookup of an object at itself — is left out of the payload and set by a
 * second write once that row is in (`deferred`), as Forge's second pass sets
 * it: the write that creates both cannot name a copy neither has yet. Sent
 * with the source's id, the row was refused, or written without it on the
 * retry; two rows that name each other, a loop no order of the rows breaks,
 * are written alike, each then given the other's copy. A row whose record
 * there is held back is held back with it, and so are the rows under it in
 * turn: written, it would stand without its parent.
 *
 * So does a lookup at a record of an object the run writes after this one,
 * which a cycle of lookups ties to it (`run.later`): an account's primary
 * contact, when the contacts name their accounts. The order that writes the
 * accounts first cannot name a contact's copy; the lookup went with the
 * source's id, was refused, and the account was written again without it,
 * which nothing set afterwards (`deferredAcross`). A lookup the target
 * requires goes as before: left out, the row would be refused for it.
 */
export function prepareSyncRows(input: PrepareSyncRowsInput): PreparedSyncRows {
  const { config, records, target, run } = input;
  const objectApiName = config.objectApiName;
  const key = addressedBy(config);
  const infos = target?.recordTypes ?? [];
  const references = target?.references ?? new Set<string>();
  const prepared: PreparedSyncRows = {
    payloads: [],
    sentAt: [],
    settled: [],
    held: [],
    deferred: [],
    deferredAcross: [],
    notes: [],
    currencies: [],
  };
  /** Each row to send, by its place among the records handed over. */
  const staged = new Map<number, { payload: Record<string, unknown>; settled: Set<string> }>();
  const groups = new Map<string, HeldGroup>();
  const hold = (index: number, group: string, reason: string, say: HeldGroup['say']): void => {
    prepared.held.push({ index, reason });
    staged.delete(index);
    const known = groups.get(group);
    if (known) known.count++;
    else groups.set(group, { count: 1, say });
  };
  // The rows of this write that create their record, by source id: a lookup
  // at one of them waits for its copy.
  const creates = config.operation === 'insert' || config.operation === 'upsert';
  const inThisWrite = new Map<string, number>();
  if (run && creates) {
    run.sources.forEach((source, index) => {
      const id = source?.['Id'];
      if (typeof id === 'string' && RECORD_ID.test(id)) inThisWrite.set(idKey(id), index);
    });
  }
  // The lookups at an object the run writes after this one, in a cycle: a
  // row it creates leaves them out, unless the target requires one.
  const later = run && creates ? (run.later ?? new Set<string>()) : new Set<string>();
  const waitsForLater = new Set(
    later.size === 0
      ? []
      : (target?.fields ?? []).flatMap((field) =>
          field.isReference &&
          (field.referenceTo ?? []).some((object) => later.has(object)) &&
          !(field.nillable === false && field.defaultedOnCreate !== true)
            ? [field.name]
            : [],
        ),
  );

  records.forEach((record, index) => {
    const payload = applyMappingsAndAddOns(
      record,
      config.fieldMappings,
      config.addOnFields,
      target?.creatable ?? null,
      key,
    );
    if (config.operation === 'delete') {
      staged.set(index, { payload, settled: new Set() });
      return;
    }
    const settled = new Set<string>();

    // A lookup at a record the run wrote names its copy; one at a record the
    // run set out to create and could not holds the row back; one at a row
    // of this write waits for that row's copy.
    if (run) {
      for (const field of Object.keys(payload)) {
        const value = payload[field];
        if (field === 'RecordTypeId' || !references.has(field)) continue;
        if (typeof value !== 'string' || !RECORD_ID.test(value)) continue;
        if (inThisWrite.has(idKey(value))) {
          delete payload[field];
          prepared.deferred.push({ index, field, parent: value });
          continue;
        }
        const copy = run.links.targetOf(value);
        if (copy) {
          payload[field] = copy;
          settled.add(field);
          continue;
        }
        const parent = run.links.refusedObjectOf(value);
        if (parent === undefined) {
          if (waitsForLater.has(field)) {
            delete payload[field];
            prepared.deferredAcross.push({ index, field, parent: value });
          }
          continue;
        }
        const refused = parentRefused(objectApiName, field, parent);
        hold(index, refused.group, refused.reason, refused.say);
        return;
      }
    }

    // The record type the row goes in with, mapped to the target's.
    const value = payload['RecordTypeId'];
    let recordTypeSent: string | undefined;
    if (typeof value === 'string' && RECORD_ID.test(value) && !MASTER_RECORD_TYPE.test(value)) {
      const type = recordTypeOf(value, infos, run?.recordTypes);
      if ('unmapped' in type) {
        const name = type.unmapped;
        hold(
          index,
          `unmapped:${name}`,
          `RECORD_TYPE_UNMAPPED: its record type has no counterpart in the target org.`,
          (count) =>
            `RECORD_TYPE_UNMAPPED: ${recordsOf(count, objectApiName)} held back, not sent: ` +
            (name
              ? `their record type ${name} has no active ${objectApiName} record type of that ` +
                `API name in the target org. Create or activate record type ${name} on ` +
                `${objectApiName} in the target org.`
              : `their record type is inactive in the source org, and has no counterpart in ` +
                `the target org.`),
        );
        return;
      }
      if ('unavailable' in type) {
        const info = type.unavailable;
        hold(
          index,
          `unavailable:${info.recordTypeId}`,
          `RECORD_TYPE_UNAVAILABLE: record type ${info.developerName} is closed to the running user in the target org.`,
          (count) =>
            `${recordTypeBlockedMessage({
              objectApiName,
              recordTypeId: info.recordTypeId,
              developerName: info.developerName,
              name: info.name,
              inactive: !info.active,
              recordCount: count,
            })} Held back, not sent.`,
        );
        return;
      }
      payload['RecordTypeId'] = type.sent;
      recordTypeSent = type.sent;
      if (type.info) settled.add('RecordTypeId');
    }

    // What the kind of account the row goes in as leaves out.
    const source = run?.sources[index] ?? record;
    if (isPersonAccountRow(source)) {
      const kind = accountKindOf(
        source,
        takenAsBusiness(target, recordTypeSent, run?.recordTypes?.personTypes),
      );
      for (const field of Object.keys(payload)) {
        if (leftOutForAccountKind(objectApiName, field, kind)) delete payload[field];
      }
    } else {
      for (const field of Object.keys(payload)) {
        if (leftOutForAccountKind(objectApiName, field, 'business')) delete payload[field];
      }
    }

    staged.set(index, { payload, settled });
  });

  // A row whose record in this write is held back is held back with it, and
  // the rows under it in turn, until none is left to hold — unless a copy of
  // that record stands in for it, which the second write names.
  let holding = true;
  while (holding) {
    holding = false;
    for (const { index, field, parent } of prepared.deferred) {
      const at = inThisWrite.get(idKey(parent));
      if (!staged.has(index) || at === undefined || staged.has(at)) continue;
      if (run?.links.targetOf(parent) !== undefined) continue;
      const refused = parentRefused(objectApiName, field, objectApiName);
      hold(index, refused.group, refused.reason, refused.say);
      holding = true;
    }
  }
  prepared.deferred = prepared.deferred.filter(({ index }) => staged.has(index));
  prepared.deferredAcross = prepared.deferredAcross.filter(({ index }) => staged.has(index));
  prepared.held.sort((a, b) => a.index - b.index);

  // A row in a currency the target does not hold active was refused for it,
  // and written again without it, in the running user's currency with its
  // amounts as read: it goes in the target's corporate currency, its amounts
  // converted — an opportunity's at the rates of its close date where an org
  // holds dated rates — and the simulation, which prepares the same rows,
  // says so. A row whose currency is its parent's, which the target will not
  // take one of its own for, has its amounts converted as its parent's were.
  const currencies = config.operation === 'delete' ? undefined : run?.currencies;
  const ownCurrency = target?.creatable.has(CURRENCY_FIELD) === true;
  const parentCurrency =
    !ownCurrency &&
    (run?.currencyChangesById?.size ?? 0) > 0 &&
    target?.fields?.some((field) => field.name === CURRENCY_FIELD) === true;
  const currencyFields =
    currencies && (ownCurrency || parentCurrency)
      ? currencyFieldsOf(target?.fields ?? [])
      : undefined;
  const lookups = [...(target?.references ?? [])];
  const replaced = new CurrencyReplacementTally();
  for (const [index, { payload, settled }] of [...staged].sort(([a], [b]) => a - b)) {
    // Two fields the describe calls createable that the platform takes one
    // of: an opportunity's line sent with its unit and total price is
    // refused, "only one of unit price or total price may be specified". Left
    // out before the amounts are converted: the currency line named TotalPrice
    // among the fields converted, a field the write never sent.
    for (const field of exclusiveFieldsToDrop(objectApiName, payload)) delete payload[field];
    if (currencies && currencyFields) {
      const source = run?.sources[index] ?? records[index];
      const read = source?.[CURRENCY_FIELD];
      const change: CurrencyChange | undefined = ownCurrency
        ? replaceRowCurrency(
            payload,
            { read, currencyFields, ratesOn: datedRateOf(objectApiName, source) },
            currencies,
          )
        : followParentCurrency(
            payload,
            {
              read,
              parent: source
                ? parentCurrencyChange(objectApiName, source, lookups, (id) =>
                    run?.currencyChangesById?.get(id),
                  )
                : undefined,
              currencyFields,
            },
            currencies,
          );
      replaced.add(objectApiName, change);
      const sourceId = source?.['Id'];
      if (change && typeof sourceId === 'string') run?.currencyChangesById?.set(sourceId, change);
    }
    prepared.payloads.push(payload);
    prepared.sentAt.push(index);
    prepared.settled.push(settled);
  }
  prepared.notes = [...groups.values()].map(({ count, say }) => say(count));
  prepared.currencies = replaced.list();
  return prepared;
}
