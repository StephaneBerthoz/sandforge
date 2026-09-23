import type {
  AuditAction,
  DataLineageGraph,
  LineageEdge,
  LineageNode,
  LineageOrigin,
  LineageRunSummary,
} from '@sandforge/shared';

import type { ConfigStore } from '../../core/storage/ConfigStore.js';

/** Runs whose lineage is kept; the oldest are dropped past it. */
export const LINEAGE_LIMIT = 100;

/** Where the graphs live: one array, oldest first, as the sync history keeps its runs. */
const LINEAGE_KEY = 'lineage:runs';
const LINEAGE_CATEGORY = 'lineage';

/** What a lineage graph is built from: one run, reduced to counts. */
export interface LineageInput {
  operationId: string;
  module: string;
  action: AuditAction;
  /** Where the records came from. */
  source: { origin: LineageOrigin; label: string; orgId?: string };
  /** The org they went to. */
  target: { label: string; orgId: string };
  /** Per object, the records the run carried from the source to the target. */
  objects: ReadonlyArray<{ objectApiName: string; records: number }>;
  generatedAt: string;
}

/**
 * The lineage of one run: its source, one node per object it carried records
 * of, and the org it wrote.
 *
 * Counts, never ids. A run that keeps a source→target id map — Forge's
 * remapper, a clone's mappings, a frozen dataset's reference-id mapping — is
 * counted from that map, so a node says how many records now have a
 * counterpart in the target; but the map itself stays with the run. A lineage
 * that listed every pair would be a copy of the org's keys, kept outside it.
 *
 * @returns `null` when the run carried nothing: a graph with no object between
 *   its two ends would say data moved where none did.
 */
export function buildLineageGraph(input: LineageInput): DataLineageGraph | null {
  const carried = input.objects.filter((o) => o.records > 0);
  if (carried.length === 0) return null;

  const sourceId = 'source';
  const targetId = 'target';
  const nodes: LineageNode[] = [
    {
      id: sourceId,
      type: 'source',
      label: input.source.label,
      origin: input.source.origin,
      ...(input.source.orgId ? { orgId: input.source.orgId } : {}),
    },
  ];
  const edges: LineageEdge[] = [];
  for (const object of carried) {
    const objectId = `object:${object.objectApiName}`;
    nodes.push({
      id: objectId,
      type: 'object',
      label: object.objectApiName,
      objectApiName: object.objectApiName,
      recordCount: object.records,
    });
    edges.push({ sourceId, targetId: objectId });
    edges.push({ sourceId: objectId, targetId, recordCount: object.records });
  }
  nodes.push({
    id: targetId,
    type: 'destination',
    label: input.target.label,
    orgId: input.target.orgId,
    origin: 'org',
  });

  return {
    nodes,
    edges,
    operationId: input.operationId,
    generatedAt: input.generatedAt,
    module: input.module,
    action: input.action,
  };
}

/**
 * The lineage graphs of the latest runs, kept across restarts.
 *
 * In ConfigStore, where every history of this product lives. Bounded, because
 * ConfigStore is one blob that VS Code serializes whole on every write: an
 * unbounded list would grow the cost of every unrelated setting saved.
 */
export class LineageStore {
  /**
   * @param configStore - The window's store.
   * @param limit - Graphs kept; the oldest are dropped past it.
   */
  constructor(
    private readonly configStore: Pick<ConfigStore, 'get' | 'set'>,
    private readonly limit: number = LINEAGE_LIMIT,
  ) {}

  /** Keep a run's graph; a graph already kept for the same run is replaced. */
  save(graph: DataLineageGraph): void {
    const graphs = this.read().filter((g) => g.operationId !== graph.operationId);
    graphs.push(graph);
    this.configStore.set(LINEAGE_KEY, graphs.slice(-this.limit), LINEAGE_CATEGORY);
  }

  /**
   * One run's graph, or the latest one.
   *
   * @param operationId - The run asked for; the latest when omitted.
   * @returns The graph, or `null` when none is kept for it.
   */
  get(operationId?: string): DataLineageGraph | null {
    const graphs = this.read();
    if (operationId === undefined) return graphs[graphs.length - 1] ?? null;
    return graphs.find((g) => g.operationId === operationId) ?? null;
  }

  /** The runs a graph is kept for, newest first. */
  runs(): LineageRunSummary[] {
    return this.read()
      .reverse()
      .map((graph) => ({
        operationId: graph.operationId,
        generatedAt: graph.generatedAt,
        ...(graph.module ? { module: graph.module } : {}),
        ...(graph.action ? { action: graph.action } : {}),
        ...targetLabelOf(graph),
      }));
  }

  /** What is stored, oldest first, with anything unreadable left out. */
  private read(): DataLineageGraph[] {
    const raw = this.configStore.get<unknown>(LINEAGE_KEY);
    return Array.isArray(raw) ? raw.filter(isLineageGraph) : [];
  }
}

/** The destination's label, as a run summary carries it. */
function targetLabelOf(graph: DataLineageGraph): { targetLabel?: string } {
  const target = graph.nodes.find((node) => node.type === 'destination');
  return target ? { targetLabel: target.label } : {};
}

/**
 * Whether a stored value has the shape the page draws. A graph written by an
 * older build, or edited by hand, is skipped rather than handed to a view
 * that would fail on it.
 */
function isLineageGraph(value: unknown): value is DataLineageGraph {
  if (typeof value !== 'object' || value === null) return false;
  const graph = value as Partial<DataLineageGraph>;
  return (
    typeof graph.operationId === 'string' &&
    typeof graph.generatedAt === 'string' &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges)
  );
}
