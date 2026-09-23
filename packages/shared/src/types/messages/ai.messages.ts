import type { BaseMessage } from './base.messages.js';

/**
 * Token usage counters reported by the AI adapters. `cacheRead`/`cacheCreate`
 * track Anthropic prompt-cache hits/writes; `total` is the billable sum.
 */
export interface AITokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
}

/** A single message entry inside an AI conversation history. */
export interface AIConversationEntry {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  tokenCount?: number;
}

/** AI messages (WebView → Extension) */
export interface AIChatRequest extends BaseMessage {
  type: 'ai:chat';
  payload: { conversationId: string; message: string };
}

/** Request to create a new AI conversation */
export interface AIConversationCreateRequest extends BaseMessage {
  type: 'ai:conversation:create';
  payload: { title: string };
}

/** Request to load an existing AI conversation by ID */
export interface AIConversationLoadRequest extends BaseMessage {
  type: 'ai:conversation:load';
  payload: { conversationId: string };
}

/** Request to delete an AI conversation */
export interface AIConversationDeleteRequest extends BaseMessage {
  type: 'ai:conversation:delete';
  payload: { conversationId: string };
}

/** Request to list all AI conversations from the persisted index */
export interface AIConversationListRequest extends BaseMessage {
  type: 'ai:conversation:list';
}

/** Request to get the current AI availability and token budget */
export interface AIStatusRequest extends BaseMessage {
  type: 'ai:status';
}

/** Request to persist the AI API key in the secret vault */
export interface AISaveKeyRequest extends BaseMessage {
  type: 'ai:save-key';
  payload: { apiKey: string };
}

/** Response after saving the AI API key */
export interface AISaveKeyResponse extends BaseMessage {
  type: 'ai:save-key:response';
  payload: { success: boolean; error?: string };
}

/** AI messages (Extension → WebView) */
/** AI chat response with a single assistant message */
export interface AIChatResponse extends BaseMessage {
  type: 'ai:chat:response';
  payload: {
    conversationId: string;
    message: AIConversationEntry;
  };
}

/** Response confirming a new AI conversation was created */
export interface AIConversationCreatedResponse extends BaseMessage {
  type: 'ai:conversation:created';
  payload: { conversation: { id: string; title: string; createdAt: string } };
}

/** Response containing a loaded AI conversation with its message history */
export interface AIConversationLoadedResponse extends BaseMessage {
  type: 'ai:conversation:loaded';
  payload: {
    conversation: {
      id: string;
      title: string;
      messages: AIConversationEntry[];
    };
  };
}

/** Response confirming an AI conversation was deleted */
export interface AIConversationDeletedResponse extends BaseMessage {
  type: 'ai:conversation:deleted';
  payload: { conversationId: string };
}

/** Response containing the list of persisted AI conversations */
export interface AIConversationListResponse extends BaseMessage {
  type: 'ai:conversation:list:response';
  payload: {
    conversations: Array<{ id: string; title: string; createdAt: string; messageCount: number }>;
  };
}

/** Error response from the AI subsystem */
export interface AIErrorResponse extends BaseMessage {
  type: 'ai:error';
  payload: { message: string };
}

/** Response containing AI availability, provider info and the shared token budget */
export interface AIStatusResponse extends BaseMessage {
  type: 'ai:status:response';
  payload: {
    enabled: boolean;
    provider: string;
    model: string;
    /**
     * The token budget every AI feature shares for the window. Sent while AI
     * is available, so the AI page can fill its gauge as soon as it mounts.
     */
    budget?: AIBudgetStateMessage['payload'];
  };
}

// ─── AI Feature Messages ────────────────────────────────────────────────────

/** NL2SOQL: convert natural language to SOQL */
export interface AINL2SOQLRequest extends BaseMessage {
  type: 'ai:nl2soql';
  payload: { query: string; orgId: string };
}

/**
 * Why a NL2SOQL draft came back unchecked.
 *
 * - `fields-unknown`: the org returned no field list for the queried object,
 *   so nothing but the model's own guess backs the field names.
 * - `nothing-to-check`: the org did return one, but every item the draft
 *   selects is a shape the check steps over — a path into a related record,
 *   or a function — so it compared nothing.
 */
export type NL2SOQLUnverifiedReason = 'fields-unknown' | 'nothing-to-check';

/**
 * Response from AI natural-language to SOQL conversion.
 *
 * `verified` says whether at least one field name of the draft was actually
 * compared against the org's describe. `false` means none was — the draft is
 * still returned, and the panel says so, naming the cause `unverifiedReason`
 * carries. Both are optional: a producer that cannot tell omits them, and a
 * reader treats the absence as "not stated" rather than as a check that
 * passed. `unverifiedReason` is meaningless unless `verified` is `false`.
 */
export interface AINL2SOQLResponse extends BaseMessage {
  type: 'ai:nl2soql:response';
  payload: {
    success: boolean;
    soql?: string;
    explanation?: string;
    error?: string;
    verified?: boolean;
    unverifiedReason?: NL2SOQLUnverifiedReason;
  };
}

/**
 * Forge: turn a description into the root query discovery starts from, or
 * check again a query the user edited.
 *
 * Exactly one of `prompt` and `soql` is sent. A prompt goes to the model
 * through NL2SOQL and its draft is checked; a query is only checked, and
 * reaches no model. Either way the answer is a draft for the user to confirm:
 * nothing is discovered or written from here.
 */
