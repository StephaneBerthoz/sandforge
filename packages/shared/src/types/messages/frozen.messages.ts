import type { BaseMessage } from './base.messages.js';
import type { ForgeSweepListing } from '../forge.types.js';
import type {
  FrozenControlReport,
  FrozenLoadPlanInfo,
  FrozenLoadProgress,
  FrozenSelectProgress,
  FrozenLoadReportInfo,
  FrozenManifestInfo,
  FrozenProjectConfig,
  FrozenRemovalPreview,
  FrozenRemovalResult,
  FrozenSelectionSummary,
  FrozenStatusInfo,
  FrozenVerifyVerdict,
} from '../frozen.types.js';

/**
 * `frozen:config:get`. WebView -> Extension. Read the per-project frozen
 * dataset configuration (no payload).
 */
export interface FrozenConfigGetRequest extends BaseMessage {
  type: 'frozen:config:get';
}

/**
 * `frozen:config:save`. WebView -> Extension. Persist the per-project
 * configuration (coverage axes, budget, protected envs, identity keys,
 * undeletable objects, picklist rules, …).
 */
export interface FrozenConfigSaveRequest extends BaseMessage {
  type: 'frozen:config:save';
  payload: { config: FrozenProjectConfig };
}

/**
 * `frozen:select`. WebView -> Extension. Run the coverage-matrix selection
 * against the source org and persist the retained roots in the sas.
 */
export interface FrozenSelectRequest extends BaseMessage {
  type: 'frozen:select';
  payload: { sourceOrgId: string };
}

/**
 * `frozen:extract`. WebView -> Extension. Run extraction + deterministic
 * pseudonymization + 4-point control, then write the frozen dataset when
 * the gate passes.
 */
export interface FrozenExtractRequest extends BaseMessage {
  type: 'frozen:extract';
  payload: { sourceOrgId: string; author?: string };
}

/** `frozen:manifest:get`. WebView -> Extension. Read the frozen manifest (no payload). */
export interface FrozenManifestGetRequest extends BaseMessage {
  type: 'frozen:manifest:get';
}

/**
 * `frozen:load`. WebView -> Extension. Replay the frozen dataset into a
 * target sandbox (Production Guard + entry guards). `pilot` loads a single
 * root folder; `reload` reuses reference data and purges residuals.
 */
export interface FrozenLoadRequest extends BaseMessage {
  type: 'frozen:load';
  /**
   * `writeEncrypted`: write the fields the target encrypts as the dataset
   * holds them, though its manifest does not say its extraction left out what
   * it read masked; they are left out otherwise (`FrozenFieldRemoval`,
   * `may-hold-masks`). `reload`: the load replaces the loads before it,
   * taken back whole, and is refused before anything is written when a
   * removal of them would leave records in the org. `maxRecords`: the most
   * records the load may insert, refused before anything is written past it.
   */
  payload: FrozenLoadOptionsPayload;
}

/** What a load, or its preview, is asked with. */
export interface FrozenLoadOptionsPayload {
  targetOrgId: string;
  pilot?: boolean;
  reload?: boolean;
  writeEncrypted?: boolean;
  maxRecords?: number;
  /**
   * Mute the target's automation for the run: assign the user it writes as,
   * for its duration, the permission sets holding the bypasses the target's
   * flows, processes and workflow rules test to stay quiet, and take them
   * back as it ends. Refused on a production org, and for a user who cannot
   * assign permission sets; what no bypass keeps quiet still runs, and is
   * asked about as ever.
   */
  muteAutomation?: boolean;
}

/**
 * `frozen:load:preview`. WebView -> Extension. What a load with the same
 * options would do, read from the target and the sas with nothing written:
 * per object, what it would insert, link, drop, rewrite and purge.
 */
export interface FrozenLoadPreviewRequest extends BaseMessage {
  type: 'frozen:load:preview';
  payload: FrozenLoadOptionsPayload;
}

/**
 * `frozen:verify`. WebView -> Extension. Re-run the read-only post-load
 * verification against the last load's counting contract.
 */
export interface FrozenVerifyRequest extends BaseMessage {
  type: 'frozen:verify';
  payload: { targetOrgId: string };
}

/**
 * `frozen:remove`. WebView -> Extension. Remove from its target org the records
 * the last load created, as the sas mapping names them.
 *
 * The request names the load — the org it wrote to and when it wrote its last
 * record, as `frozen:status` said — never records: what is removed is what the
 * mapping says the load created, and nothing it linked or reused.
 */
export interface FrozenRemoveRequest extends BaseMessage {
  type: 'frozen:remove';
  payload: {
    /** The org the load wrote to. */
    targetOrgId: string;
    /** When the load wrote its last record (`FrozenLoadRecordsInfo.loadedAt`). */
    loadedAt: string;
    /**
     * Remove the records modified since the load too, and what was added to
     * them since; they are kept otherwise.
     */
    includeChanged?: boolean;
    /**
     * Sweep, before the load's records go, what the target's automation
     * created during the load as its user that the load's mapping does not
     * hold (Forge's sweep, `ForgeRunSweep`): such a record then holds none of
     * the load's records back as one that stays.
     */
    sweep?: boolean;
  };
}

