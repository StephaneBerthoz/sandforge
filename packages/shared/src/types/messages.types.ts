/**
 * Message protocol for Extension <-> WebView communication.
 *
 * ## Architecture overview
 *
 * The WebView (React) and the Extension (Node.js) communicate through a
 * strongly-typed, asynchronous message channel:
 *
 * 1. **WebView -> Extension**: the React app calls `vscode.postMessage(msg)`.
 *    The extension receives these messages via `webview.onDidReceiveMessage()`.
 *
 * 2. **Extension -> WebView**: the extension calls `webview.postMessage(msg)`.
 *    The React app listens with `window.addEventListener('message', ...)`.
 *
 * 3. **Routing**: the {@link MessageBroker} (in `packages/extension/src/bridge/`)
 *    dispatches incoming messages to the appropriate **DomainHandler** based on
 *    the message `type` prefix (e.g. `"org:"`, `"seed:"`, `"ai:"`).
 *    Each DomainHandler processes the request and posts a response back.
 *
 * 4. **Typing**: every message extends {@link BaseMessage} with a literal `type`
 *    discriminant, enabling exhaustive pattern matching in handlers.
 *    The union types {@link WebViewToExtensionMessage} and
 *    {@link ExtensionToWebViewMessage} enumerate all valid messages per direction.
 *
 * @see MessageBroker — central router in `packages/extension/src/bridge/MessageBroker.ts`
 * @see BaseMessage — every message must include `id`, `type`, and `timestamp`
 */

/** Message direction */
export type MessageDirection = 'extension_to_webview' | 'webview_to_extension';

/** Base message structure — all messages extend this */
export interface BaseMessage {
  id: string;
  type: string;
  timestamp: number;
  /** Links a response to the original request (set to request's `id`). */
  correlationId?: string;
}

// ─── Autopilot Messages ──────────────────────────────────────────────────────

/** Request to scan source/target org schemas and build dependency graph */
export interface AutopilotScanSchemaRequest extends BaseMessage {
  type: 'autopilot:scan-schema';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    selectedObjects: string[];
    includeStandardObjects: boolean;
  };
}

/** Schema scan result with full dependency graph */
export interface AutopilotSchemaResult extends BaseMessage {
  type: 'autopilot:schema-result';
  payload: {
    graph: import('./autopilot.types.js').AutopilotGraph;
  };
}

/** Request to generate an execution plan from the graph */
export interface AutopilotGeneratePlanRequest extends BaseMessage {
  type: 'autopilot:generate-plan';
  payload: {
    complianceFramework: import('./common.types.js').ComplianceFrameworkType;
    maxRecordsPerObject: number;
    objectFilters: Record<string, string>;
    overrides: import('./autopilot.types.js').AnonymizationOverride[];
  };
}

/** Execution plan ready for review */
export interface AutopilotPlanReady extends BaseMessage {
  type: 'autopilot:plan-ready';
  payload: {
    plan: import('./autopilot.types.js').ExecutionPlan;
    graph: import('./autopilot.types.js').AutopilotGraph;
  };
}

/** Request to start autopilot execution */
export interface AutopilotExecuteRequest extends BaseMessage {
  type: 'autopilot:execute';
  payload: {
    grappeThreshold: number;
  };
}

/** Progress update for a node during execution */
export interface AutopilotNodeProgress extends BaseMessage {
  type: 'autopilot:node-progress';
  payload: {
    objectApiName: string;
    status: import('./autopilot.types.js').AutopilotNodeStatus;
    progress: number;
    recordsProcessed: number;
    recordsTotal: number;
    apiCallsUsed: number;
    elapsedMs: number;
  };
}

/** Node completed successfully */
export interface AutopilotNodeCompleted extends BaseMessage {
  type: 'autopilot:node-completed';
  payload: {
    objectApiName: string;
    successCount: number;
    failureCount: number;
    elapsedMs: number;
    apiCallsUsed: number;
  };
}

/** Node failed during execution */
export interface AutopilotNodeFailed extends BaseMessage {
  type: 'autopilot:node-failed';
  payload: {
    objectApiName: string;
    errors: string[];
    partialSuccessCount: number;
  };
}

/** Request to pause autopilot execution */
export interface AutopilotPauseRequest extends BaseMessage {
  type: 'autopilot:pause';
}

/** Request to resume autopilot execution */
export interface AutopilotResumeRequest extends BaseMessage {
  type: 'autopilot:resume';
}

/** Request to skip a node during execution */
export interface AutopilotSkipNodeRequest extends BaseMessage {
  type: 'autopilot:skip-node';
  payload: {
    objectApiName: string;
  };
}

/** Autopilot execution completed */
export interface AutopilotCompleted extends BaseMessage {
  type: 'autopilot:completed';
  payload: {
    totalRecords: number;
    totalSuccessCount: number;
    totalFailureCount: number;
    totalElapsedMs: number;
    totalApiCalls: number;
  };
}

