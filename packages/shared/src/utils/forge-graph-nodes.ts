import type { ForgeExecutionResult, ForgeGraphNode } from '../types/forge.types.js';

/**
 * Whether discovery left a node out of the run because its table is empty:
 * counted, and none there. A node whose describe or count failed is left out
 * as well, for its error, which is worth saying.
 *
 * Such tables are most of a graph: a clone of one opportunity between two
 * sandboxes reached 400 objects, 315 of them empty tables left out, and what
 * named or counted the objects of the run from its graph named or counted
 * those with the rest. One rule for every place that sets them apart, so the
 * clone command's summary and a run's report agree on which they are.
 *
 * The error is what tells the two apart, whatever the node's status says:
 * discovery marks a node it could not count failed, and a run then reports it
 * skipped, as it reports every node left out. The Forge page's graph takes the
 * run's statuses, and read by its status alone a node whose count failed was
 * one more empty table there.
 *
 * A node the user left out is not one of them, whatever it counts: a starter
 * template's graph counts every table 0 until the run reads it, and a table
 * unchecked there read as one discovery had found empty. Nor is a node whose
 * count nobody took, however it came to be left out: its zero is a
 * placeholder, and the table may hold rows.
 */
export function leftOutAsEmptyTable(
  node: Pick<
    ForgeGraphNode,
    'included' | 'recordCount' | 'recordCountUnknown' | 'status' | 'errors' | 'leftOutByUser'
  >,
): boolean {
  return (
    !node.included &&
    node.leftOutByUser !== true &&
    node.recordCountUnknown !== true &&
    node.recordCount === 0 &&
    node.status !== 'error' &&
    node.errors.length === 0
  );
}

/**
 * Whether the user left a node out of the run on the Forge page, rather than
 * discovery leaving it out for an empty table or an error.
 *
 * A run holds back the rows that cannot be written without such an object, as
 * it does for an object excluded by name, and says what leaving it out cost;
 * a node discovery left out it only skips. Unmarked, a node unchecked on the
 * page was skipped the same way, its dependents sent, and each refused by the
 * target. A node discovery could not describe or count stays discovery's
 * even once the user checked and unchecked it again: the run could not read
 * it either way, and its error says why.
 */
export function leftOutByTheUser(
  node: Pick<ForgeGraphNode, 'included' | 'leftOutByUser' | 'errors'>,
): boolean {
  return !node.included && node.leftOutByUser === true && node.errors.length === 0;
}

/**
 * The objects a Forge run read or wrote that its graph holds no node of, in
 * the order its result first names them.
 *
 * A run adds to the graph discovery built: the catalog its lines cannot go
 * without when discovery stopped at its cap before it, the selling model
 * options its prices need, a parent an orphan needed. Their rows are in the
 * run's counts, its log and what removing it takes back — the result names
 * them where it names what the run read, what it could not read and what it
 * wrote — and what listed the objects of a run from its graph alone had no
 * row for them. One list for every place that sets them beside the graph's,
 * so the results page and a run's report name the same objects.
 */
export function objectsBeyondTheGraph(
  run: Pick<
    ForgeExecutionResult,
    'readByObject' | 'failedReads' | 'idRemapByObject' | 'idRemapCreated'
  >,
  nodes: ReadonlyArray<Pick<ForgeGraphNode, 'objectApiName'>>,
): string[] {
  const inGraph = new Set(nodes.map((node) => node.objectApiName));
  const named = [
    ...(run.readByObject ?? []).map((read) => read.objectApiName),
    ...(run.failedReads ?? []),
    ...(run.idRemapByObject ?? []).map((mapped) => mapped.objectApiName),
    ...(run.idRemapCreated ?? []).map((created) => created.objectApiName),
  ];
  return [...new Set(named)].filter((objectApiName) => !inGraph.has(objectApiName));
}
