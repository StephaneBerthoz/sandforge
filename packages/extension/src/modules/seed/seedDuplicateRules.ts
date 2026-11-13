/**
 * The objects an active duplicate rule watches in an org, which a seed writes
 * through the REST API rather than a Bulk API job.
 *
 * A seed's inserts carry the header that lets a duplicate rule's matches be
 * saved: the rows are invented, and land in an org that may already hold rows
 * like them. A Bulk API job carries no header, and the panel sends an object
 * of more than 200 records as one: run into a new Developer Edition, Sales
 * Cloud Starter's 500 accounts went as a job, and the org's standard account
 * rule refused 296 of them with DUPLICATES_DETECTED — and with them their
 * contacts, opportunities and line items. Such an object is written 200
 * records a call through REST, with the header; any other still goes as a job.
 */

import type { ForgeTargetAutomation } from '@sandforge/shared';

const ACTIVE_DUPLICATE_RULES = 'SELECT SobjectType FROM DuplicateRule WHERE IsActive = true';

/**
 * The objects the standard duplicate rules every org starts with watch, and
 * keep active: Account, Contact and Lead. Sent as a Bulk API job, which cannot
 * waive a rule, the standard account rule refused 296 of 500 accounts. A
 * seed's insert sends them through REST when it cannot read the rules
 * (`seedInsert`), and its gate prices them so (`seedWritesEstimate`).
 */
export const STANDARD_DUPLICATE_RULE_OBJECTS: ReadonlySet<string> = new Set([
  'Account',
  'Contact',
  'Lead',
]);

/**
 * Whether an active duplicate rule watches each object a read of the target's
 * automation looked at, by the object's name as the read was asked it: what
 * the gate of a seed or an import prices their writes by, before the insert
 * reads the rules again for itself. An object the read listed without its
 * rules is left out — a read made before they were read —, and nothing at all
 * is said when the read could not reach them: an estimate then takes the
 * dearer path.
 */
export function duplicateRulesOf(
  read: ForgeTargetAutomation | { unread: string },
): ReadonlyMap<string, boolean> | undefined {
  if (typeof read.unread === 'string') return undefined;
  const automation = read as ForgeTargetAutomation;
  if (automation.unread.some((part) => part.part === 'duplicateRules')) return undefined;
  const listed = new Map(
    automation.objects.map((object) => [object.objectApiName.toLowerCase(), object.duplicateRules]),
  );
  const said = new Map<string, boolean>();
  for (const objectApiName of automation.objectsRead) {
    const key = objectApiName.toLowerCase();
    // An object that runs nothing is not among the objects: no rule watches it.
    if (!listed.has(key)) {
      said.set(objectApiName, false);
      continue;
    }
    const rules = listed.get(key);
    if (rules !== undefined) said.set(objectApiName, rules.length > 0);
  }
  return said;
}

/**
 * The objects an active duplicate rule watches, or undefined when the org
 * will not say: the caller then writes as it did, and says so.
 */
export async function objectsUnderDuplicateRules(conn: {
  query: (soql: string) => PromiseLike<{ records: Array<Record<string, unknown>> }>;
}): Promise<ReadonlySet<string> | undefined> {
  try {
    const answer = await conn.query(ACTIVE_DUPLICATE_RULES);
    return new Set(
      answer.records.flatMap((row) =>
        typeof row['SobjectType'] === 'string' ? [row['SobjectType']] : [],
      ),
    );
  } catch {
    return undefined;
  }
}
