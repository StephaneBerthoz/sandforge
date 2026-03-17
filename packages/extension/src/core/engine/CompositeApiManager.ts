/** HTTP method for a composite subrequest */
export type CompositeHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A single subrequest in a Composite API call */
export interface CompositeRequest {
  referenceId: string;
  method: CompositeHttpMethod;
  url: string;
  body?: Record<string, unknown>;
}

/** Result of a single subrequest */
export interface CompositeResult {
  referenceId: string;
  httpStatusCode: number;
  body: Record<string, unknown>;
}

/** A graph in the Composite Graph API */
export interface CompositeGraph {
  graphId: string;
  compositeRequest: CompositeRequest[];
}

/** Result of a single graph */
export interface CompositeGraphResult {
  graphId: string;
  graphResponse: {
    compositeResponse: CompositeResult[];
  };
}

/** Strategy selected for execution */
export type CompositeStrategy = 'composite' | 'compositeGraph';

/**
 * Manages Salesforce Composite and Composite Graph API calls.
 *
 * - Composite API supports up to 25 subrequests per call.
 * - Composite Graph API supports up to 500 nodes across multiple graphs.
 * - Auto-selects the appropriate strategy based on request count.
 * - Handles reference IDs between subrequests.
 * - Parses composite responses and maps errors to individual records.
 */
export class CompositeApiManager {
  private static readonly COMPOSITE_LIMIT = 25;
  private static readonly GRAPH_LIMIT = 500;

  /** Determine which strategy to use based on request count */
  selectStrategy(requestCount: number): CompositeStrategy {
    if (requestCount <= CompositeApiManager.COMPOSITE_LIMIT) {
      return 'composite';
    }
    return 'compositeGraph';
  }

  /** Get the maximum subrequests for the Composite API */
  getCompositeLimit(): number {
    return CompositeApiManager.COMPOSITE_LIMIT;
  }

  /** Get the maximum nodes for the Composite Graph API */
  getGraphLimit(): number {
    return CompositeApiManager.GRAPH_LIMIT;
  }

  /**
   * Execute composite requests using the appropriate strategy.
   * Splits into batches if needed and delegates to the provided executor.
   */
  async execute(
    requests: CompositeRequest[],
    executor: (batch: CompositeRequest[]) => Promise<CompositeResult[]>
  ): Promise<CompositeResult[]> {
    if (requests.length === 0) {
      return [];
    }

    const strategy = this.selectStrategy(requests.length);

    if (strategy === 'composite') {
      return executor(requests);
    }

    // For graph strategy, split into batches of COMPOSITE_LIMIT
    const batches = this.splitIntoBatches(requests, CompositeApiManager.COMPOSITE_LIMIT);
    const allResults: CompositeResult[] = [];

    for (const batch of batches) {
      const batchResults = await executor(batch);
      allResults.push(...batchResults);
    }

    return allResults;
  }

  /** Build a Composite API request body */
  buildCompositeBody(requests: CompositeRequest[]): {
    allOrNone: boolean;
    compositeRequest: CompositeRequest[];
  } {
    return {
      allOrNone: false,
      compositeRequest: requests.slice(0, CompositeApiManager.COMPOSITE_LIMIT),
    };
  }

  /** Build a Composite Graph API request body */
  buildGraphBody(requests: CompositeRequest[]): {
    graphs: CompositeGraph[];
  } {
    const batches = this.splitIntoBatches(requests, CompositeApiManager.COMPOSITE_LIMIT);
    const graphs: CompositeGraph[] = batches.map((batch, index) => ({
      graphId: `graph-${index}`,
      compositeRequest: batch,
    }));

    return { graphs };
  }

  /** Parse a composite response and extract results mapped by referenceId */
  parseCompositeResponse(
    response: CompositeResult[]
  ): Map<string, CompositeResult> {
    const resultMap = new Map<string, CompositeResult>();
    for (const result of response) {
      resultMap.set(result.referenceId, result);
    }
    return resultMap;
  }

  /** Parse a graph response and flatten into individual results */
  parseGraphResponse(
    graphResults: CompositeGraphResult[]
  ): CompositeResult[] {
    const results: CompositeResult[] = [];
    for (const graph of graphResults) {
      results.push(...graph.graphResponse.compositeResponse);
    }
    return results;
  }

  /** Extract errors from composite results (non-2xx status codes) */
  extractErrors(results: CompositeResult[]): CompositeResult[] {
    return results.filter(
      (r) => r.httpStatusCode < 200 || r.httpStatusCode >= 300
    );
  }

  /** Check if all results are successful */
  isAllSuccessful(results: CompositeResult[]): boolean {
    return results.every(
      (r) => r.httpStatusCode >= 200 && r.httpStatusCode < 300
    );
  }

  /** Generate a unique reference ID for a subrequest */
  generateReferenceId(objectName: string, index: number): string {
    return `${objectName}_${index}`;
  }

  /** Resolve a reference expression like @{RefId.Id} */
  resolveReference(referenceId: string, field: string): string {
    return `@{${referenceId}.${field}}`;
  }

  /** Validate that requests don't exceed the graph limit */
  validate(requests: CompositeRequest[]): { valid: boolean; error?: string } {
    if (requests.length === 0) {
      return { valid: true };
    }
    if (requests.length > CompositeApiManager.GRAPH_LIMIT) {
      return {
        valid: false,
        error: `Request count ${requests.length} exceeds maximum of ${CompositeApiManager.GRAPH_LIMIT}`,
      };
    }

    const refIds = new Set<string>();
    for (const req of requests) {
      if (refIds.has(req.referenceId)) {
        return {
          valid: false,
          error: `Duplicate referenceId: ${req.referenceId}`,
        };
      }
      refIds.add(req.referenceId);
    }

    return { valid: true };
  }

  /** Split requests into batches of the given size */
  private splitIntoBatches(
    requests: CompositeRequest[],
    batchSize: number
  ): CompositeRequest[][] {
    const batches: CompositeRequest[][] = [];
    for (let i = 0; i < requests.length; i += batchSize) {
      batches.push(requests.slice(i, i + batchSize));
    }
    return batches;
  }
}
