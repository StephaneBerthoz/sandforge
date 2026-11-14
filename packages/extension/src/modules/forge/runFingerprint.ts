import { createHash } from 'node:crypto';
import {
  FORGE_SAMPLE_DEFAULTS,
  leftOutAsEmptyTable,
  type ForgeGraph,
  type ForgeGraphNode,
  type ForgeSampleOptions,
} from '@sandforge/shared';
import type { WholeOrgCarriedSample } from '../../core/precheck/ProductionGuard.js';

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
 *
 * A sample of the whole org in the setup — at its top, as the command line
 * gives it, or in its config, as the panel does — is taken as it applies
 * ({@link sampleFingerprintOf}): an option left out is its default, the
 * objects asked whole a set, and a plan replayed its SHA-256 alone
 * (`planSha256`), never its path. The same options draw the same sample
 * however they were said, and the same plan holds the same ids wherever its
 * folder is.
 */
export function forgeRunFingerprint(graph: ForgeGraph, setup: unknown): string {
  return fingerprintOf(graph, setup, (node) => node.included || leftOutAsEmptyTable(node));
}

/**
 * A sample of the whole org as a run's fingerprint takes it: each option as
 * it applies (`FORGE_SAMPLE_DEFAULTS` for one left out), the objects asked
 * whole once each and in order, and the SHA-256 of the plan the run replays
 * — which the caller reads of the plan, the path never. Nothing for a run of
 * every record, whose fingerprint stays as it was.
 *
 * @param planSha256 - The SHA-256 of the plan the run replays, a dry run's
 *   (`--fit-plan`) or the one its journal names; none for a run that draws
 *   its own, which is fingerprinted before it draws.
 */
export function sampleFingerprintOf(
  options: ForgeSampleOptions | undefined,
  planSha256?: string,
): (WholeOrgCarriedSample & { planSha256?: string }) | undefined {
  if (options === undefined) return undefined;
  return { ...sampleOptionsApplied(options), ...(planSha256 ? { planSha256 } : {}) };
}

/**
 * The options of a sample as they apply: each left out at its default
 * (`FORGE_SAMPLE_DEFAULTS`), the objects asked whole once each and in order,
 * and no plan, whose path names nothing the run copies — what the run's
 * fingerprint and its question take of them alike.
 */
export function sampleOptionsApplied(options: ForgeSampleOptions): WholeOrgCarriedSample {
  return {
    ...(options.withinMB !== undefined ? { withinMB: options.withinMB } : {}),
    ...(options.maxTotal !== undefined ? { maxTotal: options.maxTotal } : {}),
    seed: options.seed ?? FORGE_SAMPLE_DEFAULTS.seed,
    draw: options.draw ?? FORGE_SAMPLE_DEFAULTS.draw,
    parents: options.parents ?? FORGE_SAMPLE_DEFAULTS.parents,
    children: options.children ?? FORGE_SAMPLE_DEFAULTS.children,
    floor: options.floor ?? FORGE_SAMPLE_DEFAULTS.floor,
    whole: [...new Set(options.whole ?? [])].sort(),
  };
}

/** A plain object, as a setup and its config are. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A sample as a setup holds it, taken as {@link sampleFingerprintOf} takes it. */
function sampleAsApplied(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sha = typeof value.planSha256 === 'string' ? value.planSha256 : undefined;
  return sampleFingerprintOf(value as ForgeSampleOptions, sha);
}

/** `setup` with the sample it holds, at its top or in its config, as it applies. */
function withSampleAsApplied(setup: unknown): unknown {
  if (!isRecord(setup)) return setup;
  const config = setup.config;
  return {
    ...setup,
    ...('sample' in setup ? { sample: sampleAsApplied(setup.sample) } : {}),
    ...(isRecord(config) && 'sample' in config
      ? { config: { ...config, sample: sampleAsApplied(config.sample) } }
      : {}),
  };
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
  return createHash('sha256')
    .update(canonicalJson({ nodes, edges, setup: withSampleAsApplied(setup) }))
    .digest('hex');
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
