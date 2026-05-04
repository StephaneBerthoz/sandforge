import type {
  ObjectNode,
  SeedFieldInfo,
  SeedRelationship,
  ERDData,
  ERDEdge,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** Abstraction over a Salesforce connection for testability. */
export interface SchemaConnection {
  describe(objectName: string): Promise<DescribeResult>;
  queryCount(soql: string): Promise<number>;
}

/** Subset of Salesforce describe result we consume. */
export interface DescribeResult {
  name: string;
  label: string;
  fields: DescribeField[];
}

/** Subset of Salesforce field describe. */
export interface DescribeField {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  defaultValue: unknown;
  picklistValues?: Array<{ value: string; active: boolean }>;
  referenceTo?: string[];
  unique: boolean;
  externalId: boolean;
  length?: number;
  relationshipName?: string;
}

/**
 * Analyzes Salesforce object schemas to produce an ERD graph
 * with topological insertion order and dependency detection.
 */
export class SchemaAnalyzer {
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Analyze the schema for the given objects. */
  async analyzeSchema(conn: SchemaConnection, objectNames: string[]): Promise<ERDData> {
    const describes = await this.describeAll(conn, objectNames);
    const nodeMap = new Map<string, ObjectNode>();
    const edges: ERDEdge[] = [];
    const parentObjectsToAdd = new Set<string>();

    // Build initial nodes from describes
    for (const desc of describes) {
      const fields = this.extractFields(desc);
      const relationships = this.extractRelationships(desc);
      nodeMap.set(desc.name, {
        apiName: desc.name,
        label: desc.label,
        recordCount: 0,
        fields,
        relationships,
      });

      // Collect edges and detect missing parents
      for (const rel of relationships) {
        edges.push({
          source: desc.name,
          target: rel.targetObject,
          field: rel.fieldName,
          type: rel.type,
        });
        if (!objectNames.includes(rel.targetObject)) {
          parentObjectsToAdd.add(rel.targetObject);
        }
      }
    }

    // Auto-add missing parent objects
    if (parentObjectsToAdd.size > 0) {
      const parentDescribes = await this.describeAll(conn, [...parentObjectsToAdd]);
      for (const desc of parentDescribes) {
        const fields = this.extractFields(desc);
        const relationships = this.extractRelationships(desc);
        nodeMap.set(desc.name, {
          apiName: desc.name,
          label: desc.label,
          recordCount: 0,
          fields,
          relationships,
        });
        // Add edges from auto-added parents to their parents
        for (const rel of relationships) {
          edges.push({
            source: desc.name,
            target: rel.targetObject,
            field: rel.fieldName,
            type: rel.type,
          });
        }
      }
    }

    // Fetch record counts in parallel
    await this.fetchRecordCounts(conn, nodeMap);

    const nodes = [...nodeMap.values()];
    const relevantEdges = edges.filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target));

    const { order, cycles } = this.topologicalSort(nodes, relevantEdges);
    const warnings = this.generateWarnings(nodes, relevantEdges, cycles, parentObjectsToAdd);

    return {
      nodes,
      edges: relevantEdges,
      insertionOrder: order,
      circularDeps: cycles,
      warnings,
    };
  }

  /** Describe all objects with concurrency control. */
  private async describeAll(
    conn: SchemaConnection,
    objectNames: string[],
  ): Promise<DescribeResult[]> {
    const results: DescribeResult[] = [];
    const chunks = this.chunk(objectNames, this.maxConcurrent);

    for (const batch of chunks) {
      const settled = await Promise.allSettled(batch.map((name) => conn.describe(name)));
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
    }

    return results;
  }

  /** Extract FieldInfo from describe result. */
  private extractFields(desc: DescribeResult): SeedFieldInfo[] {
    return desc.fields.map((f) => ({
      apiName: f.name,
      label: f.label,
      type: f.type,
      required: !f.nillable && f.defaultValue === null,
      defaultValue: f.defaultValue,
      picklistValues: f.picklistValues?.filter((pv) => pv.active).map((pv) => pv.value),
      referenceTo: f.referenceTo?.[0],
      unique: f.unique,
      externalId: f.externalId,
      maxLength: f.length,
    }));
  }

  /** Extract relationships from describe result. */
  private extractRelationships(desc: DescribeResult): SeedRelationship[] {
    return desc.fields
      .filter(
        (f) =>
          (f.type === 'reference' || f.type === 'masterdetail') &&
          f.referenceTo &&
          f.referenceTo.length > 0,
      )
      .map((f) => ({
        fieldName: f.name,
        targetObject: f.referenceTo![0],
        type: f.type === 'masterdetail' ? ('MasterDetail' as const) : ('Lookup' as const),
        required: f.type === 'masterdetail' || !f.nillable,
      }));
  }

  /** Fetch record counts for all nodes. */
  private async fetchRecordCounts(
    conn: SchemaConnection,
    nodeMap: Map<string, ObjectNode>,
  ): Promise<void> {
    const entries = [...nodeMap.entries()];
    const chunks = this.chunk(entries, this.maxConcurrent);

    for (const batch of chunks) {
      const settled = await Promise.allSettled(
        batch.map(async ([name, node]) => {
          const count = await conn.queryCount(`SELECT COUNT() FROM ${assertSoqlIdentifier(name)}`);
          node.recordCount = count;
        }),
      );
      // Silently ignore count failures
      void settled;
    }
  }

  /**
   * Topological sort with cycle detection.
   * Returns the insertion order and any cycles found.
   */
  private topologicalSort(
    nodes: ObjectNode[],
    edges: ERDEdge[],
  ): { order: string[]; cycles: string[][] } {
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const node of nodes) {
      adjacency.set(node.apiName, []);
      inDegree.set(node.apiName, 0);
    }

    // Edge: source depends on target (source → target means target must come first)
    for (const edge of edges) {
      if (adjacency.has(edge.source) && adjacency.has(edge.target)) {
        adjacency.get(edge.target)!.push(edge.source);
        inDegree.set(edge.source, (inDegree.get(edge.source) ?? 0) + 1);
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) {
        queue.push(name);
      }
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      for (const neighbor of adjacency.get(current) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // Detect cycles: nodes not in the order
    const cycles: string[][] = [];
    const ordered = new Set(order);
    const remaining = nodes.map((n) => n.apiName).filter((n) => !ordered.has(n));

    if (remaining.length > 0) {
      cycles.push(remaining);
      // Append remaining at the end (best effort)
      order.push(...remaining);
    }

    return { order, cycles };
  }

  /** Generate human-readable warnings. */
  private generateWarnings(
    nodes: ObjectNode[],
    edges: ERDEdge[],
    cycles: string[][],
    autoAdded: Set<string>,
  ): string[] {
    const warnings: string[] = [];

    // Warn about auto-added parents
    for (const name of autoAdded) {
      const node = nodes.find((n) => n.apiName === name);
      if (node) {
        const children = edges.filter((e) => e.target === name).map((e) => e.source);
        warnings.push(`${name} auto-added as required parent for ${children.join(', ')}`);
      }
    }

    // Warn about MasterDetail dependencies
    for (const edge of edges) {
      if (edge.type === 'MasterDetail') {
        warnings.push(
          `${edge.source} requires ${edge.target} (MasterDetail) — ${edge.target} must be seeded first`,
        );
      }
    }

    // Warn about circular dependencies
    for (const cycle of cycles) {
      warnings.push(`Circular dependency detected: ${cycle.join(' → ')}`);
    }

    return warnings;
  }

  /** Split an array into chunks of the given size. */
  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
}
