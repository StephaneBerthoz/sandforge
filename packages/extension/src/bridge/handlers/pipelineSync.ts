import { AsyncLocalStorage } from 'node:async_hooks';

import type { SyncConfig, SyncExecutionResult } from '@sandforge/shared';

import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type {
  GivenAnswer,
  OperationRequest,
  ProductionGuard,
} from '../../core/precheck/ProductionGuard.js';
import { withGivenAnswer } from '../../core/precheck/ProductionGuard.js';
import type { SyncGuardVerdict } from './pipelineSteps.js';

/**
 * How a pipeline's Sync step runs a saved configuration: through Sync's own
 * scheduled run, which validates the configuration, consults Production
 * Guard, registers in Live Operations and records the run in Sync's history
 * and the audit trail, as a pipeline's. Nothing here writes; it says
 * beforehand what the guard will do, from the request Sync's run judges
 * itself by (`syncGuardRequest`), and carries the step's answer and its
 * cancel to that run.
 */

/**
 * What the guard does with `request`, read from its check alone: nothing is
 * asked and nothing is recorded. No guard at all refuses, as Sync's run does.
 * @param guard - The window's guard, when it has one
 * @param request - The run as the guard is to judge it
 */
export function syncGuardVerdict(
  guard: Pick<ProductionGuard, 'check'> | undefined,
  request: OperationRequest,
): SyncGuardVerdict {
  if (!guard) {
    return { decision: 'refused', reason: 'no Production Guard runs in this window' };
  }
  const check = guard.check(request);
  if (!check.allowed) {
    return { decision: 'refused', reason: check.blockedReason ?? check.impactSummary };
  }
  return check.requiresConfirmation ? { decision: 'asks' } : { decision: 'allowed' };
}

/** What a pipeline's Sync step runs on. */
export interface PipelineSyncDeps {
  /** Sync's unattended run of a configuration (`SyncOpsHandler.executeScheduled`), as a pipeline's. */
  execute: (config: SyncConfig) => Promise<SyncExecutionResult>;
  /**
   * Where that run registers. A cancel of the pipeline reaches the run
   * through it, as Cancel in Live Operations does.
   */
  registry?: Pick<BackgroundOperationRegistry, 'onEvent' | 'abort'>;
}

/**
 * The Sync run each pipeline step started, by async call chain: the run
 * registers itself from within the step's call, and only that call carries
 * the step's mark. A Sync started from its page or by its schedule at the
 * same moment does not.
 */
const stepRuns = new AsyncLocalStorage<symbol>();

/**
 * Run `config` as Sync's schedule runs it, with `answer` standing for the
 * guard's question, and stop it when `signal` aborts.
 *
 * Sync's run makes up its own operation id, and says it to nobody but the
 * registry where it registers. The step's cancel used to stop only the wait:
 * the pipeline ended cancelled while its Sync went on writing.
 * @param deps - Sync's run, and the registry it registers in
 * @param config - The saved configuration
 * @param answer - The Approval step's answer, or that nobody approved
 * @param signal - The step's: aborted, the run is cancelled
 */
export async function runPipelineSync(
  deps: PipelineSyncDeps,
  config: SyncConfig,
  answer: GivenAnswer,
  signal?: AbortSignal,
): Promise<SyncExecutionResult> {
  const mark = Symbol('pipeline sync');
  let operationId: string | undefined;
  const stopListening = deps.registry?.onEvent((id, type, operation) => {
    if (type !== 'started' || operation.module !== 'sync' || stepRuns.getStore() !== mark) return;
    operationId = id;
    // Cancelled while the guard was consulted: the run stops as it starts.
    if (signal?.aborted) deps.registry?.abort(id);
  });
  const onAbort = (): void => {
    if (operationId !== undefined) deps.registry?.abort(operationId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await stepRuns.run(mark, () => withGivenAnswer(answer, () => deps.execute(config)));
  } finally {
    stopListening?.();
    signal?.removeEventListener('abort', onAbort);
  }
}
