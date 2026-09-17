/**
 * One describe per object per org, for a few minutes.
 *
 * A Quick Sync describes its objects on both orgs to build the field mapping,
 * and then the run describes exactly the same objects on exactly the same orgs
 * again, seconds later, to compare field types before writing. Three objects
 * cost twelve describes where six would do.
 *
 * The cost is not only time. Each describe is bounded by its own timeout
 * (`timeouts.describe`, 15 s by default), and a describe that runs out ends the
 * whole run — so describing everything twice doubles the number of chances to
 * hit that. A tester whose Quick Sync failed after 37 seconds, having written
 * nothing, was inside exactly that window.
 *
 * The promise is cached rather than the value, so two callers asking at the
 * same time share one request. A rejected promise is evicted: a describe that
 * timed out must not be remembered as the answer, and the next caller has to be
 * able to try again.
 *
 * The entry is short-lived on purpose. A describe is a snapshot of an org's
 * schema, and someone deploying a field mid-session should not have to restart
 * the editor to be believed — five minutes is long enough to cover one flow
 * end to end and short enough that nobody works around it.
 */

/** How long an entry stays usable. */
export const DESCRIBE_CACHE_TTL_MS = 5 * 60_000;

interface Entry {
  /** When the entry was created, from `Date.now()`. */
  at: number;
  /** The in-flight or settled describe. */
  value: Promise<unknown>;
}

const entries = new Map<string, Entry>();

/** `orgId::Object` — an org's schema is its own. */
const keyFor = (orgId: string, objectApiName: string): string => `${orgId}::${objectApiName}`;

/**
 * Describe `objectApiName` on `orgId`, reusing a recent answer when there is
 * one. `describe` is only called on a miss.
 */
export async function describeCached<T>(
  orgId: string,
  objectApiName: string,
  describe: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const key = keyFor(orgId, objectApiName);
  const cached = entries.get(key);
  if (cached && now() - cached.at < DESCRIBE_CACHE_TTL_MS) {
    return cached.value as Promise<T>;
  }

  const value = describe();
  entries.set(key, { at: now(), value });
  try {
    return await value;
  } catch (err: unknown) {
    // Never remember a failure: the next caller must reach the org again.
    if (entries.get(key)?.value === value) entries.delete(key);
    throw err;
  }
}

/** Forget everything. For tests, and for a caller that knows the schema moved. */
export function clearDescribeCache(): void {
  entries.clear();
}
