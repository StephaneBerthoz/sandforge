/**
 * Orphan expansion stage of the Forge execution pipeline.
 *
 * When a record has a required reference field whose target was *never* in
 * the discovery graph (e.g. `Asset.AccountId` pointing at an Account
 * outside the scoped clone), this stage on-demand:
 *
 *   1. Fetches the missing parent by Id from the source org.
 *   2. Inserts a minimal copy into the target org.
 *   3. Records the source→target mapping in the IdRemapper — onto the
 *      record the target already holds when it refuses the copy as a
 *      duplicate and names that record.
 *
 * The copy goes in on the rules the run's own rows go in on: its picklist
 * values checked against what the target allows for the record type it gets
 * (`checkRowPicklists`), written once more without the fields a validation
 * rule or a restricted picklist of the target refused it on
 * (`fieldsToLeaveOut`), and, for a person account, the contact the platform
 * writes with it linked to — each counted where the run counts its own.
 * Copied with none of it, a restricted value its record type refused cost the
 * parent, and every row that needed it with it. A parent goes in an insert of
 * its own, and a refusal costs it one call more at most: it neither reads nor
 * adds to the picklist values the writer stops sending once the target
 * refused them (`BatchWriter.withoutRefusedValues`).
 *
 * Single-hop only — the fetched parent's *own* required FKs are
 * orphan-nullified normally (no recursion). Capped at
 * `maxOrphanParentExpansions` to bound API usage.
 */

import type {
  ExecutionErrorSample,
  ExecutionObjectError,
  FieldInfo,
  ForgeExecutorDeps,
} from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { existingRecordOf } from '../../../core/common/existingRecordMatch.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';
import { logger } from '../../../logger.js';
import { isExcludedFromCopy } from '../excludedObjects.js';
import {
  ACCOUNT,
  CONTACT,
  isPersonAccountRow,
  type RowsLeftToThePlatform,
} from '../../../core/common/platformRecords.js';
import type { IdRemapper } from '../IdRemapper.js';
import type { RecordScopeCache } from '../RecordScopeCache.js';
import {
  warnUnmappedRecordType,
  type RecordTypeMapper,
  type RecordTypeMapping,
} from '../../sync/RecordTypeMapper.js';
import {
  intersect,
  isPersonAccountField,
  targetFieldSetsOf,
  type TargetFieldSets,
} from './RecordCleaner.js';
import {
  checkRowPicklists,
  recordTypeValuesOf,
  type PicklistChangeTally,
  type RecordTypePicklistReads,
  type RecordTypeReadNote,
} from './RecordTypePicklists.js';
import {
  fieldsToLeaveOut,
  sentAgainNote,
  without,
  type WrittenWithoutFields,
} from './BatchWriter.js';
import type { ContactPointNeutralizer } from './ContactPointNeutralizer.js';

/**
 * Strict Salesforce record ID format (15 or 18 alphanumeric characters).
 * Used as a defense-in-depth check before SOQL interpolation.
 */
