import type { FrozenLoadReportInfo, FrozenUnresolvedLinkCause } from '@sandforge/shared';

/** Links of one object, lookup and cause a load left unresolved, and how many. */
export interface FrozenUnresolvedLinks {
  objectApiName: string;
  /** The lookup: `PersonContactId` for a person account's link to its contact. */
  field: string;
  cause: FrozenUnresolvedLinkCause;
  /** The target's words, for an update it refused; empty for any other cause. */
  message: string;
  /** Links of this object, lookup and cause. */
  count: number;
}

/**
 * The links a load left unresolved — the cycle lookups pass 2 owed, and each
 * person account's link to its contact — per object, lookup and cause, with
 * how many: object by object, then lookup by lookup, the most frequent cause
 * first. A lookup counts once per record, as pass 2 counts the ones it
 * resolved: a refused update of two lookups of one record leaves both.
 */
export function unresolvedLinks(
  report: Pick<FrozenLoadReportInfo, 'pass2' | 'personContact'>,
): FrozenUnresolvedLinks[] {
  const byKey = new Map<string, FrozenUnresolvedLinks>();
  const add = (
    objectApiName: string,
    field: string,
    cause: FrozenUnresolvedLinkCause,
    detail: string,
  ): void => {
    // Only a refusal says something of its own: the load's words for a
    // record it did not write name the record, and would part the rows.
    const message = cause === 'update-refused' ? detail : '';
    const key = `${objectApiName}\u0000${field}\u0000${cause}\u0000${message}`;
    const known = byKey.get(key);
    if (known) known.count++;
    else byKey.set(key, { objectApiName, field, cause, message, count: 1 });
  };
  for (const link of report.pass2.unresolved) {
    for (const field of link.field.split(',')) {
      add(link.objectApiName, field, link.cause, link.detail);
    }
  }
  for (const link of report.personContact.unresolved) {
    add('Account', 'PersonContactId', link.cause, link.detail);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.objectApiName.localeCompare(b.objectApiName) ||
      a.field.localeCompare(b.field) ||
      b.count - a.count,
  );
}

/** How many lookups pass 2 left unresolved, counted as it counts the ones it resolved. */
export function unresolvedCycleLookups(report: Pick<FrozenLoadReportInfo, 'pass2'>): number {
  return report.pass2.unresolved.reduce((sum, link) => sum + link.field.split(',').length, 0);
}
