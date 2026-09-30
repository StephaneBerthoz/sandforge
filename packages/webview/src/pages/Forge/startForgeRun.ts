import type { ForgeExecuteRequest } from '@sandforge/shared';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useForgeStore } from '../../stores/useForgeStore';
import { filesBlockExecute } from './ReviewFilesOption';

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
 * Production Guard and its confirmation, the duplicate-run cooldown, one run
 * at a time — and it meets them on either path.
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