/** Compliance report ready after execution */
export interface AutopilotComplianceReportReady extends BaseMessage {
  type: 'autopilot:compliance-report';
  payload: {
    report: import('./compliance.types.js').ComplianceReport;
  };
}

/** Message from WebView to Extension (requests) */
export type WebViewToExtensionMessage =
  | OrgListRequest
  | OrgConnectRequest
  | OrgDisconnectRequest
  | SeedExecuteRequest
  | SeedDescribeGlobalRequest
  | SeedDescribeObjectRequest
  | SyncExecuteRequest
  | SyncDescribeGlobalRequest
  | SyncDescribeFieldsRequest
  | MonitorRefreshRequest
  | MonitorStartRequest
  | MonitorTrendsRequest
  | MonitorAbortJobRequest
  | CompareExecuteRequest
  | BackupExecuteRequest
  | PipelineRunRequest
  | PipelineTemplatesRequest
  | SettingsGetRequest
  | SettingsUpdateRequest
  | CancelOperationRequest
  | PauseOperationRequest
  | ResumeOperationRequest
  | AIChatRequest
  | AIConversationCreateRequest
  | AIConversationLoadRequest
  | AIConversationDeleteRequest
  | AIStatusRequest
  | AISaveKeyRequest
  | AnonymizationTemplatesRequest
  | OnboardingCompleteRequest
  | OnboardingResetRequest
  | HintDismissRequest
  | AINL2SOQLRequest
  | AIResolveErrorRequest
  | AIPersonasRequest
  | AIAnomalyScanRequest
  | AISuggestionsRequest
  | AIGeneratePipelineRequest
  | AISchemaAdviceRequest
  | PIIScanRequest
  | PluginsListRequest
  | PluginsLoadRequest
  | PluginsUnloadRequest
  | TelemetryStatusRequest
  | TelemetryToggleRequest
  | MigrationImportRequest
  | MigrationImportSfdmuRequest
  | MarketplaceListRequest
  | MarketplaceInstallRequest
  | ConnectivityStatusRequest
  | AutopilotScanSchemaRequest
  | AutopilotGeneratePlanRequest
  | AutopilotExecuteRequest
  | AutopilotPauseRequest
  | AutopilotResumeRequest
  | AutopilotSkipNodeRequest
  | LiveOperationsRequest
  | ConfigExportRequest
  | ConfigImportRequest
  | ConfigCategoriesRequest
  | ConfigValidateRequest
  | MaskingTemplatesByObjectRequest
  | OrgHealthScoreRequest
  | MonitorStorageRequest
  | MonitorDeploymentsRequest
  | MonitorApiUsageRequest
  | MonitorErrorLogsRequest
  | MonitorSessionsRequest
  | MonitorApexInsightsRequest
  | MonitorSandboxRefreshRequest
  | SchedulerListRequest
  | SchedulerUpsertRequest
  | SchedulerDeleteRequest
  | SchedulerToggleRequest
  | RealTimeStartRequest
  | RealTimeStopRequest
  | RealTimeStatusRequest
  | RealTimeMetricsRequest
  | RealTimeResolveConflictRequest;

/** Message from Extension to WebView (responses / events) */
export type ExtensionToWebViewMessage =
  | OrgListResponse
  | OrgStatusChanged
  | OperationStarted
  | OperationProgress
  | OperationCompleted
  | OperationFailed
  | SettingsResponse
  | NotificationMessage
  | GrappeStarted
  | GrappePartitionProgress
  | GrappeBackPressure
  | GrappeCompleted
  | AIChatResponse
  | AIConversationCreatedResponse
  | AIConversationLoadedResponse
  | AIErrorResponse
  | AIStatusResponse
  | AISaveKeyResponse
  | MonitorAbortJobResponse
  | PipelineTemplatesResponse
  | AnonymizationTemplatesResponse
  | OnboardingShowMessage
  | WhatsNewShowMessage
  | AINL2SOQLResponse
  | AIResolveErrorResponse
  | AIPersonasResponse
  | AIAnomalyScanResponse
  | AISuggestionsResponse
  | AIGeneratePipelineResponse
  | AISchemaAdviceResponse
  | PIIScanResponse
  | PluginsListResponse
  | PluginsLoadResponse
  | PluginsUnloadResponse
  | TelemetryStatusResponse
  | TelemetryToggleResponse
  | MigrationImportResponse
  | MigrationImportSfdmuResponse
  | MarketplaceListResponse
  | MarketplaceInstallResponse
  | ConnectivityStatusResponse
  | AutopilotSchemaResult
  | AutopilotPlanReady
  | AutopilotNodeProgress
  | AutopilotNodeCompleted
  | AutopilotNodeFailed
  | AutopilotCompleted
  | AutopilotComplianceReportReady
  | LiveOperationsResponse
  | LiveOperationsUpdated
  | ConfigExportResponse
  | ConfigImportResponse
  | ConfigCategoriesResponse
  | ConfigValidateResponse
  | MaskingTemplatesByObjectResponse
  | OrgHealthScoreResponse
  | MonitorStorageResponse
  | MonitorDeploymentsResponse
  | MonitorApiUsageResponse
  | MonitorErrorLogsResponse
  | MonitorSessionsResponse
  | MonitorApexInsightsResponse
  | MonitorSandboxRefreshResponse
  | SchedulerListResponse
  | SchedulerUpsertResponse
  | SchedulerDeleteResponse
  | SchedulerToggleResponse
  | RealTimeStartedResponse
  | RealTimeStoppedResponse
  | RealTimeCDCEventMessage
  | RealTimeStatusResponse
  | RealTimeMetricsResponse
  | RealTimeConflictDetected;