const SF_RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** Inputs for {@link OrphanExpander.expandForNode}. */
export interface OrphanExpansionInput {
  /** The graph node whose records are about to be inserted. */
  node: ForgeGraphNode;
  /** Source-org field metadata for the node. */
  fieldInfos: FieldInfo[];
  /** Raw records queried from the source org. */
  records: Record<string, unknown>[];
  /** ID of the source Salesforce org. */
  sourceOrgId: string;
  /** ID of the target Salesforce org. */
  targetOrgId: string;
  /** Source→target ID mappings accumulated so far (mutated on success). */
  remapper: IdRemapper;
  /** Scope cache — newly cloned parents are registered for multi-hop scoping. */
  scopeCache: RecordScopeCache | null;
  /** Cross-org RecordType translations applied to the parent's payload. */
  recordTypeMappings: RecordTypeMapping[] | undefined;
  /** Mapper used to rewrite the parent's RecordTypeId (null when no mappings). */
  recordTypeMapper: RecordTypeMapper | null;
  /** Master toggle (`ExecuteOptions.expandOrphanParents`). */
  enabled: boolean;
  /** Cap on expansions per `execute()` call. */
  maxExpansions: number;
  /**
   * Anonymizes a parent's payload before it is inserted, when the run
   * anonymizes: a parent copied from outside the scope carries the same
   * personal data as the rows the run anonymizes.
   */
  anonymize?: (
    objectApiName: string,
    payload: Record<string, unknown>,
    sourceId: string,
    fields: FieldInfo[],
  ) => Record<string, unknown>;
  /**
   * Makes the email addresses and phone numbers of a parent unreachable
   * before it is inserted, as the rows of the run are: a contact copied from
   * outside the scope reaches the target's automation as theirs would.
   * Absent, the parent goes as the source holds it.
   */
  contactPoints?: ContactPointNeutralizer;
  /**
   * Hands back the fields of a parent's describe a copy reads, leaving out
   * those that hold a file's content, and keeps the ones left out for the
   * run's summary. Absent, the parent is read with every field.
   */
  withoutFileContent?: (objectApiName: string, fields: FieldInfo[]) => FieldInfo[];
  /**
   * The run's own start as a draft, for a parent with a status lifecycle — an
   * order, a contract: puts a status past Draft back to the target's Draft
   * one, and returns the status it had; nothing when the parent goes in as it
   * is. Absent, a parent is written with the status it was read with.
   */
  startAsDraft?: (
    objectApiName: string,
    payload: Record<string, unknown>,
  ) => Promise<string | undefined>;
  /**
   * Owes a parent written as a draft the status it had, given back — or
   * reported — with the records of the run written as drafts.
   */
  oweStatus?: (objectApiName: string, targetId: string, status: string) => void;
  /**
   * The object among `candidates` a source id belongs to, as the run tells it
   * by the id's key prefix; nothing when it cannot. What the parent of a
   * lookup that can point at several objects is looked for in. Absent, such
   * a parent is not looked for.
   */
  objectOf?: (id: string, candidates: readonly string[]) => Promise<string | undefined>;
  /**
   * The rows the run leaves to the platform. A parent it writes itself — a
   * tracked change a comment answers — is noted there when it is read, and
   * never sent; one noted already is not read. Absent, a parent is sent as it
   * is read.
   */
  leftToThePlatform?: RowsLeftToThePlatform;
  /**
   * What the record types of the target allow of the objects' picklists: the
   * run's own reads, made once a run per object and record type, so a parent
   * of an object the run writes asks nothing more. Absent, a parent's values
   * are checked against the values of each field alone.
   */
  recordTypePicklists?: RecordTypePicklistReads;
  /** Says, as the run says it of its own rows, a record type whose values the check could not use. */
  onRecordTypeNote?: (objectApiName: string, note: RecordTypeReadNote) => void;
  /** Where the picklist values a parent goes in without, as read, are counted: the run's tally. */
  picklistChanges?: PicklistChangeTally;
  /** Counts a parent written again without the fields the target refused it on. */
  onWrittenWithoutFields?: (objectApiName: string, written: WrittenWithoutFields) => void;
  /**
   * Maps the contact of each person account among `accounts` — parents now in
   * the target, written or linked to one it held — onto the one the platform
   * wrote with it, as the run does for the accounts it writes. Absent, what
   * points at such a contact is not remapped.
   */
  linkPersonContacts?: (accounts: readonly Record<string, unknown>[]) => Promise<void>;
  /**
   * Whether the target has person accounts, as the run reads it; nothing when
   * it cannot say. Without them, a person account goes in as the business one
   * the target makes of it, its name kept, and a person account's contact is
   * copied as any contact is: the target writes none with an account. Absent,
   * the target is taken to have them.
   */
  personAccountsInTarget?: () => Promise<boolean | undefined>;
  /**
   * The fields the user excluded, by object (`ExecuteOptions.fieldExclusions`):
   * never written on a parent either. Absent, none is.
   */
  fieldExclusions?: Readonly<Record<string, readonly string[]>>;
  /**
   * The fields the user renamed, by object (`ExecuteOptions.fieldMappings`): a
   * parent's goes under the name the target has, as a row's does. Absent,
   * none is.
   */
  fieldMappings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Of person accounts' rows, those the target takes as business accounts — it
   * has no person accounts, or the record type a row gets there is a business
   * one — as the run tells them for its own rows. Such a parent goes in as a
   * business account: its name kept, the fields only a person account holds
   * left out. Absent, a parent is one only in a target without person accounts.
   *
   * @param recordTypeWritten - Whether the rows are written with their record type.
   */
  businessAccountsAmong?: (
    rows: readonly Record<string, unknown>[],
    recordTypeWritten: boolean,
  ) => Promise<ReadonlySet<Record<string, unknown>>>;
  /**
   * Whether a person account's contact goes in as a contact of its own: its
   * account is in the target with no contact the platform wrote with it. Such
   * a contact is copied as any parent is. Absent, none does.
   */
  contactOnItsOwn?: (sourceId: string) => boolean;
}

