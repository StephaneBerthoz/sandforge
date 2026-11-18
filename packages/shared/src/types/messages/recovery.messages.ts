import type { BaseMessage } from './base.messages.js';
import type { EnvAuditResult } from '../env.types.js';
import type {
  RecoveryAckPayload,
  RecoveryAuditPayload,
  RecoveryErrorPayload,
  RecoveryOrgPayload,
  RecoveryStatus,
  RecoveryUsersConfigPayload,
  RecoveryUsersList,
  RecoveryUsersRunPayload,
} from '../../schemas/recovery.schema.js';
import type { UsersApplyAnswer, UsersConfig, UsersPlanAnswer } from '../../schemas/users.schema.js';

/*
 * The Back into service page speaks this domain. Every request names its org
 * by its registered entry and answers on `<request>:response`, correlated to
 * it; every refusal or failure on the domain's one error channel,
 * `recovery:error`, by a code the page translates. Payloads are validated by
 * the schemas of `schemas/recovery.schema.ts`, the users' and the audits' by
 * those `sandforge users` and `sandforge env audit` answer with.
 *
 * Nothing here is ever asked of a production org: the extension refuses one
 * before it reads anything, by its registry and by what the org says it is.
 */

/** `recovery:status`. WebView -> Extension. Where the sandbox stands, each step deduced. */
export interface RecoveryStatusRequest extends BaseMessage {
  type: 'recovery:status';
  payload: RecoveryOrgPayload;
}

/** `recovery:users:list`. WebView -> Extension. The users to bring back, read in the sandbox. */
export interface RecoveryUsersListRequest extends BaseMessage {
  type: 'recovery:users:list';
  payload: RecoveryOrgPayload;
}

/** `recovery:users:plan`. WebView -> Extension. What a run of the users chosen would do: nothing written. */
export interface RecoveryUsersPlanRequest extends BaseMessage {
  type: 'recovery:users:plan';
  payload: RecoveryUsersRunPayload;
}

/**
 * `recovery:users:apply`. WebView -> Extension. Set the users up, after a
 * simulation of the same choices: the run plans again and is refused when
 * the org changed since. Its progress comes on `recovery:users:progress`.
 */
export interface RecoveryUsersApplyRequest extends BaseMessage {
  type: 'recovery:users:apply';
  payload: RecoveryUsersRunPayload;
}

/**
 * `recovery:users:cancel`. WebView -> Extension. Stop the run under way on
 * the org: it ends `cancelled` on `recovery:users:apply:response`, with what
 * it wrote before the stop.
 */
export interface RecoveryUsersCancelRequest extends BaseMessage {
  type: 'recovery:users:cancel';
  payload: RecoveryOrgPayload;
}

/** `recovery:users:config:save`. WebView -> Extension. Keep the list for the sandbox's next refresh. */
export interface RecoveryUsersConfigSaveRequest extends BaseMessage {
  type: 'recovery:users:config:save';
  payload: RecoveryUsersConfigPayload;
}

/** `recovery:users:config:export`. WebView -> Extension. Write the list to a `users.json` the person picks. */
export interface RecoveryUsersConfigExportRequest extends BaseMessage {
  type: 'recovery:users:config:export';
  payload: RecoveryUsersConfigPayload;
}

/** `recovery:users:config:import`. WebView -> Extension. Read a `users.json` the person picks. */
export interface RecoveryUsersConfigImportRequest extends BaseMessage {
  type: 'recovery:users:config:import';
  payload: RecoveryOrgPayload;
}

/** `recovery:audit`. WebView -> Extension. Read the deliverability, the jobs and the endpoints: nothing written. */
export interface RecoveryAuditRequest extends BaseMessage {
  type: 'recovery:audit';
  payload: RecoveryAuditPayload;
}

/** `recovery:handoff`. WebView -> Extension. Write the handoff note and open it in the editor. */
export interface RecoveryHandoffRequest extends BaseMessage {
  type: 'recovery:handoff';
  payload: RecoveryOrgPayload;
}

/** `recovery:ack`. WebView -> Extension. Skip a step, mark one done, clear either, or finish. */
export interface RecoveryAckRequest extends BaseMessage {
  type: 'recovery:ack';
  payload: RecoveryAckPayload;
}

/** `recovery:status:response`. Extension -> WebView. */
export interface RecoveryStatusResponse extends BaseMessage {
  type: 'recovery:status:response';
  payload: { status: RecoveryStatus };
}

/** `recovery:users:list:response`. Extension -> WebView. */
export interface RecoveryUsersListResponse extends BaseMessage {
  type: 'recovery:users:list:response';
  payload: RecoveryUsersList;
}

/** `recovery:users:plan:response`. Extension -> WebView. The plan, as `sandforge users plan --json` answers it. */
export interface RecoveryUsersPlanResponse extends BaseMessage {
  type: 'recovery:users:plan:response';
  payload: { orgId: string; plan: UsersPlanAnswer };
}

/** `recovery:users:apply:response`. Extension -> WebView. The run, as `sandforge users apply --json` answers it. */
export interface RecoveryUsersApplyResponse extends BaseMessage {
  type: 'recovery:users:apply:response';
  payload: { orgId: string; applied: UsersApplyAnswer };
}

/** `recovery:users:progress`. Extension -> WebView. Users done of the run under way, correlated to its request. */
export interface RecoveryUsersProgressEvent extends BaseMessage {
  type: 'recovery:users:progress';
  payload: { orgId: string; done: number; total: number };
}

/** `recovery:users:config:save:response`. Extension -> WebView. The list kept, and when. */
export interface RecoveryUsersConfigSaveResponse extends BaseMessage {
  type: 'recovery:users:config:save:response';
  payload: { orgId: string; savedAt: string };
}

/** `recovery:users:config:export:response`. Extension -> WebView. The file written, by its name alone; or the dialog closed. */
export interface RecoveryUsersConfigExportResponse extends BaseMessage {
  type: 'recovery:users:config:export:response';
  payload:
    { status: 'saved'; orgId: string; fileName: string } | { status: 'cancelled'; orgId: string };
}

/**
 * `recovery:users:config:import:response`. Extension -> WebView. The list
 * the file holds, read by `usersConfigSchema` — a file it refuses answers on
 * `recovery:error` —; or the dialog closed.
 */
export interface RecoveryUsersConfigImportResponse extends BaseMessage {
  type: 'recovery:users:config:import:response';
  payload:
    | { status: 'read'; orgId: string; fileName: string; config: UsersConfig }
    | { status: 'cancelled'; orgId: string };
}

/** `recovery:audit:response`. Extension -> WebView. What `sandforge env audit --json` answers of the org. */
export interface RecoveryAuditResponse extends BaseMessage {
  type: 'recovery:audit:response';
  payload: { orgId: string; audit: EnvAuditResult };
}

/** `recovery:handoff:response`. Extension -> WebView. Where the note was written. */
export interface RecoveryHandoffResponse extends BaseMessage {
  type: 'recovery:handoff:response';
  payload: { orgId: string; path: string };
}

/** `recovery:ack:response`. Extension -> WebView. The status once the acknowledgement is kept. */
export interface RecoveryAckResponse extends BaseMessage {
  type: 'recovery:ack:response';
  payload: { status: RecoveryStatus };
}

/** `recovery:error`. Extension -> WebView. A refusal or a failure, by its code. */
export interface RecoveryErrorResponse extends BaseMessage {
  type: 'recovery:error';
  payload: RecoveryErrorPayload;
}