/** Org management messages */
export interface OrgListRequest extends BaseMessage {
  type: 'org:list';
}

/** Response containing the list of registered Salesforce orgs */
export interface OrgListResponse extends BaseMessage {
  type: 'org:list:response';
  payload: { orgs: Record<string, unknown>[] };
}

/** Request to connect (authenticate) a Salesforce org */
export interface OrgConnectRequest extends BaseMessage {
  type: 'org:connect';
  payload: {
    orgId: string;
    authMethod: string;
    alias?: string;
    loginUrl?: string;
    username?: string;
    password?: string;
    securityToken?: string;
  };
}

/** Request to disconnect a Salesforce org */
export interface OrgDisconnectRequest extends BaseMessage {
  type: 'org:disconnect';
  payload: { orgId: string };
}

/** Notification that an org's connection status has changed */
export interface OrgStatusChanged extends BaseMessage {
  type: 'org:statusChanged';
  payload: { orgId: string; status: string };
}

/** Seed messages */
export interface SeedExecuteRequest extends BaseMessage {
  type: 'seed:execute';
  payload: { templateId: string; orgId: string; dryRun: boolean };
}

/** Seed describe global objects request. */
export interface SeedDescribeGlobalRequest extends BaseMessage {
  type: 'seed:describe-global';
  payload: { orgId: string };
}

/** Seed describe single object fields request. */
export interface SeedDescribeObjectRequest extends BaseMessage {
  type: 'seed:describe-object';
  payload: { orgId: string; objectApiName: string };
}

/** Sync messages */
export interface SyncExecuteRequest extends BaseMessage {
  type: 'sync:execute';
  payload: { configId: string; dryRun: boolean };
}

/** Sync describe global objects request. */
export interface SyncDescribeGlobalRequest extends BaseMessage {
  type: 'sync:describe-global';
  payload: { orgId: string };
}

/** Sync describe fields for source and target request. */
export interface SyncDescribeFieldsRequest extends BaseMessage {
  type: 'sync:describe-fields';
  payload: { sourceOrgId: string; targetOrgId: string; objectApiName: string };
}

/** Monitor messages */
export interface MonitorRefreshRequest extends BaseMessage {
  type: 'monitor:refresh';
  payload: { orgId: string };
}

/** Request to start monitoring an org (alias for monitor:refresh). */
export interface MonitorStartRequest extends BaseMessage {
  type: 'monitor:start';
  payload: { orgId: string };
}

/** Request to fetch trend data for an org over a given period. */
export interface MonitorTrendsRequest extends BaseMessage {
  type: 'monitor:trends';
  payload: { orgId: string; period?: string };
}

/** Compare messages */
export interface CompareExecuteRequest extends BaseMessage {
  type: 'compare:execute';
  payload: { configId: string };
}

/** Backup messages */
export interface BackupExecuteRequest extends BaseMessage {
  type: 'backup:execute';
  payload: { configId: string };
}

/** Pipeline messages */
export interface PipelineRunRequest extends BaseMessage {
  type: 'pipeline:run';
  payload: { pipelineId: string; variables?: Record<string, string> };
}

/** Settings messages */
export interface SettingsGetRequest extends BaseMessage {
  type: 'settings:get';
}

/** Request to update a single setting value */
export interface SettingsUpdateRequest extends BaseMessage {
  type: 'settings:update';
  payload: { key: string; value: unknown };
}

/** Response containing the current application settings */
export interface SettingsResponse extends BaseMessage {
  type: 'settings:response';
  payload: { settings: Record<string, unknown> };
}

/** Operation control messages */
/** Request to cancel a running operation */
export interface CancelOperationRequest extends BaseMessage {
  type: 'operation:cancel';
  payload: { operationId: string };
}

/** Request to pause a running operation */
export interface PauseOperationRequest extends BaseMessage {
  type: 'operation:pause';
  payload: { operationId: string };
}

/** Request to resume a paused operation */
export interface ResumeOperationRequest extends BaseMessage {
  type: 'operation:resume';
  payload: { operationId: string };
}

/** Operation lifecycle messages */
/** Notification that an operation has started executing */
export interface OperationStarted extends BaseMessage {
  type: 'operation:started';
  payload: { operationId: string; module: string; description: string };
}

