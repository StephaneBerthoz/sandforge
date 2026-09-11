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

/** Request to get the current AI module status and usage stats */
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

/** Response containing AI module status, provider info, and usage stats */
export interface AIStatusResponse extends BaseMessage {
  type: 'ai:status:response';
  payload: {
    enabled: boolean;
    provider: string;
    model: string;
    usage: { totalCalls: number; totalOutputTokens: number; averageLatencyMs: number };
  };
}

// ─── AI Feature Messages (Tier 2) ───────────────────────────────────────────

/** NL2SOQL: convert natural language to SOQL */
export interface AINL2SOQLRequest extends BaseMessage {
  type: 'ai:nl2soql';
  payload: { query: string; orgId: string };
}

/** Response from AI natural-language to SOQL conversion */
export interface AINL2SOQLResponse extends BaseMessage {
  type: 'ai:nl2soql:response';
  payload: { success: boolean; soql?: string; explanation?: string; error?: string };
}

/** AI error resolution */
export interface AIResolveErrorRequest extends BaseMessage {
  type: 'ai:resolve-error';
  payload: {
    errorMessage: string;
    errorCode?: string;
    module: string;
    context?: Record<string, unknown>;
  };
}

/** Response from AI error resolution with suggested fix */
export interface AIResolveErrorResponse extends BaseMessage {
  type: 'ai:resolve-error:response';
  payload: {
    success: boolean;
    resolution?: { explanation: string; suggestedFix: string; confidence: number };
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
 * Phase 04 plan 04-02 — provider status banner.
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
 * Phase 04 plan 04-05 — per-panel-session token budget snapshots.
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

/** Fires once per session at the first crossing of the 80% threshold. */
export interface AIBudgetWarnMessage extends BaseMessage {
  type: 'ai:budget:warn';
  payload: {
    sessionId: string;
    used: AITokenUsage;
    budget: number;
    percent: number;
    state: 'ok' | 'warn' | 'exceeded';
  };
}

/**
 * Fires every time a call (or pre-flight) breaches 100%. The webview shows
 * a modal that links straight to the Settings pane via `settingsKey`.
 */
export interface AIBudgetExceededMessage extends BaseMessage {
  type: 'ai:budget:exceeded';
  payload: {
    sessionId: string;
    used: AITokenUsage;
    budget: number;
    percent: number;
    state: 'ok' | 'warn' | 'exceeded';
    settingsKey: 'sandforge.ai.tokenBudgetMaxPerSession';
  };
}