/**
 * `frozen:remove:sweep`. WebView -> Extension. What a sweep asked with the
 * removal of a load would take — per object, a few names, never ids — read
 * only, for the confirmation to list before the user types the org's name.
 */
export interface FrozenRemoveSweepRequest extends BaseMessage {
  type: 'frozen:remove:sweep';
  payload: {
    /** The org the load wrote to. */
    targetOrgId: string;
    /** When the load wrote its last record (`FrozenLoadRecordsInfo.loadedAt`). */
    loadedAt: string;
  };
}

/**
 * `frozen:remove:preview`. Command line -> Extension. What a removal of the
 * load would do — per object, what it would delete, keep and find gone —
 * read before its first write, nothing written and nothing asked.
 */
export interface FrozenRemovePreviewRequest extends BaseMessage {
  type: 'frozen:remove:preview';
  payload: {
    /** The org the load wrote to. */
    targetOrgId: string;
    /** When the load wrote its last record (`FrozenLoadRecordsInfo.loadedAt`). */
    loadedAt: string;
    /** Count the records modified since the load among those a removal deletes. */
    includeChanged?: boolean;
  };
}

/**
 * `frozen:status`. WebView -> Extension. Module status snapshot: config,
 * salt presence (fingerprint only), selection, manifest, last load/verify
 * (no payload).
 */
export interface FrozenStatusRequest extends BaseMessage {
  type: 'frozen:status';
}

/**
 * `frozen:rules:clear`. WebView -> Extension. Write a `clear` rule into the
 * pseudonymization rules file for each field named, `Object.Field`: the
 * fields an extraction kept in clear text without a rule, which its result
 * lists for review. The next extraction clears them.
 */
export interface FrozenRulesClearRequest extends BaseMessage {
  type: 'frozen:rules:clear';
  payload: { fields: string[] };
}

/**
 * `frozen:rules:clear:response`. Extension -> WebView. The rules file written
 * to, the version it carries now, the fields given a `clear` rule, and those
 * it already ruled, left as declared.
 */
export interface FrozenRulesClearResponse extends BaseMessage {
  type: 'frozen:rules:clear:response';
  payload: { rulesPath: string; rulesVersion: string; cleared: string[]; alreadyRuled: string[] };
}

/** `frozen:config:get:response`. Extension -> WebView. */
export interface FrozenConfigGetResponse extends BaseMessage {
  type: 'frozen:config:get:response';
  payload: { config: FrozenProjectConfig | null; sasDir: string; datasetDir: string };
}

/** `frozen:config:save:response`. Extension -> WebView. */
export interface FrozenConfigSaveResponse extends BaseMessage {
  type: 'frozen:config:save:response';
  payload: { success: boolean };
}

/**
 * `frozen:select:progress`. Extension -> WebView. Each step of a selection —
 * the discovery, each combination and candidate, the final measure — as it
 * starts: a selection of a large org runs for minutes.
 */
export interface FrozenSelectProgressMessage extends BaseMessage {
  type: 'frozen:select:progress';
  payload: FrozenSelectProgress;
}

/** `frozen:select:response`. Extension -> WebView (selection summary, IDs redacted). */
export interface FrozenSelectResponse extends BaseMessage {
  type: 'frozen:select:response';
  payload: { selection: FrozenSelectionSummary };
}

/** `frozen:extract:response`. Extension -> WebView. */
export interface FrozenExtractResponse extends BaseMessage {
  type: 'frozen:extract:response';
  payload: {
    datasetDir: string;
    files: string[];
    recordCount: number;
    manifest: FrozenManifestInfo;
  };
}

/**
 * `frozen:control:result`. Extension -> WebView. Detailed 4-point
 * non-reidentification gate result, emitted after every extraction run
 * (PASS or FAIL — a FAIL means nothing was written).
 */
export interface FrozenControlResultMessage extends BaseMessage {
  type: 'frozen:control:result';
  payload: { report: FrozenControlReport };
}

/** `frozen:manifest:get:response`. Extension -> WebView. */
export interface FrozenManifestGetResponse extends BaseMessage {
  type: 'frozen:manifest:get:response';
  payload: { manifest: FrozenManifestInfo | null; datasetDir: string };
}

/** `frozen:load:response`. Extension -> WebView. */
export interface FrozenLoadResponse extends BaseMessage {
  type: 'frozen:load:response';
  payload: { report: FrozenLoadReportInfo };
}

/** `frozen:load:preview:response`. Extension -> WebView. What the load would do. */
export interface FrozenLoadPreviewResponse extends BaseMessage {
  type: 'frozen:load:preview:response';
  payload: { plan: FrozenLoadPlanInfo };
}

/**
 * `frozen:load:progress`. Extension -> WebView. Throttled per-phase progress
 * event pushed during load and verification.
 */