/** Progress update for a running operation */
export interface OperationProgress extends BaseMessage {
  type: 'operation:progress';
  payload: {
    operationId: string;
    percentage: number;
    processedRecords: number;
    totalRecords: number;
    currentStep: string;
  };
}

/** Notification that an operation completed successfully */
export interface OperationCompleted extends BaseMessage {
  type: 'operation:completed';
  payload: { operationId: string; result: Record<string, unknown> };
}

/** Notification that an operation has failed */
export interface OperationFailed extends BaseMessage {
  type: 'operation:failed';
  payload: { operationId: string; error: string; retryable: boolean };
}

/** Notification message */
export interface NotificationMessage extends BaseMessage {
  type: 'notification';
  payload: {
    level: 'info' | 'success' | 'warning' | 'error';
    title: string;
    message: string;
    actions?: NotificationAction[];
    autoDismissMs?: number;
  };
}

/** Notification action button */
export interface NotificationAction {
  label: string;
  command: string;
  args?: Record<string, unknown>;
}

/** Grappe messages */
/** Notification that a grappe (parallel partition) operation has started */
export interface GrappeStarted extends BaseMessage {
  type: 'grappe:started';
  payload: { operationId: string; totalPartitions: number; totalRecords: number };
}

/** Progress update for a single grappe partition */
export interface GrappePartitionProgress extends BaseMessage {
  type: 'grappe:partitionProgress';
  payload: { grappeId: string; percentage: number; processedRecords: number };
}

/** Back-pressure signal indicating API usage levels */
export interface GrappeBackPressure extends BaseMessage {
  type: 'grappe:backPressure';
  payload: { level: 'normal' | 'warning' | 'critical'; apiPercent: number };
}

/** Notification that a grappe operation has completed */
export interface GrappeCompleted extends BaseMessage {
  type: 'grappe:completed';
  payload: { operationId: string; totalProcessed: number; totalFailed: number };
}

/** Onboarding messages (WebView → Extension) */
export interface OnboardingCompleteRequest extends BaseMessage {
  type: 'onboarding:complete';
  payload: { skipped: boolean };
}

/** Request to reset the onboarding flow so it shows again */
export interface OnboardingResetRequest extends BaseMessage {
  type: 'onboarding:reset';
  payload: Record<string, never>;
}

/** Request to dismiss a contextual hint so it is not shown again */
export interface HintDismissRequest extends BaseMessage {
  type: 'hint:dismiss';
  payload: { hintId: string };
}

/** Monitor abort job */
export interface MonitorAbortJobRequest extends BaseMessage {
  type: 'monitor:abort-job';
  payload: { orgId: string; jobId: string };
}

/** Response after attempting to abort a Salesforce async job */
export interface MonitorAbortJobResponse extends BaseMessage {
  type: 'monitor:abort-job:response';
  payload: { jobId: string; success: boolean; message: string };
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
    message: { id: string; role: string; content: string; timestamp: string; tokenCount?: number };
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
      messages: Array<{ id: string; role: string; content: string; timestamp: string }>;
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

/** Pipeline templates */
export interface PipelineTemplatesRequest extends BaseMessage {
  type: 'pipeline:templates';
}

/** Response containing available pipeline templates */
export interface PipelineTemplatesResponse extends BaseMessage {
  type: 'pipeline:templates:response';
  payload: {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      steps: Array<{ name: string; type: string; description: string }>;
    }>;
  };
}

/** Anonymization templates */
export interface AnonymizationTemplatesRequest extends BaseMessage {
  type: 'dataops:anonymization-templates';
}

/** Response containing available anonymization templates with their rules */
export interface AnonymizationTemplatesResponse extends BaseMessage {
  type: 'dataops:anonymization-templates:response';
  payload: {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      complianceFramework: string;
      rules: Array<{ fieldPattern: string; ruleType: string; description: string }>;
    }>;
  };
}

/** Onboarding messages (Extension → WebView) */
/** Instructs the WebView to display the onboarding wizard */
export interface OnboardingShowMessage extends BaseMessage {
  type: 'onboarding:show';
  payload: Record<string, never>;
}

/** Instructs the WebView to display the "What's New" panel for a version */
export interface WhatsNewShowMessage extends BaseMessage {
  type: 'whats-new:show';
  payload: { version: string };
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
  payload: { errorMessage: string; errorCode?: string; module: string; context?: Record<string, unknown> };
}

/** Response from AI error resolution with suggested fix */
export interface AIResolveErrorResponse extends BaseMessage {
  type: 'ai:resolve-error:response';
  payload: { success: boolean; resolution?: { explanation: string; suggestedFix: string; confidence: number }; error?: string };
}

/** AI personas */
export interface AIPersonasRequest extends BaseMessage {
  type: 'ai:personas';
  payload: { action: 'list' | 'create'; description?: string };
}

/** Response containing AI persona list or creation result */
export interface AIPersonasResponse extends BaseMessage {
  type: 'ai:personas:response';
  payload: { success: boolean; personas?: Array<{ id: string; name: string; description: string }>; error?: string };
}

