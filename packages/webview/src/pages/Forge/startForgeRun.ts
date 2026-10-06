import type { ForgeExecuteRequest } from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useForgeStore } from '../../stores/useForgeStore';
import { filesBlockExecute } from './ReviewFilesOption';
import { useForgeRunGateStore } from './runGate';

/** How a run is started. */
export interface StartForgeRunOptions {
  /**
   * Started with no stop on the discovery and Review screens (Clone
   * directly): the execution screen says the review was skipped.
   */
  reviewSkipped?: boolean;
}

/**
 * Start the run of the graph and config the store holds, and show it.
 *
 * Review's Execute and Clone directly both start their run here, so the
 * second sends exactly what the first does: the graph as it stands — the
 * objects included, the fields to anonymize on each — the config, the method
 * chosen for each personal-data category, and the files only once their copy
 * was turned on. Every guard the run then meets is the extension's —
 * Production Guard, the run's gate (a production target refused, what the
 * target runs on insert and what the run is about to write put to the user in
 * VS Code), the duplicate-run cooldown, one run at a time — and it meets them
 * on either path. A run stopped at its gate comes back to Review, which says
 * why (`runGate`).
 *
 * The phase switch alone is not enough: ForgeExecution renders mission
 * control and then waits on `forge:progress`, which the extension only ever
 * emits from inside its `forge:execute` handler. Without this request the run
 * never starts and the view spins indefinitely.
 *
 * @returns whether the run was sent: not while the store holds no graph or no
 * config, nor while the files wait to be accepted as they are.
 */
export function startForgeRun(options: StartForgeRunOptions = {}): boolean {
  const state = useForgeStore.getState();
  const { graph, config } = state;
  if (!graph || !config || filesBlockExecute(state)) return false;
  // Clear the previous run's node statuses first: they live as long as the
  // panel, so a run after an abort opened already half "done" and sat there.
  state.resetNodeStatuses();
  // Why the run before stopped at its gate is that run's: this one has its own.
  useForgeRunGateStore.getState().clear();
  const { anonymizationRules, fileCopy } = useForgeStore.getState();
  // The methods chosen in the Anonymization tab go with the run: the fields
  // travel on the graph's nodes, and the run used to receive only those, so
  // every category was written with no method at all. So does the choice
  // to copy the files, which is not part of the config.
  const requestId = sendBridgeMessage<ForgeExecuteRequest['payload']>('forge:execute', {
    graph,
    config,
    anonymizationRules,
    ...(fileCopy.enabled
      ? {
          files: {
            maxFileSizeMB: fileCopy.maxFileSizeMB,
            acceptedAsIs: fileCopy.acceptedAsIs,
          },
        }
      : {}),
  });
  // Mission control takes only the messages correlated to this request.
  const store = useForgeStore.getState();
  store.setExecutionRequestId(requestId);
  if (options.reviewSkipped) store.markReviewSkipped();
  store.setPhase('execution');
  return true;
}
