/**
 * Which record the target org already holds, read from the error it refused a
 * write with.
 *
 * A copy writes rows the target often has already: a sandbox is a copy of the
 * org the rows come from, and an earlier run may have written them. Salesforce
 * refuses such a row and, in the refusal, names the record it collided with —
 * a unique index says `duplicate value found: <field> duplicates value on
 * record with id: <id>`, a duplicate rule lists what it matched in
 * `duplicateResult`. Counting the refusal and nothing more left every child of
 * that row pointing at nothing: the parent was in the target, the run did not
 * know where. Run between two real sandboxes, that is how the relations of a
 * contact and a product's selling model lost the records they hang from.
 *
 * Strict on purpose. A child linked to the wrong parent is worse than a child
 * whose lookup is left empty, so an id is taken only when the refusal names
 * exactly one record, the id is well formed and its checksum holds, and — when
 * the object's key prefix is known — it belongs to the object being written.
 * The existing record is only pointed at, never written to.
 */

import { z } from 'zod';
import {
  ALREADY_EXISTS_ERROR,
  DUPLICATE_RULE_ERROR,
  isAlreadyExistsError,
  isDuplicateRuleError,
} from '@sandforge/shared';

/** One record's save result, as the writers hand it to the stages. */
export interface SaveOutcome {
  /** Id of the record written; empty when the write was refused. */
  id: string;
  /** Whether the write succeeded. */
  success: boolean;
  /** One entry per error, `STATUS_CODE: message` whenever Salesforce gave a code. */
  errors: string[];
  /**
   * Records a duplicate rule matched when it refused the row, read from the
   * error's `duplicateResult` and kept only when they are of the object
   * written. Absent when no rule named any.
   */
  duplicateMatchIds?: string[];
}

/**
 * What a refused row says about the record the target already holds.
 *
 * - `linked`: the refusal names exactly one existing record, by an id that
 *   passes every check. The source row is that record.
 * - `unidentified`: refused as a duplicate, but without one record that can be
 *   trusted — `<unknown>` in place of the id, several candidates, an id of
 *   another object.
 * - `none`: not refused as a duplicate at all.
 */
export type ExistingRecordVerdict =
  | { kind: 'linked'; id: string }
  | { kind: 'unidentified' }
  | { kind: 'none' };

/**
 * The record a unique index names, in any of the forms the message reaches us
 * in: the REST message alone, `DUPLICATE_VALUE: <message>` as the writers
 * format it, or `DUPLICATE_VALUE:<message>:<fields> --` as Bulk API writes it
 * in `sf__Error`. An id is 15 or 18 characters and must not run on into more
 * of them: sixteen characters is not a shorter id, it is not an id.
 */
const DUPLICATE_VALUE_ID_RE =
  /duplicate value found:.*?duplicates value on record with id:\s*([A-Za-z0-9]{18}|[A-Za-z0-9]{15})(?![A-Za-z0-9])/i;

/** Characters of the checksum an 18-character id ends with. */
const CHECKSUM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/**
 * The three characters that turn a 15-character id into its 18-character
 * form: one per block of five, each encoding which letters of the block are
 * upper case.
 */
function checksumOf(id15: string): string {
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const c = id15.charCodeAt(block * 5 + i);
      if (c >= 65 && c <= 90) bits |= 1 << i;
    }
    suffix += CHECKSUM_ALPHABET[bits];
  }
  return suffix;
}

/**
 * The 18-character form of `id`, or `undefined` when it is not one to trust.
 *
 * A 15-character id is extended with its checksum; an 18-character one must
 * already carry the right one — a suffix that does not match its first fifteen
 * characters is a string that looks like an id. With `keyPrefix`, the id must
 * also belong to that object.
 *
 * @param id - Candidate id, as a message or a result gave it.
 * @param keyPrefix - Key prefix of the object the id should belong to, when known.
 */
export function canonicalRecordId(id: string, keyPrefix?: string | null): string | undefined {
  let canonical: string;
  if (/^[A-Za-z0-9]{15}$/.test(id)) {
    canonical = id + checksumOf(id);
  } else if (/^[A-Za-z0-9]{18}$/.test(id) && checksumOf(id.slice(0, 15)) === id.slice(15)) {
    canonical = id;
  } else {
    return undefined;
  }
  if (keyPrefix && !canonical.startsWith(keyPrefix)) return undefined;
  return canonical;
}

/**
 * The id a unique-index refusal names, as written in the message — unchecked.
 * `undefined` when the message names none, which Salesforce does with
 * `<unknown>` when the running user cannot see the record it collided with.
 */
export function recordIdInDuplicateValue(message: string): string | undefined {
  return DUPLICATE_VALUE_ID_RE.exec(message)?.[1];
}

/** A save error as the REST API returns it: `statusCode` from sObject Collections, `errorCode` from a single write. */
const saveErrorSchema = z
  .object({
    statusCode: z.string().optional(),
    errorCode: z.string().optional(),
    message: z.string().optional(),
    duplicateResult: z.unknown().optional(),
  })
  .passthrough();

