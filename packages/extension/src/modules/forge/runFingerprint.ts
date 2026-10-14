import { createHash } from 'node:crypto';
import type { ForgeGraph } from '@sandforge/shared';

/**
 * The fingerprint of a Forge run's setup: what a run that resumes another
 * must share with it, or it would read and write otherwise than the part it
 * goes on from — another object left in or out, another filter, another
 * decision on the rows, another method of anonymization, another ceiling, or
 * other orgs.
 *
 * Of the graph, its shape: the objects included and the fields each
 * anonymizes, the objects left out, the lookups between them. Not what
 * discovery counted, which the source changes from one day to the next and
 * which reads nothing differently. Of the rest, what the caller hands over,
 * keys in any order: a setup said in another order is the same setup.
 */
export function forgeRunFingerprint(graph: ForgeGraph, setup: unknown): string {
  const nodes = graph.nodes
    .map((node) => ({
      objectApiName: node.objectApiName,
      included: node.included,
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
