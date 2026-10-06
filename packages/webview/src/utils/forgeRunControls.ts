/**
 * The controls of a run Review holds beside the decisions on its gaps: the
 * fields an object's rows leave out, the filter its read is held to, the cap
 * on every object's records, the owners mapped from source users to target
 * ones, the fields written under another name; and the branch of the graph a
 * node takes out with it.
 *
 * Each lives in the config, as a decision does: the run, its retry, a
 * template and a past run carry it, and the controls read it back from there.
 * A config that holds none of a kind says nothing of it.
 */
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { forgeConfigSchema } from '@sandforge/shared';

/** The parts of a config the controls write, each checked by the schema the run is checked by. */
export type ForgeControlKey =
  | 'fieldExclusions'
  | 'objectSoqlFilters'
  | 'maxRecordsPerObject'
  | 'ownerMappings'
  | 'fieldMappings';

/**
 * Whether the schema the extension checks a run's config by refuses the part
 * `key` of `config`: a filter with a comment marker, more owners than it
 * takes, an id that is none. A config it refuses is refused whole, with
 * nothing written, so a control holds the change back and says why.
 */
export function controlRefused(config: ForgeConfig, key: ForgeControlKey): boolean {
  return !forgeConfigSchema.shape[key].safeParse(config[key]).success;
}

/** The rule one object's filter is held to, as the schema holds every filter. */
const FILTER_RULE = forgeConfigSchema.shape.objectSoqlFilters.unwrap().valueType;

/** Whether `where` is a filter the schema takes: 512 characters at most, no comment marker, no trailing semicolon. */
export function filterAllowed(where: string): boolean {
  return FILTER_RULE.safeParse(where).success;
}

/** `config` with `key` set to `map`, or without `key` when the map is empty. */
function withMap<K extends 'objectSoqlFilters' | 'ownerMappings' | 'fieldMappings'>(
  config: ForgeConfig,
  key: K,
  map: NonNullable<ForgeConfig[K]>,
): ForgeConfig {
  const next: ForgeConfig = { ...config };
  if (Object.keys(map).length > 0) next[key] = map;
  else delete next[key];
  return next;
}

/** `config` with `object`'s read held to `where`, or to nothing for null or a blank text. */
export function withObjectFilter(
  config: ForgeConfig,
  object: string,
  where: string | null,
): ForgeConfig {
  const filters = { ...config.objectSoqlFilters };
  const clause = where?.trim() ?? '';
  if (clause !== '') filters[object] = clause;
  else delete filters[object];
  return withMap(config, 'objectSoqlFilters', filters);
}

/** `config` with every object's records capped at `cap`, or with no cap. */
export function withRecordCap(config: ForgeConfig, cap: number | undefined): ForgeConfig {
  const next: ForgeConfig = { ...config };
  if (cap !== undefined) next.maxRecordsPerObject = cap;
  else delete next.maxRecordsPerObject;
  return next;
}

/** `config` with the records `sourceId` owns given to `targetId`, or no longer mapped (null). */
export function withOwnerMapping(
  config: ForgeConfig,
  sourceId: string,
  targetId: string | null,
): ForgeConfig {
  const owners = { ...config.ownerMappings };
  if (targetId !== null) owners[sourceId] = targetId;
  else delete owners[sourceId];
  return withMap(config, 'ownerMappings', owners);
}

/** `config` with `object`'s field `from` written under `to`, or under its own name again (null). */
export function withFieldRename(
  config: ForgeConfig,
  object: string,
  from: string,
  to: string | null,
): ForgeConfig {
  const mappings = { ...config.fieldMappings };
  const renames = { ...mappings[object] };
  if (to !== null) renames[from] = to;
  else delete renames[from];
  if (Object.keys(renames).length > 0) mappings[object] = renames;
  else delete mappings[object];
  return withMap(config, 'fieldMappings', mappings);
}

/**
 * The branch of the graph `objectApiName` heads: the object, and every object
 * under it — through the lookups and master-details the graph follows from a
 * parent to a child — that no other way from the top of the graph reaches.
 * The top is the run's root (level 0) and every object no edge points at.
 * Leaving the branch out leaves out nothing reachable without it.
 */
export function branchOf(graph: ForgeGraph, objectApiName: string): string[] {
  const children = new Map<string, string[]>();
  const pointedAt = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.sourceObject === edge.targetObject) continue;
    const list = children.get(edge.sourceObject) ?? [];
    list.push(edge.targetObject);
    children.set(edge.sourceObject, list);
    pointedAt.add(edge.targetObject);
  }
  const walk = (from: readonly string[], blocked?: string): Set<string> => {
    const seen = new Set<string>();
    const toVisit = from.filter((name) => name !== blocked);
    for (let next = toVisit.pop(); next !== undefined; next = toVisit.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      for (const child of children.get(next) ?? []) {
        if (child !== blocked && !seen.has(child)) toVisit.push(child);
      }
    }
    return seen;
  };
  const tops = graph.nodes
    .filter((node) => node.level === 0 || !pointedAt.has(node.objectApiName))
    .map((node) => node.objectApiName);
  const reachedWithout = walk(tops, objectApiName);
  const under = walk([objectApiName]);
  const known = new Set(graph.nodes.map((node) => node.objectApiName));
  return [...under].filter(
    (name) => known.has(name) && (name === objectApiName || !reachedWithout.has(name)),
  );
}