export interface FrozenLoadProgressMessage extends BaseMessage {
  type: 'frozen:load:progress';
  payload: FrozenLoadProgress;
}

/**
 * `frozen:verify:result`. Extension -> WebView. Post-load verification
 * verdict (result channel of `frozen:verify`, also chained after a load).
 */
export interface FrozenVerifyResultMessage extends BaseMessage {
  type: 'frozen:verify:result';
  payload: { verdict: FrozenVerifyVerdict };
}

/** `frozen:status:response`. Extension -> WebView. */
export interface FrozenStatusResponse extends BaseMessage {
  type: 'frozen:status:response';
  payload: { status: FrozenStatusInfo };
}

/**
 * `frozen:remove:response`. Extension -> WebView. What removing the records
 * the last load created did, object by object — also when the removal was
 * cancelled part way.
 */
export interface FrozenRemoveResponse extends BaseMessage {
  type: 'frozen:remove:response';
  payload: { result: FrozenRemovalResult; operationId: string };
}

/** `frozen:remove:preview:response`. Extension -> Command line. What a removal of the load would do. */
export interface FrozenRemovePreviewResponse extends BaseMessage {
  type: 'frozen:remove:preview:response';
  payload: { preview: FrozenRemovalPreview };
}

/** `frozen:remove:sweep:response`. Extension -> WebView. What a sweep of the load's removal would take. */
export interface FrozenRemoveSweepResponse extends BaseMessage {
  type: 'frozen:remove:sweep:response';
  payload: { loadedAt: string; listing: ForgeSweepListing };
}

// ─── Frozen error channels (Extension -> WebView, via sendHandlerError) ─────

/**
 * `frozen:config:save:error`. Extension -> WebView. Emitted by
 * validatePayload/sendHandlerError when the project configuration cannot be
 * persisted.
 */
export interface FrozenConfigSaveErrorMessage extends BaseMessage {
  type: 'frozen:config:save:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:select:error`. Extension -> WebView. `code` is classified by
 * FrozenDatasetHandler.errorCodeFor (e.g. `CONFIG_MISSING`, `SALT_MISSING`,
 * `BUDGET_EXCEEDED`).
 */
export interface FrozenSelectErrorMessage extends BaseMessage {
  type: 'frozen:select:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:extract:error`. Extension -> WebView. `code` classified by
 * errorCodeFor (e.g. `GUARD_REFUSED`, `SAS_PATH_REFUSED`).
 */
export interface FrozenExtractErrorMessage extends BaseMessage {
  type: 'frozen:extract:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `frozen:load:error`. Extension -> WebView. `code` classified by errorCodeFor. */
export interface FrozenLoadErrorMessage extends BaseMessage {
  type: 'frozen:load:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:load:preview:error`. Extension -> WebView. What the load would be
 * refused before its first write — an entry guard (`GUARD_REFUSED`), a
 * required field left uncovered (`LOAD_CONFIG`) — or a read that failed.
 */
export interface FrozenLoadPreviewErrorMessage extends BaseMessage {
  type: 'frozen:load:preview:error';
  payload: { message: string; code: string; retryable: boolean };
}

/** `frozen:verify:error`. Extension -> WebView. `code` classified by errorCodeFor. */
export interface FrozenVerifyErrorMessage extends BaseMessage {
  type: 'frozen:verify:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:remove:error`. Extension -> WebView. A removal refused before it
 * started (`NO_LOAD`, `NOT_RECORDED`, `LOAD_CHANGED`, `ALREADY_REMOVED`,
 * `NOTHING_TO_REMOVE`, `DUPLICATE`, `TARGET_REFRESHED`, the guard's codes), or
 * one that failed.
 */
export interface FrozenRemoveErrorMessage extends BaseMessage {
  type: 'frozen:remove:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:remove:preview:error`. Extension -> Command line. A removal preview
 * refused before it read the org (`NO_LOAD`, `NOT_RECORDED`, `LOAD_CHANGED`,
 * `ALREADY_REMOVED`, `NOTHING_TO_REMOVE`), or one whose reads failed.
 */
export interface FrozenRemovePreviewErrorMessage extends BaseMessage {
  type: 'frozen:remove:preview:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:remove:sweep:error`. Extension -> WebView. What a sweep would take
 * could not be read: no load recorded, another load since, or a read that failed.
 */
export interface FrozenRemoveSweepErrorMessage extends BaseMessage {
  type: 'frozen:remove:sweep:error';
  payload: { message: string; code: string; retryable: boolean };
}

/**
 * `frozen:rules:clear:error`. Extension -> WebView. No configuration saved
 * (`CONFIG_MISSING`), no rules file where the configuration points
 * (`LOAD_CONFIG`), or a file that could not be read, parsed or written.
 */
export interface FrozenRulesClearErrorMessage extends BaseMessage {
  type: 'frozen:rules:clear:error';
  payload: { message: string; code: string; retryable: boolean };
}