/**
 * What copying a parent came to: in the target, written or linked to the
 * record it held, with the row read of it; or refused, with what the target
 * answered, for the expansion's report.
 */
type ParentCopy =
  | { id: string; existing: boolean; owedStatus?: string; source: Record<string, unknown> }
  | { refused: string[] };

/** What the expansion of a parent the platform writes itself comes to: nothing sent, nothing failed. */
const LEFT_TO_THE_PLATFORM = Symbol('left to the platform');

/**
 * Single-hop orphan parent expander. Holds the per-`execute()` expansion
 * budget, a negative cache of failed (object, sourceId) pairs, and the
 * sampled expansion errors surfaced in the execution summary.
 */
export class OrphanExpander {
  private expansionsUsed = 0;
  /**
   * Negative cache shared across nodes — once an orphan expansion fails
   * for a given (object, sourceId), don't retry it on every other child
   * that references the same parent. Prevents duplicate target rows when
   * two siblings both reference the same uncloned Account.
   */
  private readonly failedOrphans = new Set<string>();
  private readonly expansionErrors: ExecutionErrorSample[] = [];

  constructor(
    private readonly deps: Pick<
      ForgeExecutorDeps,
      'describeFields' | 'queryRecords' | 'insertRecords' | 'describeObject'
    >,
  ) {}

