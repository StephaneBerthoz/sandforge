import { useState } from 'react';
import type {
  BaseMessage,
  EnvAuditResult,
  RecoveryErrorCode,
  RecoveryStatus,
  RecoveryUsersList,
  UsersApplyAnswer,
  UsersConfig,
  UsersPlanAnswer,
} from '@sandforge/shared';
import { useBridgeMutation, type BridgeMutationState } from '../../hooks/useBridgeMutation';
import { useMessageListener } from '../../hooks/useMessageBus';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';

/** How long the status may take: the stores of this machine, and the org's Id, read once. */
const STATUS_TIMEOUT_MS = 60_000;

/** How long a reading of the org may take: its users, a plan of them, the audits. */
const READ_TIMEOUT_MS = 300_000;

/**
 * How long a file dialog may stay open: an export or an import waits for the
 * person to pick the file, as a save does (`useFileSave`).
 */
const DIALOG_TIMEOUT_MS = 15 * 60_000;

/** The error codes of the domain, which the page words: any other is the bridge's own. */
const RECOVERY_ERROR_CODES: ReadonlySet<string> = new Set<RecoveryErrorCode>([
  'INVALID_PAYLOAD',
  'ORG_NOT_FOUND',
  'NOT_CONNECTED',
  'NOT_A_DEVELOPMENT_ORG',
  'ORG_CHANGED',
  'CANCELLED',
  'FAILED',
]);

/** A request's error code when it is one of the domain's, which the page words in its language. */
export function recoveryErrorCodeOf(errorCode: string | null): RecoveryErrorCode | null {
  return errorCode !== null && RECOVERY_ERROR_CODES.has(errorCode)
    ? (errorCode as RecoveryErrorCode)
    : null;
}

/** What `recovery:users:config:export` answers. */
export type UsersExportAnswer =
  { status: 'saved'; orgId: string; fileName: string } | { status: 'cancelled'; orgId: string };

/** What `recovery:users:config:import` answers. */
export type UsersImportAnswer =
  | { status: 'read'; orgId: string; fileName: string; config: UsersConfig }
  | { status: 'cancelled'; orgId: string };

/** The requests of the Back into service page, each correlated to the request that asked it. */
export interface RecoveryBridge {
  status: BridgeMutationState<{ status: RecoveryStatus }>;
  ack: BridgeMutationState<{ status: RecoveryStatus }>;
  audit: BridgeMutationState<{ orgId: string; audit: EnvAuditResult }>;
  handoff: BridgeMutationState<{ orgId: string; path: string }>;
}

/** The status of a sandbox, its acknowledgements, its audits and its handoff note. */
export function useRecoveryBridge(): RecoveryBridge {
  const status = useBridgeMutation<{ status: RecoveryStatus }>('recovery:status', {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  const ack = useBridgeMutation<{ status: RecoveryStatus }>('recovery:ack');
  const audit = useBridgeMutation<{ orgId: string; audit: EnvAuditResult }>('recovery:audit', {
    timeoutMs: READ_TIMEOUT_MS,
  });
  const handoff = useBridgeMutation<{ orgId: string; path: string }>('recovery:handoff', {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  return { status, ack, audit, handoff };
}

/** The requests of the users step: list, simulate, apply with its progress, and the list's file. */
export interface RecoveryUsersBridge {
  list: BridgeMutationState<RecoveryUsersList>;
  plan: BridgeMutationState<{ orgId: string; plan: UsersPlanAnswer }>;
  apply: BridgeMutationState<{ orgId: string; applied: UsersApplyAnswer }>;
  save: BridgeMutationState<{ orgId: string; savedAt: string }>;
  exportList: BridgeMutationState<UsersExportAnswer>;
  importList: BridgeMutationState<UsersImportAnswer>;
  /** Users done of the run under way, as it said last: its own, by the id of its request. */
  progress: { done: number; total: number } | null;
}

/**
 * The users step's requests. A run's progress is told apart by the id of the
 * request that started it: every panel hears every push message.
 */
export function useRecoveryUsersBridge(): RecoveryUsersBridge {
  const list = useBridgeMutation<RecoveryUsersList>('recovery:users:list', {
    timeoutMs: READ_TIMEOUT_MS,
  });
  const plan = useBridgeMutation<{ orgId: string; plan: UsersPlanAnswer }>('recovery:users:plan', {
    timeoutMs: READ_TIMEOUT_MS,
  });
  // A run goes on in the extension until it ends, and answers then.
  const apply = useBridgeMutation<{ orgId: string; applied: UsersApplyAnswer }>(
    'recovery:users:apply',
    { timeoutMs: WRITE_RUN_TIMEOUT_MS, runOutlivesWait: true },
  );
  const save = useBridgeMutation<{ orgId: string; savedAt: string }>('recovery:users:config:save');
  const exportList = useBridgeMutation<UsersExportAnswer>('recovery:users:config:export', {
    timeoutMs: DIALOG_TIMEOUT_MS,
  });
  const importList = useBridgeMutation<UsersImportAnswer>('recovery:users:config:import', {
    timeoutMs: DIALOG_TIMEOUT_MS,
  });
  const [progress, setProgress] = useState<{
    requestId: string;
    done: number;
    total: number;
  } | null>(null);
  useMessageListener('recovery:users:progress', (message: BaseMessage) => {
    if (apply.requestId === null || message.correlationId !== apply.requestId) return;
    const payload = (message as BaseMessage & { payload?: { done?: unknown; total?: unknown } })
      .payload;
    if (typeof payload?.done !== 'number' || typeof payload.total !== 'number') return;
    setProgress({ requestId: apply.requestId, done: payload.done, total: payload.total });
  });
  return {
    list,
    plan,
    apply,
    save,
    exportList,
    importList,
    progress:
      progress !== null && progress.requestId === apply.requestId && apply.loading
        ? { done: progress.done, total: progress.total }
        : null,
  };
}
