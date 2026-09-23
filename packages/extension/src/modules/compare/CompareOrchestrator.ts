import type { CompareConfig, CompareResult } from '@sandforge/shared';
import type { MetadataCompare } from './MetadataCompare';
import type { DiffEngine } from './DiffEngine';
import type { CoreServices } from '../../services.js';

/** Dependencies required by the CompareOrchestrator */
export interface CompareDependencies {
  metadataCompare: MetadataCompare;
  diffEngine: DiffEngine;
  /**
   * Injected cross-cutting adapters (telemetry, storage, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/**
 * `work`, or the reason `signal` aborted with as soon as it does. jsforce has
 * no way to take back a request it has sent, so a comparison stopped in the
 * middle of a read would otherwise answer only once that read came back, and
 * answer with a result. What `work` does after that is observed here, and
 * never left unhandled.
 */
function unlessCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Runs a comparison and gathers its result: the diff of every component, the
 * counts, and what the content comparison covered.
 */
export class CompareOrchestrator {
  private readonly deps: CompareDependencies;
  private readonly results: Map<string, CompareResult> = new Map();

  constructor(deps: CompareDependencies) {
    this.deps = deps;
  }

  /**
   * Execute a comparison based on the provided configuration.
   * @param config - The two orgs, the types, and what is left out
   * @param signal - Stops the comparison: it reads nothing more from either
   *   org, and settles at once with the signal's reason rather than a result
   */
  async execute(config: CompareConfig, signal?: AbortSignal): Promise<CompareResult> {
    const startTime = Date.now();

    const { items: diffs, managedLeftOut } = await unlessCancelled(
      this.deps.metadataCompare.compare(
        config.sourceOrgId,
        config.targetOrgId,
        config.componentTypes,
        { includeManaged: config.includeManaged },
        signal,
      ),
      signal,
    );

    const summary = this.deps.diffEngine.computeSummary(diffs);
    const content = this.deps.diffEngine.computeCoverage(
      diffs,
      this.deps.metadataCompare.budget,
      managedLeftOut,
    );
    const duration = Date.now() - startTime;

    const result: CompareResult = {
      configId: config.id,
      sourceOrgId: config.sourceOrgId,
      targetOrgId: config.targetOrgId,
      mode: config.mode,
      summary,
      content,
      diffs,
      timestamp: new Date().toISOString(),
      duration,
    };

    this.results.set(config.id, result);

    return result;
  }

  /** Retrieve the last result for a given config ID */
  getLastResult(configId: string): CompareResult | undefined {
    return this.results.get(configId);
  }
}