  /**
   * Expand required orphan parents referenced by this node's records.
   *
   * Identifies required reference fields whose value isn't in the remapper
   * and points outside the discovery graph; fetches+inserts each parent
   * on-demand so the child record can pick up the new target ID instead of
   * failing with REQUIRED_FIELD_MISSING.
   */
  async expandForNode(input: OrphanExpansionInput): Promise<void> {
    if (!input.enabled || this.expansionsUsed >= input.maxExpansions) return;
    const { fieldInfos, records, remapper, scopeCache } = input;

    const requiredOrphans = new Map<string, { object: string; sourceId: string }>();
    const requiredRefFields = fieldInfos.filter(
      (f) => f.isReference && f.nillable === false && f.name !== 'RecordTypeId',
    );
    for (const r of records) {
      for (const field of requiredRefFields) {
        const value = r[field.name];
        if (typeof value !== 'string' || !value) continue;
        if (remapper.get(value)) continue;
        if (input.leftToThePlatform?.has(value)) continue;
        const target = await this.parentObjectOf(input, field, value);
        if (!target) continue;
        const key = `${target}::${value}`;
        if (!requiredOrphans.has(key)) {
          requiredOrphans.set(key, { object: target, sourceId: value });
        }
      }
    }
    // Process orphan expansions in parallel waves. Sequential
    // expansions cost up to 60 round-trips (20 orphans × 3 ops);
    // bounded concurrency 4 cuts that ~4x while staying under
    // jsforce's default 5-conn pool.
    const ORPHAN_CONCURRENCY = 4;
    const eligible: Array<{ object: string; sourceId: string; cacheKey: string }> = [];
    for (const [, entry] of requiredOrphans) {
      if (this.expansionsUsed + eligible.length >= input.maxExpansions) break;
      const cacheKey = `${entry.object}::${entry.sourceId}`;
      if (this.failedOrphans.has(cacheKey)) continue;
      if (remapper.get(entry.sourceId)) continue;
      eligible.push({ ...entry, cacheKey });
    }
    // The contacts after the rest: the contact of a person account copied in
    // the first round is the one the platform wrote with it, linked before
    // the second — never copied on its own.
    const rounds = [
      eligible.filter((entry) => entry.object !== CONTACT),
      eligible.filter((entry) => entry.object === CONTACT),
    ];
    for (const round of rounds) {
      /** The person accounts this round put in the target, whose contacts the platform wrote. */
      const personAccounts: Record<string, unknown>[] = [];
      for (let i = 0; i < round.length; i += ORPHAN_CONCURRENCY) {
        // One mapped since it was found an orphan — a person account's
        // contact — is copied no more.
        const slice = round
          .slice(i, i + ORPHAN_CONCURRENCY)
          .filter((entry) => !remapper.get(entry.sourceId));
        await Promise.all(
          slice.map(async (entry) => {
            try {
              const parent = await this.expandSingleOrphanParent(
                input,
                entry.object,
                entry.sourceId,
              );
              // Noted among the rows left to the platform, whose children the
              // run leaves out with it: nothing to map, and nothing failed.
              if (parent === LEFT_TO_THE_PLATFORM) return;
              if (parent && 'id' in parent) {
                // Count only successful expansions toward the cap
                // so a string of misses doesn't silently exhaust the budget
                // before the eligible list has had a chance to succeed.
                this.expansionsUsed++;
                if (parent.existing) {
                  remapper.addExisting(entry.sourceId, parent.id, entry.object);
                } else {
                  remapper.add(entry.sourceId, parent.id, entry.object);
                  if (parent.owedStatus)
                    input.oweStatus?.(entry.object, parent.id, parent.owedStatus);
                }
                // Register the parent in scopeCache so multi-hop
                // children that pivot through this object include the
                // newly cloned row in their scope query (otherwise the
                // scope cache reports the orphan as out-of-scope and the
                // child never gets cloned).
                if (scopeCache) {
                  scopeCache.add(entry.object, [entry.sourceId]);
                }
                if (entry.object === ACCOUNT && isPersonAccountRow(parent.source)) {
                  personAccounts.push(parent.source);
                }
              } else {
                this.failedOrphans.add(entry.cacheKey);
                if (this.expansionErrors.length < 3) {
                  this.expansionErrors.push({
                    recordSummary: `${entry.object}/${entry.sourceId}`,
                    // What the target refused the copy with, as a row of the
                    // run says it: reported without it, a parent refused on a
                    // rule's fields, sent again and refused again, said
                    // nothing of either refusal.
                    messages:
                      parent && parent.refused.length > 0
                        ? parent.refused
                        : [`Orphan parent expansion produced no new id`],
                  });
                }
              }
            } catch (err) {
              this.failedOrphans.add(entry.cacheKey);
              if (this.expansionErrors.length < 3) {
                this.expansionErrors.push({
                  recordSummary: `${entry.object}/${entry.sourceId}`,
                  messages: [extractErrorMessage(err)],
                });
              }
            }
          }),
        );
      }
      // The platform wrote a contact with each person account: what points at
      // the source's — this node's rows, the second round's, the nodes after —
      // points at that one. Left unmapped, a lookup at it went in empty, or
      // took its row down when the row may not leave it empty.
      if (personAccounts.length > 0) await input.linkPersonContacts?.(personAccounts);
    }
  }

