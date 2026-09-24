import {
  PRICEBOOK_ENTRY_OBJECT,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
} from '../constants/standard-pricebook.js';
import { STATUS_NEEDS_CHILDREN } from '../constants/status-children.js';
import type { ForgeGraph } from '../types/forge.types.js';
import { leftOutByTheUser } from './forge-graph-nodes.js';

/** What leaving an object out of a Forge run costs an object the run writes. */
export interface ForgeLeftOutCost {
  /** The object the user left out. */
  leftOut: string;
  /** The object the run writes that pays for it. */
  object: string;
  /**
   * What it costs `object`: `lookup`, its records that name a `leftOut` record
   * they may not be written without are not written, save those whose record
   * the target already holds; `status`, its records past Draft are written as
   * drafts and stay drafts, the platform giving them their status only with
   * `leftOut` records under them; `sellingModel`, its prices sold under a
   * selling model are not written, each needing its product's `leftOut` for
   * that model.
   */
  kind: 'lookup' | 'status' | 'sellingModel';
}

/**
 * What the objects the user left out of a Forge run cost the objects it
 * writes, as far as the graph can tell before the run reads a row: the rules
 * the run holds rows back by, over the objects and the lookups discovery
 * found.
 *
 * The run says it too, once it has read the rows: how many it held back, and
 * which records it left drafts. Unchecking the prices on the page said nothing
 * until then, and a clone of an opportunity came back without a line. A graph
 * built without discovery — a starter template's — knows no lookup, and says
 * only what the status and selling model rules tell. The objects discovery
 * left out cost nothing here: an empty table holds no record to need, and one
 * it could not read the run could not read either.
 */
export function leftOutCosts(graph: Pick<ForgeGraph, 'nodes' | 'edges'>): ForgeLeftOutCost[] {
  const leftOut = new Set(graph.nodes.filter(leftOutByTheUser).map((n) => n.objectApiName));
  if (leftOut.size === 0) return [];
  const written = new Set(graph.nodes.filter((n) => n.included).map((n) => n.objectApiName));
  const costs: ForgeLeftOutCost[] = [];
  for (const edge of graph.edges) {
    if (
      edge.required === true &&
      leftOut.has(edge.sourceObject) &&
      written.has(edge.targetObject)
    ) {
      costs.push({ leftOut: edge.sourceObject, object: edge.targetObject, kind: 'lookup' });
    }
  }
  for (const [parent, child] of Object.entries(STATUS_NEEDS_CHILDREN)) {
    if (written.has(parent) && leftOut.has(child.object)) {
      costs.push({ leftOut: child.object, object: parent, kind: 'status' });
    }
  }
  // A price is written under a selling model only when the run carries the
  // models: then each one needs its product's option for that model.
  if (
    written.has(PRICEBOOK_ENTRY_OBJECT) &&
    written.has(SELLING_MODEL_OBJECT) &&
    leftOut.has(SELLING_MODEL_OPTION_OBJECT)
  ) {
    costs.push({
      leftOut: SELLING_MODEL_OPTION_OBJECT,
      object: PRICEBOOK_ENTRY_OBJECT,
      kind: 'sellingModel',
    });
  }
  return costs.sort(
    (a, b) =>
      a.object.localeCompare(b.object) ||
      a.leftOut.localeCompare(b.leftOut) ||
      a.kind.localeCompare(b.kind),
  );
}
