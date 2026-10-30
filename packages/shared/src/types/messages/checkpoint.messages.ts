import type { BaseMessage } from './base.messages.js';
import type {
  CheckpointArchiveSummary,
  CheckpointEmails,
  CheckpointEstimate,
  CheckpointListEntry,
  CheckpointLeftOutObject,
  CheckpointRefusal,
  CheckpointRewindListed,
  CheckpointScopeCustomSetting,
  CheckpointScopeFiles,
  CheckpointScopeMode,
  CheckpointScopeObject,
  CheckpointTakeRequests,
  OrgCheckpoint,
  RewindDiff,
  RewindResult,
  RewindSelectionPlan,
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
 * The custom settings a take holds, named, or `all` the org has: none by
 * default, in either mode. They are configuration — an integration's
 * endpoint, a switch an admin flipped — that a rewind sets back as the
 * checkpoint holds it, so none is held unless asked for. A name that is no
 * custom setting of the org is left out, named.
 */
export type CheckpointCustomSettings = string[] | 'all';

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
    /** Custom settings to hold, by name, or `all` of them, in either mode: {@link CheckpointCustomSettings}. */
    customSettings?: CheckpointCustomSettings;
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
    /** Custom settings to hold, in either mode: {@link CheckpointCustomSettings}. */
    customSettings?: CheckpointCustomSettings;
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
  payload: {
    checkpointId: string;
    /**
     * The objects of the checkpoint a rewind would be limited to, by API
     * name: its estimate, the automation and emails its writes fire, and the
     * refusal it would meet are those of a rewind of them alone. The diff
     * still reads every object the checkpoint holds, which the plan of a
     * selection reads the parents and children of; what the selection would
     * do and leave is `checkpoint:plan-selection`'s to say. Absent, every
     * object.
     */
    objects?: string[];
  };
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
    /**
     * The objects of the checkpoint it is limited to, by API name: it writes
     * to the others only what rewinding these brings about, and its result
     * says what it left of them (`RewindResult.scope`). A dependency of the
     * objects named is never added to them. Absent, every object.
     */
    objects?: string[];
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
    /**
     * Delete records whose delete takes along records of objects the user,
     * without View All Data and Modify All Data, is not proven to see
     * (`RewindDiff.unseen`). Without it, a rewind that would writes nothing.
     */
    acceptUnseen: boolean;
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

/**
 * `checkpoint:rewinds`. WebView -> Extension. The rewinds of the registered
 * orgs named — of every registered org when none is — and their undos, as
 * the rewind ledger of each org's folder of the store keeps them: what the
 * Seed, Sync and Forge histories mark a run rewound by. Read from this
 * machine alone; no org is contacted.
 */
export interface CheckpointRewindsRequest extends BaseMessage {
  type: 'checkpoint:rewinds';
  payload?: { orgIds?: string[] };
}

/**
 * `checkpoint:plan-selection`. WebView -> Extension. What a rewind limited to
 * the objects picked would do and leave, and the objects not picked it
 * depends on: planned on this machine from the preview named, by the plan the
 * rewind itself makes, the org not read and nothing kept. The page asks again
 * as the selection changes; a dependency is proposed, never added.
 */
export interface CheckpointPlanSelectionRequest extends BaseMessage {
  type: 'checkpoint:plan-selection';
  payload: {
    checkpointId: string;
    previewId: string;
    /** The objects picked, by API name. */
    objects: string[];
    /**
     * Whether deleting records outside what the rewind rewinds is accepted,
     * as `checkpoint:rewind`'s `acceptOutside`: without it, the records whose
     * deletion takes such records along are left, and planned so.
     */
    acceptOutside: boolean;
  };
}

/**
 * `checkpoint:export`. WebView -> Extension. Export a checkpoint kept on this
 * machine into an encrypted `.sfcheckpoint` file, at the place the person
 * picks in the extension's save dialog: the page names no path. The key it is
 * encrypted under is new, answered once and kept nowhere. The org is not
 * contacted. A checkpoint whose take is under way, failed, or whose file is
 * damaged is refused.
 */
export interface CheckpointExportRequest extends BaseMessage {
  type: 'checkpoint:export';
  payload: { checkpointId: string };
}

/**
 * `checkpoint:import-read`. WebView -> Extension. Open a `.sfcheckpoint` file
 * the person picks in the extension's open dialog and read its header, what
 * the file holds and of which org, before any key is asked. The extension
 * keeps where the file is behind a token; the page names no path, then or at
 * the import. A file that is no checkpoint file, or one a newer SandForge
 * made, is refused.
 */
export interface CheckpointImportReadRequest extends BaseMessage {
  type: 'checkpoint:import-read';
}

/**
 * `checkpoint:import`. WebView -> Extension. Keep on this machine the
 * checkpoint the file a `checkpoint:import-read` answered holds, decrypted
 * with the key the person gives, for the org named: refused, before anything
 * is decrypted on the disk, for another org than the file's, a production
 * org, or a user who would not see in the org all the file holds.
 */
export interface CheckpointImportRequest extends BaseMessage {
  type: 'checkpoint:import';
  payload: {
    /** The token `checkpoint:import-read` answered for the file. */
    token: string;
    /** The org it is imported for, by its id in SandForge: the file's own org, connected here. */
    orgId: string;
    /** The key the file was exported under, as it was shown: its groups and dashes or not. */
    key: string;
    /** Days it is kept here; 0 keeps it until it is deleted. */
    keepDays: number;
  };
}

/** `checkpoint:list:response`. Extension -> WebView. */
export interface CheckpointListResponse extends BaseMessage {
  type: 'checkpoint:list:response';
  payload: { checkpoints: CheckpointListEntry[] };
}

/**
 * `checkpoint:scope:response`. Extension -> WebView. With the refusal a take
 * would meet before reading, when it would meet one, what it would hold of
 * the org's files, and the custom settings it may be asked to hold, both
 * absent for a take refused before its scope is read.
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
    /**
     * Every custom setting the org lists, held or not, to pick from by name;
     * absent for a take refused before its scope is read.
     */
    customSettings?: CheckpointScopeCustomSetting[];
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
    /**
     * Why the emails of what fires as the rewind writes were not all
     * counted: the parts of the org's automation that send them it could not
     * read, and the flows, processes and rules whose definition it was
     * refused — a package's, which no user reads. Absent when every one was.
     */
    emailsUncounted?: string;
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
 * `checkpoint:rewinds:response`. Extension -> WebView. Each org's lines in
 * the order they were written, each with the registered orgs it is of.
 */
export interface CheckpointRewindsResponse extends BaseMessage {
  type: 'checkpoint:rewinds:response';
  payload: { rewinds: CheckpointRewindListed[] };
}

/** `checkpoint:plan-selection:response`. Extension -> WebView. The plan of the selection, for the preview named. */
export interface CheckpointPlanSelectionResponse extends BaseMessage {
  type: 'checkpoint:plan-selection:response';
  payload: { checkpointId: string; previewId: string; plan: RewindSelectionPlan };
}

/**
 * `checkpoint:export:response`. Extension -> WebView. The file written, by
 * its name alone, with the key it is encrypted under — the one time it is
 * shown — and what it holds; or that the person closed the save dialog.
 */
export interface CheckpointExportResponse extends BaseMessage {
  type: 'checkpoint:export:response';
  payload:
    | {
        status: 'saved';
        checkpointId: string;
        /** The file's name, without the folder it was saved in. */
        fileName: string;
        /** The key, in groups of four letters and digits: shown once, kept nowhere. */
        key: string;
        /** Records it holds, every object together. */
        records: number;
        objects: number;
        /** Bytes of the file written. */
        bytes: number;
      }
    | { status: 'cancelled'; checkpointId: string };
}

/**
 * `checkpoint:import-read:response`. Extension -> WebView. What the file
 * holds, read from its header alone, the token the import names it by, and
 * the registered orgs it could be imported for; or that the person closed the
 * open dialog.
 */
export interface CheckpointImportReadResponse extends BaseMessage {
  type: 'checkpoint:import-read:response';
  payload:
    | {
        status: 'read';
        /** What `checkpoint:import` names the file by, for as long as the panel is open. */
        token: string;
        /** The file's name, without its folder. */
        fileName: string;
        summary: CheckpointArchiveSummary;
        /**
         * The orgs registered here whose Organization Id is the file's: those
         * it can be imported for. None when the org is not connected here.
         */
        orgIds: string[];
        /**
         * Set when a checkpoint of its id is kept here already: the import
         * says it is kept already when that one is the same, and is refused
         * when it is not.
         */
        keptHere?: true;
      }
    | { status: 'cancelled' };
}

/**
 * `checkpoint:import:response`. Extension -> WebView. The checkpoint kept,
 * listed now among the org's; `alreadyKept` when the same one was kept here
 * already, and nothing was written.
 */
export interface CheckpointImportResponse extends BaseMessage {
  type: 'checkpoint:import:response';
  payload: { checkpoint: OrgCheckpoint; outcome: 'imported' | 'alreadyKept' };
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