  /**
   * The object of the record `id` names through `field`, when it is one the
   * expander copies: not the node's own, and not one no copy writes — User,
   * RecordType, Group, the job and log tables, the history, feed, share and
   * change-event variants, which would only burn calls and fill the error
   * report. The list is discovery's, so the two cannot drift.
   *
   * A lookup that can point at several objects names none of them: the
   * parent's object is the one its id's key prefix stands for, as the run
   * tells it (`objectOf`). Fetched from the first object the lookup named, the
   * parent of a feed item was looked for among the accounts whatever it was —
   * a real org describes `ParentId` with 216 objects, the account first — and
   * one of any other object could not be found there. Nothing when the run
   * cannot tell.
   */
  private async parentObjectOf(
    input: OrphanExpansionInput,
    field: FieldInfo,
    id: string,
  ): Promise<string | undefined> {
    const named = field.referenceTo ?? [];
    const copied = named.filter((target) => !isExcludedFromCopy(target));
    let object: string | undefined;
    if (named.length === 1) object = copied[0];
    else if (copied.length > 0) object = await input.objectOf?.(id, copied);
    return object === input.node.objectApiName ? undefined : object;
  }

  /**
   * Build the aggregated error entry for the execution summary, or `null`
   * when no expansion failed. Mirrors the `__expandOrphanParents__` report
   * the legacy executor appended at the end of `execute()`.
   */
  buildErrorReport(): ExecutionObjectError | null {
    if (this.expansionErrors.length === 0) return null;
    return {
      objectApiName: '__expandOrphanParents__',
      stage: 'insert',
      failedCount: this.expansionErrors.length,
      attemptedCount: this.expansionsUsed,
      samples: this.expansionErrors,
    };
  }

