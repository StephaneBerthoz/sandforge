import type { ForgeConfig, ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** Describe result for an object returned by the org connection. */
export interface ObjectDescribe {
  /** API name of the object. */
  name: string;
  /** Fields on the object. */
  fields: FieldDescribe[];
  /** Child relationships where this object is the parent. */
  childRelationships: ChildRelationship[];
}

/** Describe result for a single field. */
export interface FieldDescribe {
  /** Field API name. */
  name: string;
  /** Salesforce field type (e.g. 'reference', 'string'). */
  type: string;
  /** Objects this field references (non-empty for lookups). */
  referenceTo: string[];
  /** Relationship name, if any. */
  relationshipName: string | null;
  /** Whether this is a master-detail relationship. */
  isMasterDetail: boolean;
}

/** Child relationship descriptor from the parent object describe. */
export interface ChildRelationship {
  /** API name of the child object. */
  childSObject: string;
  /** Field on the child object that holds the relationship. */
  field: string;
  /** Relationship name. */
  relationshipName: string;
  /** Whether deleting the parent cascades to the child. */
  isCascadeDelete: boolean;
}

/** Dependencies for GraphDiscoveryService, injected at construction time. */
export interface GraphDiscoveryDeps {
  /** Describe a Salesforce object by API name. */
  describeObject: (orgId: string, objectApiName: string) => Promise<ObjectDescribe>;
  /** Count records matching a SOQL query. */
  queryCount: (orgId: string, soql: string) => Promise<number>;
  /** Detect PII fields from a list of field describes. */
  detectPII: (fields: FieldDescribe[]) => string[];
  /** Describe all objects in the org (used for record ID prefix resolution). */
  describeGlobal: (orgId: string) => Promise<Array<{ name: string; keyPrefix: string | null }>>;
}

/** Progress event emitted during graph discovery. */
export interface DiscoveryProgressEvent {
  /** API name of the object just discovered. */
  objectApiName: string;
  /** Total count of nodes discovered so far. */
  discoveredCount: number;
  /** Number of objects remaining in the BFS queue. */
  queueRemaining: number;
}

/** Options for the discover method. */
export interface DiscoveryOptions {
  /** Signal to abort discovery early. */
  signal?: AbortSignal;
  /** Callback invoked after each node is discovered. */
  onProgress?: (event: DiscoveryProgressEvent) => void;
  /** Override the default max nodes cap (default: 50). */
  maxNodes?: number;
}

/** Heuristic: estimated MB per record. */
const MB_PER_RECORD = 0.001;
/** Heuristic: estimated seconds per record. */
const SECONDS_PER_RECORD = 0.01;

/** Default maximum number of nodes to discover. */
const DEFAULT_MAX_NODES = 50;

/** Hub/system objects excluded from BFS traversal (still referenced in edges). */
const EXCLUDED_OBJECTS = new Set([
  'User',
  'Group',
  'Profile',
  'UserRole',
  'RecordType',
  'Organization',
  'BusinessProcess',
  'CurrencyType',
  'DandBCompany',
  'DuplicateRecordItem',
  'DuplicateRecordSet',
  'ProcessInstance',
  // Non-queryable virtual objects exposed in describe but unsupported by SOQL
  'AttachedContentDocument',
  'AttachedContentNote',
  'CombinedAttachment',
  'ContentBody',
  'NoteAndAttachment',
  'OwnedContentDocument',
  'EntitySubscription',
  'TopicAssignment',
  'UserRecordAccess',
  'DeclinedEventRelation',
  'UndecidedEventRelation',
  'AcceptedEventRelation',
  'OpenActivity',
  'ActivityHistory',
]);

/** Suffix patterns excluded from BFS traversal. */
const EXCLUDED_SUFFIXES = [
  'History',
  'Feed',
  'Share',
  'ChangeEvent',
  '__hd',
  '__Tag',
];

/** Check whether an object should be excluded from BFS traversal. */
function isExcludedObject(objectName: string): boolean {
  if (EXCLUDED_OBJECTS.has(objectName)) {
    return true;
  }
  return EXCLUDED_SUFFIXES.some((suffix) => objectName.endsWith(suffix));
}

/**
 * Service that discovers the Salesforce dependency graph for a Forge operation.
 *
 * Given a ForgeConfig (record ID or SOQL), performs BFS traversal of object
 * relationships to build a complete ForgeGraph with nodes, edges, and estimates.
 */
export class GraphDiscoveryService {
  private readonly deps: GraphDiscoveryDeps;

  /** @param deps - Injected dependencies for org interaction and PII detection. */
  constructor(deps: GraphDiscoveryDeps) {
    this.deps = deps;
  }

  /**
   * Discover the full dependency graph for the given Forge configuration.
   *
   * @param config - Forge configuration specifying input mode, depth, and source org.
   * @param options - Optional settings for abort, progress reporting, and node cap.
   * @returns The complete ForgeGraph with nodes, edges, and estimates.
   */
  async discover(config: ForgeConfig, options?: DiscoveryOptions): Promise<ForgeGraph> {
    const rootObject = await this.resolveRootObject(config);
    const maxDepth = this.resolveMaxDepth(config);
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;

    const visitedObjects = new Set<string>();
    const nodes: ForgeGraphNode[] = [];
    const edgeMap = new Map<string, ForgeGraphEdge>();
    let skippedDueToCap = 0;

    const addEdge = (e: ForgeGraphEdge): void => {
      if (isExcludedObject(e.sourceObject) || isExcludedObject(e.targetObject)) return;
      if (e.sourceObject === e.targetObject) return;
      const key = `${e.sourceObject}|${e.targetObject}`;
      const existing = edgeMap.get(key);
      if (!existing) {
        edgeMap.set(key, e);
      } else if (e.type === 'master-detail' && existing.type === 'lookup') {
        edgeMap.set(key, e);
      }
    };

    // BFS queue: [objectApiName, currentDepth]
    const queue: Array<[string, number]> = [[rootObject, 0]];
    visitedObjects.add(rootObject);

    while (queue.length > 0) {
      if (options?.signal?.aborted) {
        break;
      }

      const [objectName, depth] = queue.shift()!;

      const describe = await this.deps.describeObject(config.sourceOrgId, objectName);
      let recordCount = 0;
      try {
        recordCount = await this.deps.queryCount(
          config.sourceOrgId,
          `SELECT COUNT() FROM ${assertSoqlIdentifier(objectName)}`,
        );
      } catch {
        // Some objects (e.g. virtual entities) are non-queryable — skip gracefully
      }
      const piiFields = this.deps.detectPII(describe.fields);

      const createableFieldCount = describe.fields.filter((f) => f.type !== 'id').length;

      const node: ForgeGraphNode = {
        objectApiName: objectName,
        recordCount,
        fieldCount: describe.fields.length,
        status: 'idle',
        progress: 0,
        included: !config.skipEmpty || recordCount > 0,
        piiFields,
        anonymizeFields: config.anonymizePII ? piiFields : [],
        level: depth,
        successCount: 0,
        failureCount: 0,
        errors: [],
        createableFieldCount,
        estimatedSizeMB: recordCount * MB_PER_RECORD,
        estimatedApiCalls: Math.ceil(recordCount / 200),
        batchStrategy: 'auto' as const,
      };
      nodes.push(node);

      if (depth < maxDepth) {
        // Field references (lookup/master-detail) — emitted as parent→child
        // edges so insertion topology stays correct (parent must exist before
        // the child that points to it). Excluded targets (User, RecordType, …)
        // are filtered by addEdge so they do not pollute Tarjan SCC.
        for (const field of describe.fields) {
          if (field.referenceTo.length === 0) continue;
          for (const targetObject of field.referenceTo) {
            addEdge({
              sourceObject: targetObject, // parent
              targetObject: objectName,   // child
              relationshipName: field.relationshipName ?? field.name,
              type: field.isMasterDetail ? 'master-detail' : 'lookup',
            });

            if (!visitedObjects.has(targetObject) && !isExcludedObject(targetObject)) {
              visitedObjects.add(targetObject);
              if (nodes.length + queue.length < maxNodes) {
                queue.push([targetObject, depth + 1]);
              } else {
                skippedDueToCap++;
              }
            }
          }
        }

        // Child relationships also emit a parent→child edge — addEdge dedupes
        // against the field.referenceTo edge above so Tarjan no longer sees
        // both directions of the same relationship.
        for (const child of describe.childRelationships) {
          addEdge({
            sourceObject: objectName,            // parent
            targetObject: child.childSObject,    // child
            relationshipName: child.relationshipName,
            type: child.isCascadeDelete ? 'master-detail' : 'lookup',
          });

          if (!visitedObjects.has(child.childSObject) && !isExcludedObject(child.childSObject)) {
            visitedObjects.add(child.childSObject);
            if (nodes.length + queue.length < maxNodes) {
              queue.push([child.childSObject, depth + 1]);
            } else {
              skippedDueToCap++;
            }
          }
        }
      }

      options?.onProgress?.({
        objectApiName: objectName,
        discoveredCount: nodes.length,
        queueRemaining: queue.length,
      });
    }

    const totalRecords = nodes.reduce((sum, n) => sum + n.recordCount, 0);
    const edges = [...edgeMap.values()];

    return {
      nodes,
      edges,
      totalRecords,
      estimatedSizeMB: totalRecords * MB_PER_RECORD,
      estimatedDurationSeconds: totalRecords * SECONDS_PER_RECORD,
      truncated: skippedDueToCap > 0,
    };
  }

  /**
   * Resolve the root object name from the config.
   * For record mode, uses describeGlobal to resolve object type from the record ID prefix.
   * For SOQL mode, parses the FROM clause.
   */
  private async resolveRootObject(config: ForgeConfig): Promise<string> {
    if (config.inputMode === 'record' && config.recordId) {
      const prefix = config.recordId.substring(0, 3);
      const globalDesc = await this.deps.describeGlobal(config.sourceOrgId);
      const match = globalDesc.find(s => s.keyPrefix === prefix);
      if (!match) {
        throw new Error(`No object found for record ID prefix "${prefix}". The ID may not belong to any accessible object in this org.`);
      }
      return match.name;
    }
    if (config.inputMode === 'soql' && config.soqlQuery) {
      return parseObjectFromSOQL(config.soqlQuery);
    }
    throw new Error(`Cannot resolve root object for inputMode "${config.inputMode}". Provide a valid recordId (for "record" mode) or soqlQuery (for "soql" mode).`);
  }

  /** Resolve the maximum BFS traversal depth from the config. */
  private resolveMaxDepth(config: ForgeConfig): number {
    switch (config.depth) {
      case 'direct':
        return 1;
      case 'full':
        return 5;
      case 'custom':
        return config.customDepth ?? 3;
    }
  }
}

/**
 * Parse the object name from a SOQL query's FROM clause.
 * Supports simple queries: SELECT ... FROM ObjectName ...
 */
function parseObjectFromSOQL(soql: string): string {
  const match = /FROM\s+(\w+)/i.exec(soql);
  if (!match) {
    throw new Error('Could not parse object name from SOQL query. Ensure the query uses standard "SELECT ... FROM ObjectName" syntax.');
  }
  return match[1];
}
