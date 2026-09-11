/**
 * Which SObjects a natural-language request actually names.
 *
 * NL2SOQL needs field API names to write a query that survives contact with
 * the org, and a field name only exists in a per-object describe. Describing
 * an org wholesale is not an option: a Developer Edition with no managed
 * package answers describeGlobal with 1453 SObjects (1219 of them queryable),
 * so "describe everything" is 1219 REST round trips at ~2 s each — about 41
 * minutes, for a prompt no context window would accept.
 *
 * The cheap half of that trade is here: read the request, keep the handful of
 * objects it names, and let the caller describe only those. Everything else
 * stays a bare API name, and the caller is expected to say so rather than
 * pretend the fields were checked.
 */

/** One entry of a describeGlobal catalog, reduced to what matching needs. */
export interface SObjectCatalogEntry {
  /** API name, e.g. `Account` or `Invoice__c`. */
  name: string;
  /** Localized singular label, e.g. `Compte`. */
  label: string;
  /** Localized plural label when the org supplies one. */
  labelPlural?: string;
  /** Whether the object can appear in a FROM clause. */
  queryable?: boolean;
}

/**
 * How many objects a single request may cost in describe calls.
 *
 * Each one is a REST round trip (~2 s measured, ~250 KB for Account) and
 * ~900 prompt tokens once trimmed to apiName/type/label. Five keeps the worst
 * case near 10 s and ~5 k tokens — a query joining more than five objects is
 * past what this helper is for.
 */
export const MAX_DESCRIBED_OBJECTS = 5;

/** Longest label phrase matched, in words ("Opportunity Line Item" = 3). */
const MAX_PHRASE_WORDS = 4;

/**
 * Fold a name or phrase to a comparison key: lowercase, and drop everything
 * that is not a letter or digit. `Opportunity Line Item`, `OpportunityLineItem`
 * and `opportunity-line-item` collapse to the same key, and `Invoice__c` in
 * the request matches `Invoice__c` in the catalog.
 */
function foldKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * English plural forms of a folded key, so "accounts" reaches `Account` in an
 * org whose labelPlural is absent or localized differently. Deliberately
 * naive: a wrong guess simply fails to match and the object stays undescribed.
 */
function singularCandidates(key: string): string[] {
  const out = [key];
  if (key.endsWith('ies') && key.length > 3) out.push(`${key.slice(0, -3)}y`);
  if (key.endsWith('ses') || key.endsWith('xes') || key.endsWith('ches'))
    out.push(key.slice(0, -2));
  if (key.endsWith('s') && !key.endsWith('ss')) out.push(key.slice(0, -1));
  return out;
}

/**
 * Index a catalog by API name, singular label and plural label.
 *
 * Labels collide across orgs (several objects answer to "Case" once managed
 * packages are installed), so the first entry to claim a key keeps it, and a
 * later entry can still be reached by its API name — which is never ambiguous.
 */
function indexCatalog(catalog: readonly SObjectCatalogEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of catalog) {
    if (entry.queryable === false) continue;
    for (const alias of [entry.name, entry.label, entry.labelPlural]) {
      if (!alias) continue;
      const key = foldKey(alias);
      if (key && !index.has(key)) index.set(key, entry.name);
    }
  }
  return index;
}

/**
 * Resolve the objects a request names, in order of first appearance.
 *
 * Scans word windows longest-first so a multi-word label wins over its first
 * word ("Opportunity Line Item" is not read as "Opportunity"). The first
 * object found is the one most likely to end up in the FROM clause, which is
 * why order is preserved rather than sorted.
 *
 * @param query - The user's natural-language request.
 * @param catalog - describeGlobal entries for the target org.
 * @param limit - Maximum objects to return. Defaults to {@link MAX_DESCRIBED_OBJECTS}.
 * @returns API names, deduplicated, at most `limit` of them.
 */
export function resolveMentionedObjects(
  query: string,
  catalog: readonly SObjectCatalogEntry[],
  limit: number = MAX_DESCRIBED_OBJECTS,
): string[] {
  if (limit <= 0) return [];
  const index = indexCatalog(catalog);
  const words = query.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  const found: string[] = [];
  const seen = new Set<string>();

  for (let start = 0; start < words.length; start++) {
    const maxLen = Math.min(MAX_PHRASE_WORDS, words.length - start);
    for (let len = maxLen; len >= 1; len--) {
      const phrase = words.slice(start, start + len).join('');
      const match = singularCandidates(foldKey(phrase))
        .map((k) => index.get(k))
        .find((name): name is string => name !== undefined);
      if (!match) continue;
      if (!seen.has(match)) {
        seen.add(match);
        found.push(match);
        if (found.length >= limit) return found;
      }
      // A matched phrase consumes its words: "opportunity line item" must not
      // then also match "line" or "item" on its own.
      start += len - 1;
      break;
    }
  }

  return found;
}