  /**
   * Fetches a missing parent record from the source org by Id, copies it
   * to the target org with a minimal payload (createable target fields
   * only, RecordType remapped if applicable, orphan FKs nullified, picklist
   * values checked), and returns the target ID it now has — the new record's,
   * or the existing one's when the target refuses the copy as a duplicate and
   * names the record it holds — with the row read and, for a new one written
   * as a draft, the status it is owed. A copy a validation rule or a
   * restricted picklist of the target refuses on fields it names is written
   * once more without them, as the run's own rows are. Returns what the
   * target answered when it refuses the
   * copy any other way, `null` when the parent can't be fetched, and
   * {@link LEFT_TO_THE_PLATFORM} for a parent the platform writes itself,
   * noted in `leftToThePlatform` and never sent: run for real, the platform
   * refuses a tracked change from a copy.
   *
   * Intentionally non-recursive — the fetched parent's *own* required FKs
   * are nullified rather than expanded further. Callers must respect the
   * `maxOrphanParentExpansions` cap to bound API usage.
   */
  private async expandSingleOrphanParent(
    input: OrphanExpansionInput,
    parentObject: string,
    sourceRecordId: string,
  ): Promise<ParentCopy | null | typeof LEFT_TO_THE_PLATFORM> {
    const { sourceOrgId, targetOrgId, recordTypeMappings, recordTypeMapper } = input;
    const { anonymize, withoutFileContent, startAsDraft, leftToThePlatform } = input;
    // Defense-in-depth: although sourceRecordId originates from a trusted
    // SOQL query result, validate before interpolating to block injection
    // via crafted source-org data (e.g. a managed package supplying a
    // text-typed "reference" through describe).
    if (!SF_RECORD_ID_RE.test(sourceRecordId)) {
      throw new Error(`Invalid Salesforce record ID for orphan expansion: "${sourceRecordId}"`);
    }
    // The object name comes from a describe's `referenceTo` and goes into the
    // REST path of both describes below, not only into the SOQL. Checking it
    // only at the SOQL line let an unvalidated name reach two requests first.
    const objectName = assertSoqlIdentifier(parentObject);
    const described = await this.deps.describeFields(sourceOrgId, objectName);
    // A field holding a file's content reads as its file's address: the
    // parent is copied without it, as every record of the run is.
    const fields = withoutFileContent ? withoutFileContent(objectName, described) : described;
    const queryFields = fields.filter((f) => f.queryable).map((f) => f.name);
    if (queryFields.length === 0) queryFields.push('Id');
    const soql = `SELECT ${queryFields.join(', ')} FROM ${objectName} WHERE Id = '${sanitizeSoqlValue(sourceRecordId)}'`;
    const records = await this.deps.queryRecords(sourceOrgId, soql);
    if (records.length === 0) return null;
    if (leftToThePlatform && leftToThePlatform.keep(objectName, records).length === 0) {
      return LEFT_TO_THE_PLATFORM;
    }
    // A person account's contact goes in with its account, written by the
    // platform: sent on its own, with its lookups left out as a parent's are,
    // it would stand as a contact of no account beside the platform's. See
    // `personAccountWriteEdges`. A target that wrote none with the account —
    // it has no person accounts, or holds the account as a business one —
    // takes it as any contact.
    const r = records[0];
    const isPerson = isPersonAccountRow(r);
    const personAccounts = isPerson ? await input.personAccountsInTarget?.() : undefined;
    if (
      objectName === CONTACT &&
      isPerson &&
      personAccounts !== false &&
      input.contactOnItsOwn?.(sourceRecordId) !== true
    ) {
      throw new Error(
        "Not copied: a person account's contact is written by the platform with its account, " +
          'never on its own',
      );
    }

    let targetSets: TargetFieldSets | null = null;
    try {
      targetSets = targetFieldSetsOf(
        await this.deps.describeFields(targetOrgId, objectName),
        objectName,
      );
    } catch (err: unknown) {
      // Don't bury the error — the orphan path is high-blast-radius
      // (creates new rows on target). Log so the user sees it in output.
      logger.warn(
        `[forge] orphan-parent target describe failed for ${parentObject}: ${err instanceof Error ? err.message : String(err)}. Falling back to source createable.`,
      );
    }
    const sourceCreatable = new Set(fields.filter((f) => f.createable).map((f) => f.name));
    const effectiveCreatable = targetSets
      ? intersect(sourceCreatable, targetSets.creatable)
      : sourceCreatable;

    // The user's choices for the object hold for a parent as for a row: an
    // excluded field is never written, a renamed one goes under the name the
    // target has, which the field map answers for.
    const excluded = new Set(input.fieldExclusions?.[objectName] ?? []);
    const rename = input.fieldMappings?.[objectName] ?? {};
    const renamed = new Set<string>();
    // Taken as a business account by the target, a person account goes in as
    // one: see `businessAccountsAmong`.
    const recordTypeWritten =
      effectiveCreatable.has('RecordTypeId') &&
      !excluded.has('RecordTypeId') &&
      rename['RecordTypeId'] === undefined;
    const asBusiness =
      objectName === ACCOUNT &&
      isPerson &&
      (input.businessAccountsAmong
        ? (await input.businessAccountsAmong([r], recordTypeWritten)).has(r)
        : personAccounts === false);
    const cleaned: Record<string, unknown> = {};
    for (const field of fields) {
      const key = field.name;
      if (excluded.has(key)) continue;
      const value = r[key];
      if (value === null || value === undefined) continue;
      if (field.isReference && typeof value === 'string' && key !== 'RecordTypeId') {
        // FKs on the parent itself: orphan-nullify (no recursion).
        continue;
      }
      const renamedTo = rename[key];
      if (renamedTo) {
        cleaned[renamedTo] = value;
        renamed.add(renamedTo);
        continue;
      }
      if (!effectiveCreatable.has(key)) continue;
      if (key.endsWith('__pc') && !isPerson) continue;
      if (asBusiness && isPersonAccountField(key)) continue;
      // Computed by the platform for a person account — and for none it takes
      // as a business account, which it refuses without its name.
      if (key === 'Name' && isPerson && !asBusiness) continue;
      cleaned[key] = value;
    }
    input.contactPoints?.forObject(objectName, fields, rename)?.(cleaned);
    // Checked while `RecordTypeId` is still the source's, as the run's rows
    // are: what the record types allow is read by it.
    if (targetSets) {
      const asRead = new Set(
        [...effectiveCreatable].filter((name) => !excluded.has(name) && !rename[name]),
      );
      await this.checkPicklists(input, objectName, r, cleaned, targetSets, asRead, renamed);
    }
    const mapped =
      recordTypeMapper && recordTypeMappings
        ? recordTypeMapper.apply([cleaned], recordTypeMappings, (id) =>
            warnUnmappedRecordType(objectName, id),
          )[0]
        : cleaned;
    const payload = anonymize ? anonymize(objectName, mapped, sourceRecordId, fields) : mapped;
    // Copied as read, an activated order or contract was refused — "choose
    // Draft" — and the child that needed it with it. It goes in as a draft,
    // as the run's own do, and gets its status back with theirs.
    const owedStatus = startAsDraft ? await startAsDraft(objectName, payload) : undefined;
    let written = (await this.deps.insertRecords(targetOrgId, objectName, [payload]))[0];
    if (!written) return null;
    // Refused by a validation rule on fields it named — a phone the target
    // wants in another format — or on a restricted picklist's value its record
    // type does not take, the parent goes once more without them, as a row of
    // the run does; never a third time.
    const leftOut = written.success ? undefined : fieldsToLeaveOut(written, payload, undefined);
    const firstRefusal = written.errors;
    if (leftOut) {
      const again = (
        await this.deps.insertRecords(targetOrgId, objectName, [without(payload, leftOut)])
      )[0];
      if (!again) {
        return { refused: ['No result returned for record', sentAgainNote(leftOut, firstRefusal)] };
      }
      written = again;
    }
    if (written.success) {
      if (leftOut) {
        input.onWrittenWithoutFields?.(objectName, {
          rows: 1,
          fields: leftOut.map((field) => ({ ...field, rows: 1 })),
        });
      }
      return { id: written.id, existing: false, owedStatus, source: r };
    }
    // The parent is often in the target already — which is why it was not in
    // the graph's reach to begin with. When the refusal names it, the child
    // links to it; it is never written to.
    const keyPrefix = this.deps.describeObject
      ? await this.deps.describeObject(targetOrgId, objectName).then(
          (info) => info.keyPrefix,
          () => null,
        )
      : null;
    const existing = existingRecordOf(written, keyPrefix);
    if (existing.kind === 'linked') return { id: existing.id, existing: true, source: r };
    return {
      refused: leftOut ? [...written.errors, sentAgainNote(leftOut, firstRefusal)] : written.errors,
    };
  }