/** AI anomaly detection */
export interface AIAnomalyScanRequest extends BaseMessage {
  type: 'ai:anomaly-scan';
  payload: { orgId: string; objectName: string; sampleSize?: number };
}

/** Response from AI anomaly scan with detected data anomalies */
export interface AIAnomalyScanResponse extends BaseMessage {
  type: 'ai:anomaly-scan:response';
  payload: { success: boolean; anomalies?: Array<{ field: string; type: string; description: string; severity: string }>; error?: string };
}

/** AI smart suggestions */
export interface AISuggestionsRequest extends BaseMessage {
  type: 'ai:suggestions';
  payload: { module: string; context?: Record<string, unknown> };
}

/** Response containing AI-generated smart suggestions for a module */
export interface AISuggestionsResponse extends BaseMessage {
  type: 'ai:suggestions:response';
  payload: { success: boolean; suggestions?: Array<{ title: string; description: string; action?: string }>; error?: string };
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

// ─── Standalone Feature Messages (Tier 3) ───────────────────────────────────

/** PII detection pre-check */
export interface PIIScanRequest extends BaseMessage {
  type: 'precheck:pii-scan';
  payload: { orgId: string; objectNames: string[] };
}

/** Response from PII detection scan with detected fields per object */
export interface PIIScanResponse extends BaseMessage {
  type: 'precheck:pii-scan:response';
  payload: {
    success: boolean;
    results?: Array<{
      objectName: string;
      piiFields: Array<{ fieldName: string; piiType: string; confidence: number }>;
    }>;
    error?: string;
  };
}

/** Plugin management */
export interface PluginsListRequest extends BaseMessage {
  type: 'plugins:list';
}

/** Response containing the list of installed plugins and their status */
export interface PluginsListResponse extends BaseMessage {
  type: 'plugins:list:response';
  payload: {
    success: boolean;
    plugins?: Array<{ name: string; version: string; description: string; enabled: boolean }>;
    error?: string;
  };
}

/** Request to load a plugin from a file path */
export interface PluginsLoadRequest extends BaseMessage {
  type: 'plugins:load';
  payload: { pluginPath: string };
}

/** Response after loading a plugin */
export interface PluginsLoadResponse extends BaseMessage {
  type: 'plugins:load:response';
  payload: { success: boolean; loadedPlugins?: string[]; error?: string };
}

/** Request to unload a plugin by name */
export interface PluginsUnloadRequest extends BaseMessage {
  type: 'plugins:unload';
  payload: { pluginName: string };
}

/** Response after unloading a plugin */
export interface PluginsUnloadResponse extends BaseMessage {
  type: 'plugins:unload:response';
  payload: { success: boolean; error?: string };
}

/** Telemetry management */
export interface TelemetryStatusRequest extends BaseMessage {
  type: 'telemetry:status';
}

/** Response containing current telemetry status and buffer metrics */
export interface TelemetryStatusResponse extends BaseMessage {
  type: 'telemetry:status:response';
  payload: { enabled: boolean; eventCount: number; bufferSize: number };
}

/** Request to enable or disable telemetry collection */
export interface TelemetryToggleRequest extends BaseMessage {
  type: 'telemetry:toggle';
  payload: { enabled: boolean };
}

/** Response after toggling telemetry */
export interface TelemetryToggleResponse extends BaseMessage {
  type: 'telemetry:toggle:response';
  payload: { success: boolean; enabled: boolean; error?: string };
}

/** Migration import (universal) */
export interface MigrationImportRequest extends BaseMessage {
  type: 'migration:import';
  payload: { filePath: string; format?: string };
}

/** Response after importing a migration file with detected format */
export interface MigrationImportResponse extends BaseMessage {
  type: 'migration:import:response';
  payload: { success: boolean; config?: Record<string, unknown>; detectedFormat?: string; error?: string };
}

/** Migration import (SFDMU) */
export interface MigrationImportSfdmuRequest extends BaseMessage {
  type: 'migration:import-sfdmu';
  payload: { filePath: string };
}

/** Response after importing an SFDMU export.json with detected dependencies */
export interface MigrationImportSfdmuResponse extends BaseMessage {
  type: 'migration:import-sfdmu:response';
  payload: { success: boolean; config?: Record<string, unknown>; dependencies?: Array<{ from: string; to: string }>; error?: string };
}

/** Pipeline marketplace */
export interface MarketplaceListRequest extends BaseMessage {
  type: 'marketplace:list';
  payload?: { category?: string; query?: string };
}

/** Response containing available marketplace pipeline templates */
export interface MarketplaceListResponse extends BaseMessage {
  type: 'marketplace:list:response';
  payload: {
    success: boolean;
    templates?: Array<{ id: string; name: string; description: string; category: string; author: string }>;
    error?: string;
  };
}

/** Request to install a pipeline template from the marketplace */
export interface MarketplaceInstallRequest extends BaseMessage {
  type: 'marketplace:install';
  payload: { templateId: string };
}

/** Response after installing a marketplace template */
export interface MarketplaceInstallResponse extends BaseMessage {
  type: 'marketplace:install:response';
  payload: { success: boolean; pipeline?: Record<string, unknown>; error?: string };
}

/** Connectivity status */
export interface ConnectivityStatusRequest extends BaseMessage {
  type: 'connectivity:status';
}

/** Response containing online/offline status and queued operation count */
export interface ConnectivityStatusResponse extends BaseMessage {
  type: 'connectivity:status:response';
  payload: { online: boolean; lastChecked: string; queueSize: number };
}

// ─── Live Operations Dashboard Messages ──────────────────────────────────────

/** Request to get the list of live operations. */
export interface LiveOperationsRequest extends BaseMessage {
  type: 'monitor:live-operations';
}

/** Live operation snapshot sent from extension to webview. */
export interface LiveOperationSnapshot {
  operationId: string;
  module: string;
  description: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  percentage: number;
  processedRecords: number;
  totalRecords: number;
  currentStep: string;
  startedAt: string;
  elapsedMs: number;
  recordsPerSecond: number;
  error?: string;
}

/** Response containing the list of live operations. */
export interface LiveOperationsResponse extends BaseMessage {
  type: 'monitor:live-operations:response';
  payload: { operations: LiveOperationSnapshot[] };
}

/** Push update when live operations change. */
export interface LiveOperationsUpdated extends BaseMessage {
  type: 'monitor:live-operations:updated';
  payload: { operations: LiveOperationSnapshot[] };
}

// ─── Config Profile Messages ─────────────────────────────────────────────────

/** Request to export a configuration profile. */
export interface ConfigExportRequest extends BaseMessage {
  type: 'config:export';
  payload: {
    categories: Array<'syncMappings' | 'forgePlans' | 'pipelines' | 'anonymizationTemplates' | 'settings'>;
  };
}

/** Response containing the exported profile JSON. */
export interface ConfigExportResponse extends BaseMessage {
  type: 'config:export:response';
  payload: {
    success: boolean;
    json?: string;
    categoriesExported: number;
    entriesExported: number;
    error?: string;
  };
}

/** Request to import a configuration profile. */
export interface ConfigImportRequest extends BaseMessage {
  type: 'config:import';
  payload: {
    json: string;
    overwrite: boolean;
  };
}

/** Response after importing a configuration profile. */
export interface ConfigImportResponse extends BaseMessage {
  type: 'config:import:response';
  payload: {
    success: boolean;
    categoriesImported: number;
    entriesImported: number;
    warnings: string[];
    error?: string;
  };
}

/** Request to list available config categories and their counts. */
export interface ConfigCategoriesRequest extends BaseMessage {
  type: 'config:categories';
}

/** Response containing config category counts. */
export interface ConfigCategoriesResponse extends BaseMessage {
  type: 'config:categories:response';
  payload: {
    categories: Array<{
      category: string;
      entryCount: number;
    }>;
  };
}

/** Request to validate a config profile JSON without importing. */
export interface ConfigValidateRequest extends BaseMessage {
  type: 'config:validate';
  payload: { json: string };
}

/** Response with validation results. */
export interface ConfigValidateResponse extends BaseMessage {
  type: 'config:validate:response';
  payload: {
    valid: boolean;
    categories?: string[];
    error?: string;
  };
}

// ─── Data Masking Template Messages ──────────────────────────────────────────

/** Request to get masking templates for a specific object. */
export interface MaskingTemplatesByObjectRequest extends BaseMessage {
  type: 'dataops:masking-templates-by-object';
  payload: { objectName: string };
}

/** Response containing masking templates for a specific object. */
export interface MaskingTemplatesByObjectResponse extends BaseMessage {
  type: 'dataops:masking-templates-by-object:response';
  payload: {
    objectName: string;
    templates: Array<{
      fieldApiName: string;
      ruleType: string;
      description: string;
      recommended: boolean;
    }>;
  };
}


// ─── Monitor Storage / Deployments / API Usage Messages ──────────────────────

/** Per-object storage entry returned by monitor:storage. */
export interface StorageObjectEntry {
  objectName: string;
  recordCount: number;
  label: string;
}

/** Request to fetch per-object storage breakdown. */
export interface MonitorStorageRequest extends BaseMessage {
  type: 'monitor:storage';
  payload: { orgId: string };
}

/** Response containing per-object storage breakdown. */
export interface MonitorStorageResponse extends BaseMessage {
  type: 'monitor:storage:response';
  payload: {
    success: boolean;
    objects: StorageObjectEntry[];
    totalRecords: number;
    error?: string;
  };
}

/** Deployment entry for the deployment timeline. */
export interface DeploymentEntry {
  id: string;
  status: 'Succeeded' | 'Failed' | 'Canceled' | 'InProgress' | 'Pending';
  startDate: string;
  completedDate?: string;
  createdBy: string;
  componentCount: number;
  errorCount: number;
}

/** Request to fetch recent deployments. */
export interface MonitorDeploymentsRequest extends BaseMessage {
  type: 'monitor:deployments';
  payload: { orgId: string };
}

/** Response containing recent deployments. */
export interface MonitorDeploymentsResponse extends BaseMessage {
  type: 'monitor:deployments:response';
  payload: {
    success: boolean;
    deployments: DeploymentEntry[];
    error?: string;
  };
}

/** Per-category API usage entry. */
export interface ApiUsageCategory {
  category: string;
  used: number;
  max: number;
  usedPercent: number;
}

/** Request to fetch per-category API usage breakdown. */
export interface MonitorApiUsageRequest extends BaseMessage {
  type: 'monitor:api-usage';
  payload: { orgId: string };
}

/** Response containing per-category API usage. */
export interface MonitorApiUsageResponse extends BaseMessage {
  type: 'monitor:api-usage:response';
  payload: {
    success: boolean;
    categories: ApiUsageCategory[];
    error?: string;
  };
}

// --- Monitor Service Panels ---

/** Request to fetch recent error log entries for an org. */
export interface MonitorErrorLogsRequest extends BaseMessage {
  type: 'monitor:error-logs';
  payload: { orgId: string };
}

/** Response containing recent error log entries grouped by type. */
export interface MonitorErrorLogsResponse extends BaseMessage {
  type: 'monitor:error-logs:response';
  payload: {
    success: boolean;
    errors: Array<{
      id: string;
      errorType: string;
      message: string;
      stackTrace?: string;
      timestamp: string;
      user?: string;
      context?: string;
    }>;
    errorsByType: Array<{ type: string; count: number }>;
    totalCount: number;
    error?: string;
  };
}

/** Request to fetch active user sessions for an org. */
export interface MonitorSessionsRequest extends BaseMessage {
  type: 'monitor:sessions';
  payload: { orgId: string };
}

/** Response containing active user sessions and distinct user count. */
export interface MonitorSessionsResponse extends BaseMessage {
  type: 'monitor:sessions:response';
  payload: {
    success: boolean;
    sessions: Array<{
      userId: string;
      username: string;
      sessionType: string;
      loginTime: string;
      sourceIp: string;
    }>;
    activeUserCount: number;
    error?: string;
  };
}

/** Request to fetch Apex log analysis insights for an org. */
export interface MonitorApexInsightsRequest extends BaseMessage {
  type: 'monitor:apex-insights';
  payload: { orgId: string };
}

/** Response containing Apex log analyses and top performance issues. */
export interface MonitorApexInsightsResponse extends BaseMessage {
  type: 'monitor:apex-insights:response';
  payload: {
    success: boolean;
    analyses: Array<{
      logId: string;
      totalDuration: number;
      soqlQueries: number;
      dmlStatements: number;
      heapUsed: number;
      cpuTime: number;
      issues: Array<{
        type: string;
        severity: string;
        message: string;
        line?: number;
      }>;
    }>;
    topIssues: Array<{
      type: string;
      severity: string;
      message: string;
      line?: number;
    }>;
    error?: string;
  };
}

/** Request to fetch sandbox refresh events for an org. */
export interface MonitorSandboxRefreshRequest extends BaseMessage {
  type: 'monitor:sandbox-refresh';
  payload: { orgId: string };
}

/** Response containing sandbox refresh events and in-progress status. */
export interface MonitorSandboxRefreshResponse extends BaseMessage {
  type: 'monitor:sandbox-refresh:response';
  payload: {
    success: boolean;
    refreshes: Array<{
      orgId: string;
      sandboxName: string;
      refreshDate: string;
      status: string;
      sourceOrg?: string;
    }>;
    inProgress: boolean;
    error?: string;
  };
}

// ─── Org Health Score Messages ────────────────────────────────────────────────

/** Request to compute the full org health score. */
export interface OrgHealthScoreRequest extends BaseMessage {
  type: 'monitor:health-score';
  payload: { orgId: string };
}

/** Dimension score within the org health radar. */
export interface OrgHealthDimension {
  name: string;
  score: number;
  label: string;
  detail: string;
  recommendation: string;
}

/** Response containing the org health score breakdown. */
export interface OrgHealthScoreResponse extends BaseMessage {
  type: 'monitor:health-score:response';
  payload: {
    success: boolean;
    overallScore: number;
    dimensions: OrgHealthDimension[];
    recommendations: string[];
    error?: string;
  };
}

// ─── Batch Operation Scheduler Messages ──────────────────────────────────────

/** Frequency for scheduled operations. */
export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** Operation type that can be scheduled. */
export type SchedulableOperation = 'backup' | 'sync' | 'cleanup';

/** A scheduled operation definition. */
export interface ScheduledOperation {
  id: string;
  operationType: SchedulableOperation;
  frequency: ScheduleFrequency;
  time: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

/** A history entry for a completed scheduled operation. */
export interface ScheduledOperationRun {
  id: string;
  scheduleId: string;
  operationType: SchedulableOperation;
  status: 'success' | 'failure' | 'partial';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  recordsProcessed: number;
  error?: string;
}

/** Request to list all scheduled operations. */
export interface SchedulerListRequest extends BaseMessage {
  type: 'scheduler:list';
}

/** Response containing all scheduled operations. */
export interface SchedulerListResponse extends BaseMessage {
  type: 'scheduler:list:response';
  payload: {
    schedules: ScheduledOperation[];
    history: ScheduledOperationRun[];
  };
}

/** Request to create or update a scheduled operation. */
export interface SchedulerUpsertRequest extends BaseMessage {
  type: 'scheduler:upsert';
  payload: {
    schedule: Omit<ScheduledOperation, 'lastRunAt' | 'nextRunAt'>;
  };
}

/** Response after creating or updating a scheduled operation. */
export interface SchedulerUpsertResponse extends BaseMessage {
  type: 'scheduler:upsert:response';
  payload: {
    success: boolean;
    schedule?: ScheduledOperation;
    error?: string;
  };
}

/** Request to delete a scheduled operation. */
export interface SchedulerDeleteRequest extends BaseMessage {
  type: 'scheduler:delete';
  payload: { scheduleId: string };
}

/** Response after deleting a scheduled operation. */
export interface SchedulerDeleteResponse extends BaseMessage {
  type: 'scheduler:delete:response';
  payload: {
    success: boolean;
    error?: string;
  };
}

/** Request to toggle a scheduled operation on/off. */
export interface SchedulerToggleRequest extends BaseMessage {
  type: 'scheduler:toggle';
  payload: { scheduleId: string; enabled: boolean };
}

/** Response after toggling a scheduled operation. */
export interface SchedulerToggleResponse extends BaseMessage {
  type: 'scheduler:toggle:response';
  payload: {
    success: boolean;
    schedule?: ScheduledOperation;
    error?: string;
  };
}

// ─── Real-Time CDC Sync Messages ─────────────────────────────────────────────

/** Request to start a real-time CDC sync session. */
export interface RealTimeStartRequest extends BaseMessage {
  type: 'realtime:start';
  payload: {
    sourceOrgId: string;
    targetOrgId: string;
    watchedObjects: string[];
    conflictStrategy: string;
    flushIntervalMs: number;
    maxBatchSize: number;
  };
}

/** Request to stop a real-time CDC sync session. */
export interface RealTimeStopRequest extends BaseMessage {
  type: 'realtime:stop';
  payload: { sessionId: string };
}

/** Request to get the current real-time sync status. */
export interface RealTimeStatusRequest extends BaseMessage {
  type: 'realtime:status';
}

/** Request to get real-time sync metrics. */
export interface RealTimeMetricsRequest extends BaseMessage {
  type: 'realtime:metrics';
}

/** Request to resolve a real-time sync conflict. */
export interface RealTimeResolveConflictRequest extends BaseMessage {
  type: 'realtime:resolve-conflict';
  payload: {
    eventReplayId: number;
    resolution: string;
  };
}

/** Response confirming a real-time sync session has started. */
export interface RealTimeStartedResponse extends BaseMessage {
  type: 'realtime:started';
  payload: {
    sessionId: string;
    watchedObjects: string[];
  };
}

/** Response confirming a real-time sync session has stopped. */
export interface RealTimeStoppedResponse extends BaseMessage {
  type: 'realtime:stopped';
  payload: {
    sessionId: string;
    reason: string;
  };
}

/** Push event when a CDC change is received and processed. */
export interface RealTimeCDCEventMessage extends BaseMessage {
  type: 'realtime:event';
  payload: {
    replayId: number;
    objectApiName: string;
    changeType: string;
    recordIds: string[];
    commitTimestamp: string;
    applied: boolean;
    error?: string;
  };
}

/** Response containing the current real-time sync status. */
export interface RealTimeStatusResponse extends BaseMessage {
  type: 'realtime:status:response';
  payload: {
    status: string;
    sessionId?: string;
    watchedObjects: string[];
    error?: string;
  };
}

/** Response containing real-time sync metrics. */
export interface RealTimeMetricsResponse extends BaseMessage {
  type: 'realtime:metrics:response';
  payload: {
    eventsReceived: number;
    eventsApplied: number;
    eventsFailed: number;
    eventsPerMinute: number;
    averageLagMs: number;
    currentLagMs: number;
    errorRate: number;
    startedAt: string;
    lastEventAt?: string;
  };
}

/** Push event when a conflict is detected during real-time sync. */
export interface RealTimeConflictDetected extends BaseMessage {
  type: 'realtime:conflict';
  payload: {
    replayId: number;
    objectApiName: string;
    recordIds: string[];
    changeType: string;
    sourceValues: Record<string, unknown>;
    targetValues: Record<string, unknown>;
    targetLastModified: string;
  };
}

