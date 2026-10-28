import type { BaseMessage } from './base.messages.js';
import type {
  CheckpointEmails,
  CheckpointEstimate,
  CheckpointListEntry,
  CheckpointLeftOutObject,
  CheckpointRefusal,
  CheckpointScopeFiles,
  CheckpointScopeMode,
  CheckpointScopeObject,
  CheckpointTakeRequests,
  OrgCheckpoint,
  RewindDiff,
  RewindResult,
} from '../checkpoint.types.js';
import type { ForgeTargetAutomation } from '../forge.types.js';

/*
 * The Checkpoints page and the command line speak this domain. Every request
 * answers on `<request>:response`, and every refusal or failure on the
 * domain's one error channel, `checkpoint:error`, correlated to the request:
 * the page's bridge hooks listen there by default. A take, a rewind and an
 * undo report their progress on the `operation:*` channels, under the
 * operation id their response names.
 *
 * Requests name checkpoints, previews and rewinds by id, never records: what a
 * rewind deletes, gives back and brings back is what its preview confirmed that
 * the org still differs by when it starts.
 */

/**
 * `checkpoint:list`. WebView -> Extension. The checkpoints kept on this
 * machine, of one org or of all, newest first, read without contacting the
 * org: with their validity and the Undo window of the org's last rewind.
 */
export interface CheckpointListRequest extends BaseMessage {
  type: 'checkpoint:list';
  payload?: { orgId?: string };
}

/**
 * `checkpoint:scope`. WebView -> Extension. The objects a take of the org
 * would hold, those its scope leaves out, and what the take would cost: read
 * from the org's describes and counts, nothing kept.
 */
export interface CheckpointScopeRequest extends BaseMessage {
  type: 'checkpoint:scope';
  payload: {
    orgId: string;
    mode: CheckpointScopeMode;
    /** The objects picked; given with `picked` only. */
    objects?: string[];
    /** Objects to leave out, in either mode. */
    excluded?: string[];
    /** The records the take would hold at most, all objects together; 500,000 unless given. */
    maxTotal?: number;
  };
}

/**
 * `checkpoint:take`. WebView -> Extension. Read the org's records and keep
 * them as a checkpoint on this machine. A stopped take is not kept.
 */
export interface CheckpointTakeRequest extends BaseMessage {
  type: 'checkpoint:take';
  payload: {
    orgId: string;
    name: string;
    mode: CheckpointScopeMode;
    /** The objects picked; given with `picked` only. */
    objects?: string[];
    /** Objects to leave out, in either mode. */
    excluded?: string[];
    /**
     * The records it holds at most, all objects together; 500,000 unless
     * given. Past it, the take is refused before a record is read.
     */
    maxTotal?: number;
    /** Days until it expires; 0 keeps it until it is deleted. */
    keepDays: number;
    /** Fields, `Object.Field`, not to compare nor write back. */
    ignoredFields?: string[];
  };
}

/**
 * `checkpoint:preview`. WebView -> Extension. What a rewind to the checkpoint
 * would delete, give back and bring back, who last changed it, and what it and
 * an undo cannot take back: read from the org, nothing written.
 */
export interface CheckpointPreviewRequest extends BaseMessage {
  type: 'checkpoint:preview';
  payload: { checkpointId: string };
}

/**
 * `checkpoint:rewind`. WebView -> Extension. Return the org to the
 * checkpoint: the rewind acts on what the preview named confirmed that still
 * differs when it starts, and leaves, named, what changed since the preview.
 */
export interface CheckpointRewindRequest extends BaseMessage {
  type: 'checkpoint:rewind';
  payload: {
    checkpointId: string;
    previewId: string;
    /** Rewind even though the org runs automation as its records are updated, deleted or brought back. */
    acceptAutomation: boolean;
    /** Rewind even though Undo couldn't bring back records it deletes. */
    acceptNoUndo: boolean;
    /**
     * Make again, with new Ids, the records deleted since that the recycle bin
     * no longer gives back. Without it, a rewind that would writes nothing.
     */
    acceptRecreate: boolean;
    /**
     * A checkpoint of picked objects: delete too the records outside it created
     * under records it deletes. Without it, those parents stay, named.
     */
    acceptOutside: boolean;
  };
}

/**
 * `checkpoint:undo`. WebView -> Extension. Take back the org's last rewind
 * from its journal: bring back what it deleted, give back what it wrote over,
 * send back to the recycle bin what it brought back. What anyone changed
 * since the rewind stays, and is named.
 */
export interface CheckpointUndoRequest extends BaseMessage {
  type: 'checkpoint:undo';
  payload: {
    checkpointId: string;
    rewindId: string;
    /** Undo even though the org runs automation as its records are updated, deleted or brought back. */
    acceptAutomation: boolean;
  };
}

/**
 * `checkpoint:delete`. WebView -> Extension. Delete checkpoints from this
 * machine, with the Undo of their rewinds. The org is not touched.
 */
export interface CheckpointDeleteRequest extends BaseMessage {
  type: 'checkpoint:delete';
  payload: { checkpointIds: string[] };
}