  /**
   * Check a parent's picklist values as the run's rows are checked
   * (`checkRowPicklists`): a restricted one against what the record type it
   * goes in with allows, when the run's mapping knows that record type there,
   * and any other against the values of its field — the target taking any
   * value of an unrestricted one. Changes `cleaned` in place, and counts what
   * it changed in the run's tally.
   *
   * @param written - The fields the parent is written with under the name it was
   *   read with: createable in both orgs, neither excluded nor renamed.
   * @param renamed - The fields written under a rename, which the field map
   *   answers for: not checked, as a row's are not.
   */
  private async checkPicklists(
    input: OrphanExpansionInput,
    objectName: string,
    source: Record<string, unknown>,
    cleaned: Record<string, unknown>,
    sets: TargetFieldSets,
    written: ReadonlySet<string>,
    renamed: ReadonlySet<string>,
  ): Promise<void> {
    const reads = input.recordTypePicklists
      ? await input.recordTypePicklists.forRows({
          objectApiName: objectName,
          rows: [source],
          fields: sets.picklistFields,
          written: (field) => written.has(field),
          recordTypeMappings: input.recordTypeMappings,
          withoutRecordTypes: !sets.fields.some((field) => field.name === 'RecordTypeId'),
        })
      : undefined;
    for (const note of reads?.notes ?? []) input.onRecordTypeNote?.(objectName, note);
    const recordTypeId = cleaned['RecordTypeId'];
    const changes = checkRowPicklists(
      cleaned,
      sets.picklistValuesByField,
      sets.picklistFields,
      recordTypeValuesOf(reads?.byRecordType, recordTypeId),
      renamed,
    );
    input.picklistChanges?.add(objectName, changes);
  }
}
