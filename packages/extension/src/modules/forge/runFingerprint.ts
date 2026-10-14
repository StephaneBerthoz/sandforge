import { createHash } from 'node:crypto';
import { leftOutAsEmptyTable, type ForgeGraph, type ForgeGraphNode } from '@sandforge/shared';

/**
 * The fingerprint of a Forge run's setup: what a run that resumes another
 * must share with it, or it would read and write otherwise than the part it
 * goes on from — another object left in or out, another filter, another
 * decision on the rows, another method of anonymization, another ceiling, or
 * other orgs.
 *
 * Of the graph, its shape: the objects it takes and the fields each
 * anonymizes, the objects left out, the lookups between them. Not what
 * discovery counted, which the source changes from one day to the next and
 * which reads nothing differently — nor whether a table was empty when it
 * was counted, which that count alone decides: a table counted empty is one
 * the run reads once it holds rows. Run between the two Developer Editions,
 * another check put three opportunities in the source, none under the record
 * cloned, and took them out again: the clone's dry run counted the
 * opportunities' table holding rows, its real run three minutes later found
 * it empty. Taken for an object left in or out, a run stopped in between
 * could not have been taken up. Of the rest, what the caller hands over,
 * keys in any order: a setup said in another order is the same setup.
 */
export function forgeRunFingerprint(graph: ForgeGraph, setup: unknown): string {
  return fingerprintOf(graph, setup, (node) => node.included || leftOutAsEmptyTable(node));
}

/**
 * Whether `fingerprint`, kept in a run's journal, is the fingerprint of this
 * graph and setup: as {@link forgeRunFingerprint} takes it, or as a journal
 * written before an empty table counted as a table the run takes did, by
 * whether discovery included each object. A run stopped under the earlier
 * fingerprint is taken up all the same, from a graph discovery built alike.
 */
export function sameRunSetup(fingerprint: string, graph: ForgeGraph, setup: unknown): boolean {
  return (
    fingerprint === forgeRunFingerprint(graph, setup) ||
    fingerprint === fingerprintOf(graph, setup, (node) => node.included)
  );
}

/** The fingerprint of `graph` and `setup`, each object taken or left out as `taken` says. */
function fingerprintOf(
  graph: ForgeGraph,
  setup: unknown,
  taken: (node: ForgeGraphNode) => boolean,
): string {
  const nodes = graph.nodes
    .map((node) => ({
      objectApiName: node.objectApiName,
      included: taken(node),
      anonymizeFields: [...(node.anonymizeFields ?? [])].sort(),
    }))
    .sort((a, b) => a.objectApiName.localeCompare(b.objectApiName));
  const edges = graph.edges
    .map((edge) => ({
      sourceObject: edge.sourceObject,
      targetObject: edge.targetObject,
      relationshipName: edge.relationshipName,
      required: edge.required === true,
    }))
    .sort((a, b) =>
      `${a.sourceObject}|${a.targetObject}|${a.relationshipName}`.localeCompare(
        `${b.sourceObject}|${b.targetObject}|${b.relationshipName}`,
      ),
    );
  return createHash('sha256').update(canonicalJson({ nodes, edges, setup })).digest('hex');
}

/** `value` as JSON, every object's keys in order, `undefined` left out as JSON leaves it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