/**
 * `checkpoint:keep`. WebView -> Extension. Keep a checkpoint until it is
 * deleted, or give it back an expiry date.
 */
export interface CheckpointKeepRequest extends BaseMessage {
  type: 'checkpoint:keep';
  payload: { checkpointId: string; keep: boolean };
}

/** `checkpoint:rename`. WebView -> Extension. Call a checkpoint something else. */
export interface CheckpointRenameRequest extends BaseMessage {
  type: 'checkpoint:rename';
  payload: { checkpointId: string; name: string };
}

/**
 * `checkpoint:ignore-fields`. WebView -> Extension. The fields, `Object.Field`,
 * the checkpoint stops comparing from now on: the whole list, which replaces
 * the one it held.
 */
export interface CheckpointIgnoreFieldsRequest extends BaseMessage {
  type: 'checkpoint:ignore-fields';
  payload: { checkpointId: string; fields: string[] };
}

/** `checkpoint:list:response`. Extension -> WebView. */
export interface CheckpointListResponse extends BaseMessage {
  type: 'checkpoint:list:response';
  payload: { checkpoints: CheckpointListEntry[] };
}

/**
 * `checkpoint:scope:response`. Extension -> WebView. With the refusal a take
 * would meet before reading, when it would meet one, and what it would hold
 * of the org's files, absent for a take refused before its scope is read.
 */
export interface CheckpointScopeResponse extends BaseMessage {
  type: 'checkpoint:scope:response';
  payload: {
    orgId: string;
    mode: CheckpointScopeMode;
    objects: CheckpointScopeObject[];
    leftOut: CheckpointLeftOutObject[];
    estimate: CheckpointEstimate;
    refusal?: CheckpointRefusal;
    files?: CheckpointScopeFiles;
  };
}

/**
 * `checkpoint:take:response`. Extension -> WebView. The checkpoint, once kept;
 * the requests the take sent the org, when its connection counted them; and
 * what the take estimated before it read a record.
 */
export interface CheckpointTakeResponse extends BaseMessage {
  type: 'checkpoint:take:response';
  payload: {
    checkpoint: OrgCheckpoint;
    operationId: string;
    requests?: CheckpointTakeRequests;
    estimate?: CheckpointEstimate;
  };
}

/**
 * `checkpoint:preview:response`. Extension -> WebView. The diff, what the org
 * runs on the objects the rewind would write, what the rewind would cost, and
 * the refusal it would meet before writing, when it would meet one.
 */
export interface CheckpointPreviewResponse extends BaseMessage {
  type: 'checkpoint:preview:response';
  payload: {
    diff: RewindDiff;
    /** Absent when the rewind would write nothing. */
    automation?: ForgeTargetAutomation;
    /**
     * The emails the rewind's writes make the org send, per daily limit;
     * absent when they send none, or when the rewind would write nothing.
     */
    emails?: CheckpointEmails[];
    estimate: CheckpointEstimate;
    refusal?: CheckpointRefusal;
  };
}

/** `checkpoint:rewind:response`. Extension -> WebView. Also when the rewind was stopped part way. */
export interface CheckpointRewindResponse extends BaseMessage {
  type: 'checkpoint:rewind:response';
  payload: { result: RewindResult; operationId: string };
}

/** `checkpoint:undo:response`. Extension -> WebView. Also when the undo was stopped part way. */
export interface CheckpointUndoResponse extends BaseMessage {
  type: 'checkpoint:undo:response';
  payload: { result: RewindResult; operationId: string };
}

/** `checkpoint:delete:response`. Extension -> WebView. The checkpoints deleted. */
export interface CheckpointDeleteResponse extends BaseMessage {
  type: 'checkpoint:delete:response';
  payload: { deleted: string[] };
}

/** `checkpoint:keep:response`. Extension -> WebView. The checkpoint as it is now kept. */
export interface CheckpointKeepResponse extends BaseMessage {
  type: 'checkpoint:keep:response';
  payload: { checkpoint: OrgCheckpoint };
}

/** `checkpoint:rename:response`. Extension -> WebView. */
export interface CheckpointRenameResponse extends BaseMessage {
  type: 'checkpoint:rename:response';
  payload: { checkpoint: OrgCheckpoint };
}

/** `checkpoint:ignore-fields:response`. Extension -> WebView. */
export interface CheckpointIgnoreFieldsResponse extends BaseMessage {
  type: 'checkpoint:ignore-fields:response';
  payload: { checkpoint: OrgCheckpoint };
}

/**
 * `checkpoint:error`. Extension -> WebView. A malformed request
 * (`INVALID_PAYLOAD`), a refusal before anything ran — a guard's code
 * (`CheckpointRefusalCode`), a checkpoint, preview or rewind that is not
 * there or no longer valid, a stopped take (`CANCELLED`) — or a failure.
 */
export interface CheckpointErrorResponse extends BaseMessage {
  type: 'checkpoint:error';
  payload: { message: string; code: string; retryable: boolean };
}