export interface AIForgePlanRequest extends BaseMessage {
  type: 'ai:forge-plan';
  payload: { orgId: string; prompt?: string; soql?: string };
}

/**
 * One reason a Forge root query does not hold up against the org it is to be
 * run on, as the check found it.
 *
 * - `no-from`: no object is named after a top-level FROM.
 * - `object-missing`: the object is not one the org lets this user query.
 * - `describe-failed`: the org would not describe the object; `detail` is its message.
 * - `field-missing`: the object has no field of that name.
 * - `relationship-missing`: a path starts with a relationship the object does not have.
 * - `org-refused`: the org's own parser refused the query; `detail` is its message.
 */
export type ForgePlanProblem =
  | { kind: 'no-from' }
  | { kind: 'object-missing'; object: string }
  | { kind: 'describe-failed'; object: string; detail: string }
  | { kind: 'field-missing'; object: string; field: string }
  | { kind: 'relationship-missing'; object: string; relationship: string }
  | { kind: 'org-refused'; detail: string };

/**
 * The draft (or the edited query) and what the check found.
 *
 * `success` is true only when the query was checked and nothing was found
 * wrong: the object exists and can be queried, every field and relationship
 * the query names at its top level exists on it, and the org's parser accepts
 * it. `code` is `AI_NOT_CONFIGURED` when a prompt came in and no provider is
 * set up; `error` carries any failure that stopped the check before it could
 * say anything about the query.
 */
export interface AIForgePlanResponse extends BaseMessage {
  type: 'ai:forge-plan:response';
  payload: {
    success: boolean;
    code?: 'AI_NOT_CONFIGURED';
    soql?: string;
    explanation?: string;
    rootObject?: string;
    rootLabel?: string;
    /** How many distinct fields and relationships were compared against the describe. */
    fieldsChecked?: number;
    problems?: ForgePlanProblem[];
    error?: string;
  };
}

/** AI anomaly detection */
export interface AIAnomalyScanRequest extends BaseMessage {
  type: 'ai:anomaly-scan';
  payload: { orgId: string; objectName: string; sampleSize?: number };
}

/** Response from AI anomaly scan with detected data anomalies */
export interface AIAnomalyScanResponse extends BaseMessage {
  type: 'ai:anomaly-scan:response';
  payload: {
    success: boolean;
    anomalies?: Array<{ field: string; type: string; description: string; severity: string }>;
    /**
     * The records the scan judged: how many it read, and the most it reads.
     * The findings are about this sample, not the whole object. Absent from
     * answers of builds that did not say.
     */
    sample?: { read: number; limit: number };
    error?: string;
  };
}

/** AI pipeline generation */
export interface AIGeneratePipelineRequest extends BaseMessage {
  type: 'ai:generate-pipeline';
  payload: { description: string; orgIds?: string[] };
}

/** Response containing an AI-generated pipeline definition */
export interface AIGeneratePipelineResponse extends BaseMessage {
  type: 'ai:generate-pipeline:response';
  payload: { success: boolean; pipeline?: Record<string, unknown>; error?: string };
}

/** AI schema advice */
export interface AISchemaAdviceRequest extends BaseMessage {
  type: 'ai:schema-advice';
  payload: { orgId: string; objectNames?: string[] };
}

/** Response containing AI schema analysis with issues and recommendations */
export interface AISchemaAdviceResponse extends BaseMessage {
  type: 'ai:schema-advice:response';
  payload: {
    success: boolean;
    advice?: {
      issues: Array<{ objectName: string; field?: string; severity: string; message: string }>;
      recommendations: Array<{ title: string; description: string }>;
    };
    error?: string;
  };
}

/**
 * Provider status banner.
 *
 * Sent from extension → webview every time the AI adapter's per-provider
 * CircuitBreaker changes state (closed → open after 3 consecutive failures,
 * open → half-open after 5 min, half-open → closed on success).
 *
 * Webview renders the AIProviderStatusBanner from this payload.
 */
export interface AIProviderStatusMessage extends BaseMessage {
  type: 'ai:provider:status';
  payload: {
    provider: 'anthropic' | 'openai' | 'custom';
    state: 'closed' | 'open' | 'half-open';
    /** ISO timestamp when the breaker is expected to transition open → half-open. */
    cooldownEndsAt?: string;
    lastErrorKind?: 'overloaded' | 'rate-limit' | 'auth' | 'transient' | 'unknown';
    /** ISO timestamp of the most recent failure that influenced this state. */
    lastErrorAt?: string;
    /** i18n key for the banner copy (e.g. 'ai.error.overloaded'). */
    userMessageKey?: string;
  };
}

/**
 * Token budget snapshot, sent after every AI call. One counter for the window
 * session, shared by every AI feature; the AI page draws it as a gauge. The 80%
 * warning and the refusal are shown by the host as VS Code notices, because
 * most AI calls are made from pages without the gauge.
 */
export interface AIBudgetStateMessage extends BaseMessage {
  type: 'ai:budget:state';
  payload: {
    sessionId: string;
    used: AITokenUsage;
    budget: number;
    percent: number;
    state: 'ok' | 'warn' | 'exceeded';
  };
}
