import type { BaseMessage } from './base.messages.js';
import type {
  FrozenControlReport,
  FrozenLoadProgress,
  FrozenLoadReportInfo,
  FrozenManifestInfo,
  FrozenProjectConfig,
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
  payload: { targetOrgId: string; pilot?: boolean; reload?: boolean };
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
 * `frozen:status`. WebView -> Extension. Module status snapshot: config,
 * salt presence (fingerprint only), selection, manifest, last load/verify
 * (no payload).
 */
export interface FrozenStatusRequest extends BaseMessage {
  type: 'frozen:status';
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

/** `frozen:verify:error`. Extension -> WebView. `code` classified by errorCodeFor. */
export interface FrozenVerifyErrorMessage extends BaseMessage {
  type: 'frozen:verify:error';
  payload: { message: string; code: string; retryable: boolean };
}
