import type { FrozenLoadReportInfo, FrozenPerObjectLoadResult } from '@sandforge/shared';

/** Why records of one object failed at a load: one status code and message, and how many. */
export interface FrozenFailureReason {
  objectApiName: string;
  /** Salesforce's status code, e.g. `REQUIRED_FIELD_MISSING`; empty when the error named none. */
  statusCode: string;
  /** The message, as the target, or the load, wrote it. */
  message: string;
  /** Records that failed for it. */
  count: number;
}

/** A record the target refused, with what it said. */
interface Refusal {
  objectApiName: string;
  errors: readonly string[];
}

/** `STATUS_CODE: message`, as the extension writes a refusal the target gave a code to. */
const CODED_ERROR = /^([A-Z][A-Z0-9_]*):\s*([\s\S]*)$/;

/**
 * Why a load's records failed: per object, one reason per status code and
 * message, with how many records — the most frequent first, then by object,
 * then as the load met them. A record refused for two reasons counts under
 * both; one refused twice for the same reason, once.
 *
 * The code comes apart from the message because it names the problem in every
 * language, where the message is in the language of the target's running
 * user; an error without one — the load's own words for an object it did not
 * send, a batch the Bulk API failed whole — is kept whole, under no code.
 */
export function failureReasons(
  perObject: readonly FrozenPerObjectLoadResult[],
): FrozenFailureReason[] {
  return reasonsOf(
    perObject.flatMap(({ objectApiName, failed }) =>
      failed.map((record) => ({ objectApiName, errors: record.errors })),
    ),
  );
}

/**
 * Why a reload's purge left records the earlier loads created in the target:
 * the deletes and deactivations it refused, and a status the purge set to
 * Draft and could not give back — read as {@link failureReasons} reads the
 * load's own.
 */
export function purgeFailureReasons(
  failures: FrozenLoadReportInfo['purge']['failures'],
): FrozenFailureReason[] {
  return reasonsOf(failures);
}

/** Refusals grouped per object, status code and message: see {@link failureReasons}. */
function reasonsOf(refusals: readonly Refusal[]): FrozenFailureReason[] {
  const byReason = new Map<string, FrozenFailureReason>();
  for (const { objectApiName, errors } of refusals) {
    const seen = new Set<string>();
    for (const error of errors.length > 0 ? errors : ['']) {
      const coded = CODED_ERROR.exec(error);
      const statusCode = coded ? coded[1] : '';
      const message = coded ? coded[2] : error;
      const key = `${objectApiName}\u0000${statusCode}\u0000${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const known = byReason.get(key);
      if (known) known.count++;
      else byReason.set(key, { objectApiName, statusCode, message, count: 1 });
    }
  }
  return [...byReason.values()].sort(
    (a, b) => b.count - a.count || a.objectApiName.localeCompare(b.objectApiName),
  );
}