/** The part of a duplicate rule's `duplicateResult` that names the matched records. */
const duplicateResultSchema = z
  .object({
    matchResults: z
      .array(
        z
          .object({
            entityType: z.string().optional(),
            matchRecords: z
              .array(
                z
                  .object({
                    record: z
                      .object({
                        Id: z.string().optional(),
                        attributes: z
                          .object({ type: z.string().optional() })
                          .passthrough()
                          .optional(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** One record's save result, as jsforce hands back `create` and `upsert`. */
const saveResultSchema = z
  .object({
    id: z.string().nullish(),
    success: z.boolean(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * `STATUS_CODE: message`, the form the error translators and the command line
 * read. The code is what says a row already exists; a writer that kept only
 * the message handed on "duplicate value found: …" with nothing that named it.
 */
export function formatSaveError(error: unknown): string {
  if (typeof error === 'string') return error;
  const parsed = saveErrorSchema.safeParse(error);
  if (!parsed.success) return 'Unknown error';
  const code = parsed.data.statusCode ?? parsed.data.errorCode;
  const message = parsed.data.message ?? '';
  return code ? `${code}: ${message}` : message;
}

/**
 * The records a duplicate rule matched when it refused a row, kept only when
 * they are of `objectApiName`.
 *
 * A rule may match across objects — a lead rule matching contacts is the
 * usual one — and a contact is not the lead the run was writing. A match that
 * does not say which object it is of is not kept either.
 */
export function duplicateRuleMatchIds(error: unknown, objectApiName: string): string[] {
  const parsed = saveErrorSchema.safeParse(error);
  if (!parsed.success) return [];
  if ((parsed.data.statusCode ?? parsed.data.errorCode) !== DUPLICATE_RULE_ERROR) return [];
  const result = duplicateResultSchema.safeParse(parsed.data.duplicateResult);
  if (!result.success) return [];
  const ids: string[] = [];
  for (const match of result.data.matchResults ?? []) {
    for (const { record } of match.matchRecords ?? []) {
      const types = [match.entityType, record?.attributes?.type].filter(
        (t): t is string => typeof t === 'string',
      );
      if (types.length === 0 || types.some((t) => t !== objectApiName)) continue;
      if (record?.Id) ids.push(record.Id);
    }
  }
  return ids;
}

/**
 * One record's save result in the form the stages read. Anything that is not
 * a save result is reported as a refusal rather than read as a success.
 *
 * @param raw - One entry of what jsforce's `create` or `upsert` returned.
 * @param objectApiName - The object written, to keep only its duplicate matches.
 */
export function toSaveOutcome(raw: unknown, objectApiName: string): SaveOutcome {
  const parsed = saveResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      id: '',
      success: false,
      errors: ['Salesforce returned a save result of an unexpected shape'],
    };
  }
  const errors = parsed.data.errors ?? [];
  const matches = errors.flatMap((error) => duplicateRuleMatchIds(error, objectApiName));
  return {
    id: parsed.data.id ?? '',
    success: parsed.data.success,
    errors: errors.map(formatSaveError),
    ...(matches.length > 0 ? { duplicateMatchIds: matches } : {}),
  };
}

/** Every save result of a call, whether jsforce returned an array or a single one. */
export function toSaveOutcomes(raw: unknown, objectApiName: string): SaveOutcome[] {
  return (Array.isArray(raw) ? raw : [raw]).map((entry) => toSaveOutcome(entry, objectApiName));
}

/**
 * What a refused row says about the record the target already holds.
 *
 * Every error must be a duplicate refusal: a row refused for anything else as
 * well is a row that could not have been written, whatever else exists. Every
 * id named must pass {@link canonicalRecordId}, a rule refusal must name at
 * least one record of the object, and all of them together must come down to
 * one record — two candidates is a guess.
 *
 * @param outcome - The row's save result.
 * @param keyPrefix - Key prefix of the object written, when known.
 */
export function existingRecordOf(
  outcome: Pick<SaveOutcome, 'success' | 'errors' | 'duplicateMatchIds'>,
  keyPrefix?: string | null,
): ExistingRecordVerdict {
  if (outcome.success || outcome.errors.length === 0) return { kind: 'none' };
  const isDuplicate = (message: string): boolean =>
    isAlreadyExistsError(message) || isDuplicateRuleError(message);
  if (!outcome.errors.every(isDuplicate)) return { kind: 'none' };

  const candidates = new Set<string>();
  let untrusted = false;
  for (const message of outcome.errors) {
    if (!message.includes(ALREADY_EXISTS_ERROR)) continue;
    const named = recordIdInDuplicateValue(message);
    const id = named ? canonicalRecordId(named, keyPrefix) : undefined;
    if (id) candidates.add(id);
    else untrusted = true;
  }
  const matches = outcome.duplicateMatchIds ?? [];
  if (outcome.errors.some((m) => m.includes(DUPLICATE_RULE_ERROR)) && matches.length === 0) {
    untrusted = true;
  }
  for (const named of matches) {
    const id = canonicalRecordId(named, keyPrefix);
    if (id) candidates.add(id);
    else untrusted = true;
  }

  if (untrusted || candidates.size !== 1) return { kind: 'unidentified' };
  return { kind: 'linked', id: [...candidates][0] };
}
