/**
 * Domain-split message protocol — public entry point is `../messages.types.ts`.
 *
 * Each `<domain>.messages.ts` file owns the message interfaces for one domain.
 * This index re-exports them all and composes the two directional unions
 * ({@link WebViewToExtensionMessage} / {@link ExtensionToWebViewMessage}).
 *
 * `types/messages/coverage.test.ts` statically verifies that every
 * `type: '...'` literal declared in a domain file is a member of at least one
 * of the two unions — keep both in sync when adding a message.
 * `types/messages/emittedChannels.test.ts` additionally verifies that every
 * channel the extension actually emits is declared here.
 */

export * from './base.messages.js';
export * from './bridge.messages.js';
export * from './org.messages.js';
export * from './seed.messages.js';
export * from './sync.messages.js';
export * from './monitor.messages.js';
export * from './compare.messages.js';
export * from './dataops.messages.js';
export * from './automation.messages.js';
export * from './autopilot.messages.js';
export * from './forge.messages.js';
export * from './ai.messages.js';
export * from './settings.messages.js';
export * from './operation.messages.js';
export * from './scheduler.messages.js';
export * from './realtime.messages.js';
export * from './cache.messages.js';
export * from './smart-action.messages.js';
export * from './frozen.messages.js';

import type {
  OrgListRequest,
  OrgConnectRequest,
  OrgDisconnectRequest,
  OrgListResponse,
  OrgStatusChanged,
  OrgSelected,
  OrgErrorResponse,
} from './org.messages.js';
import type {
  BridgeErrorMessage,
  BridgeProtocolMismatchMessage,
  BridgeReloadBannerMessage,
  WorkbenchReloadRequest,
  ErrorBoundaryReport,
} from './bridge.messages.js';
import type {
  SeedExecuteRequest,
  SeedDescribeGlobalRequest,
  SeedDescribeObjectRequest,
  SeedTemplateSaveRequest,
  SeedTemplateLoadRequest,
  SeedTemplateListRequest,
  SeedTemplateDeleteRequest,
  SeedTemplateSaveResponse,
  SeedTemplateLoadResponse,
  SeedTemplateListResponse,
  SeedTemplateDeleteResponse,
  SeedCsvExecuteRequest,
  SeedCsvValidateRequest,
  SeedCsvValidateResponse,
  SeedCsvExecuteResponse,
  SeedCsvErrorResponse,
  SeedCloneExecuteRequest,
  SeedClonePreviewRequest,
  SeedCloneDescribeSourceRequest,
  SeedClonePreviewResponse,
  SeedCloneDescribeSourceResponse,
  SeedCloneExecuteResponse,
  SeedCloneErrorResponse,
  SeedListPersonasRequest,
  SeedCreatePersonaRequest,
  SeedListPersonasResponse,
  SeedCreatePersonaResponse,
  SeedExecuteResponse,
  SeedDescribeGlobalResponse,
  SeedDescribeObjectResponse,
  SeedErrorResponse,
} from './seed.messages.js';
import type {
  SyncExecuteRequest,
  SyncDescribeGlobalRequest,
  SyncDescribeFieldsRequest,
  SyncExecuteResponse,
  SyncDescribeGlobalResponse,
  SyncDescribeFieldsResponse,
  SyncErrorResponse,
  SyncConfigSaveRequest,
  SyncConfigLoadRequest,
  SyncConfigListRequest,
  SyncConfigDeleteRequest,
  SyncConfigSaveResponse,
  SyncConfigLoadResponse,
  SyncConfigListResponse,
  SyncConfigDeleteResponse,
  SyncHistoryListRequest,
  SyncHistoryDetailRequest,
  SyncHistoryRerunRequest,
  SyncHistoryExportRequest,
  SyncHistoryListResponse,
  SyncHistoryDetailResponse,
  SyncHistoryExportResponse,
  SyncHistoryErrorResponse,
  SyncScheduleListRequest,
  SyncScheduleUpsertRequest,
  SyncScheduleToggleRequest,
  SyncScheduleDeleteRequest,
  SyncScheduleListResponse,
  SyncScheduleUpsertResponse,
  SyncScheduleToggleResponse,
  SyncScheduleDeleteResponse,
  SyncScheduleErrorResponse,
} from './sync.messages.js';
import type {
  MonitorRefreshRequest,
  MonitorStartRequest,
  MonitorTrendsRequest,
  MonitorDataMessage,
  MonitorTrendsDataMessage,
  MonitorErrorResponse,
  MonitorAbortJobRequest,
  MonitorAbortJobResponse,
  MonitorAlertsRequest,
  MonitorAlertsResultMessage,
  MonitorAlertAcknowledgeRequest,
  MonitorAlertAcknowledgeResponse,
  MonitorAlertDismissRequest,
  MonitorAlertDismissResponse,
  LiveOperationsRequest,
  LiveOperationsResponse,
  MonitorStorageRequest,
  MonitorStorageResponse,
  MonitorDeploymentsRequest,
  MonitorDeploymentsResponse,
  MonitorApiUsageRequest,
  MonitorApiUsageResponse,
  MonitorErrorLogsRequest,
  MonitorErrorLogsResponse,
  MonitorSessionsRequest,
  MonitorSessionsResponse,
  MonitorApexInsightsRequest,
  MonitorApexInsightsResponse,
  MonitorSandboxRefreshRequest,
  MonitorSandboxRefreshResponse,
  OrgHealthScoreRequest,
  OrgHealthScoreResponse,
} from './monitor.messages.js';
import type {
  CompareExecuteRequest,
  CompareExecuteResponse,
  ComparePermissionsResponse,
  CompareSnapshotsResponse,
  CompareDriftResponse,
  CompareErrorResponse,
} from './compare.messages.js';
import type {
  CompareStartRequest,
  ComparePermissionsRequest,
  CompareSnapshotsRequest,
  CompareDriftRequest,
} from './compare.messages.js';
import type {
  BackupExecuteRequest,
  AnonymizationTemplatesRequest,
  AnonymizationTemplatesResponse,
  MaskingTemplatesByObjectRequest,
  MaskingTemplatesByObjectResponse,
  PIIScanRequest,
  PIIScanResponse,
  DataOpsBackupRequest,
  DataOpsRollbackRequest,
  DataOpsAnonymizeRequest,
  DataOpsBackupResponse,
  DataOpsRollbackResponse,
  DataOpsAnonymizeResponse,
  DataOpsErrorResponse,
  GovernancePoliciesListRequest,
  GovernancePoliciesListResult,
  GovernancePolicyGetRequest,
  GovernancePolicySaveRequest,
  GovernancePolicyDeleteRequest,
  GovernancePoliciesExportRequest,
  GovernancePoliciesImportRequest,
  GovernanceEvaluateRequest,
  GovernanceTemplatesRequest,
  GovernancePolicyResult,
  GovernancePolicySaveResponse,
  GovernancePolicyDeleteResponse,
  GovernancePoliciesExportResponse,
  GovernancePoliciesImportResponse,
  GovernanceEvaluateResponse,
  GovernanceTemplatesResponse,
  GovernanceErrorResponse,
} from './dataops.messages.js';
import type {
  PipelineRunRequest,
  PipelineRunResponse,
  PipelineErrorResponse,
  PipelineTemplatesRequest,
  PipelineTemplatesResponse,
  PipelineExecuteRequest,
  PipelineListRequest,
  PipelineListResponse,
  PipelineHistoryRequest,
  PipelineHistoryResponse,
  PipelineSaveRequest,
  PipelineSaveResponse,
  MigrationImportRequest,
  MigrationImportResponse,
  MigrationImportSfdmuRequest,
  MigrationImportSfdmuResponse,
  MigrationErrorResponse,
  MarketplaceListRequest,
  MarketplaceListResponse,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  PluginsListRequest,
  PluginsListResponse,
  PluginsLoadRequest,
  PluginsLoadResponse,
  PluginsUnloadRequest,
  PluginsUnloadResponse,
} from './automation.messages.js';
import type {
  AutopilotScanSchemaRequest,
  AutopilotGeneratePlanRequest,
  AutopilotExecuteRequest,
  AutopilotPauseRequest,
  AutopilotResumeRequest,
  AutopilotSkipNodeRequest,
  AutopilotSchemaResult,
  AutopilotPlanReady,
  AutopilotNodeProgress,
  AutopilotNodeCompleted,
  AutopilotNodeFailed,
  AutopilotCompleted,
  AutopilotComplianceReportReady,
  AutopilotErrorResponse,
} from './autopilot.messages.js';
import type {
  ForgePreviewRequest,
  ForgeDiscoverRequest,
  ForgeExecuteRequest,
  ForgePauseRequest,
  ForgeResumeRequest,
  ForgeAbortRequest,
  ForgeTemplatesListRequest,
  ForgeTemplatesSaveRequest,
  ForgeTemplatesDeleteRequest,
  ForgeHistoryListRequest,
  ForgePlanRequest,
  ForgeComplianceRequest,
  ForgeMetadataDiffRequest,
  ForgeTargetPreflightRequest,
  ForgeTargetPreflightResponse,
  ForgeTargetPreflightErrorMessage,
  ForgePreviewResponse,
  ForgePreviewErrorMessage,
  ForgeDiscoverResponse,
  ForgeDiscoverProgressMessage,
  ForgeDiscoverErrorMessage,
  ForgeExecuteResponse,
  ForgeProgressMessage,
  ForgeExecuteErrorMessage,
  ForgeTemplatesListResponse,
  ForgeTemplatesSaveResponse,
  ForgeTemplatesSaveErrorMessage,
  ForgeTemplatesDeleteResponse,
  ForgeTemplatesDeleteErrorMessage,
  ForgeHistoryListResponse,
  ForgePlanResponse,
  ForgePlanErrorMessage,
  ForgeComplianceResponse,
  ForgeComplianceErrorMessage,
  ForgeMetadataDiffResponse,
  ForgeMetadataDiffErrorMessage,
} from './forge.messages.js';
import type {
  AIChatRequest,
  AIConversationCreateRequest,
  AIConversationLoadRequest,
  AIConversationDeleteRequest,
  AIConversationListRequest,
  AIStatusRequest,
  AISaveKeyRequest,
  AIChatResponse,
  AIConversationCreatedResponse,
  AIConversationLoadedResponse,
  AIConversationDeletedResponse,
  AIConversationListResponse,
  AIErrorResponse,
  AIStatusResponse,
  AISaveKeyResponse,
  AINL2SOQLRequest,
  AINL2SOQLResponse,
  AIResolveErrorRequest,
  AIResolveErrorResponse,
  AIPersonasRequest,
  AIPersonasResponse,
  AIAnomalyScanRequest,
  AIAnomalyScanResponse,
  AISuggestionsRequest,
  AISuggestionsResponse,
  AIGeneratePipelineRequest,
  AIGeneratePipelineResponse,
  AISchemaAdviceRequest,
  AISchemaAdviceResponse,
  AIProviderStatusMessage,
  AIDiagnoseRequestMessage,
  AIDiagnoseResponseMessage,
  AIApproveActionRequestMessage,
  AIApproveActionResponseMessage,
  AIBudgetStateMessage,
  AIBudgetWarnMessage,
  AIBudgetExceededMessage,
} from './ai.messages.js';
import type {
  SettingsGetRequest,
  SettingsUpdateRequest,
  SettingsResponse,
  NotificationMessage,
  OnboardingCompleteRequest,
  OnboardingResetRequest,
  OnboardingShowMessage,
  HintDismissRequest,
  WhatsNewShowMessage,
  TelemetryStatusRequest,
  TelemetryStatusResponse,
  TelemetryToggleRequest,
  TelemetryToggleResponse,
  ConnectivityStatusRequest,
  ConnectivityStatusResponse,
  ConfigExportRequest,
  ConfigExportResponse,
  ConfigImportRequest,
  ConfigImportResponse,
  ConfigCategoriesRequest,
  ConfigCategoriesResponse,
  ConfigValidateRequest,
  ConfigValidateResponse,
  StateSyncMessage,
  SettingsErrorResponse,
  ConfigErrorResponse,
  EasterEggShowMessage,
} from './settings.messages.js';
import type {
  CancelOperationRequest,
  PauseOperationRequest,
  ResumeOperationRequest,
  OperationStarted,
  OperationProgress,
  OperationCompleted,
  OperationFailed,
  GrappeStarted,
  GrappePartitionProgress,
  GrappeBackPressure,
  GrappeCompleted,
  ExecutionProgressMessage,
  ExecutionRetryStatusMessage,
  ExecutionManualRetryRequest,
  ExecutionAbortRequest,
  ExecutionStatusRequest,
  ExecutionListRequest,
  ExecutionAbortResponse,
  ExecutionStatusResponse,
  ExecutionListResponse,
  ExecutionErrorResponse,
} from './operation.messages.js';
import type {
  SchedulerListRequest,
  SchedulerUpsertRequest,
  SchedulerDeleteRequest,
  SchedulerToggleRequest,
  SchedulerListResponse,
  SchedulerUpsertResponse,
  SchedulerDeleteResponse,
  SchedulerToggleResponse,
} from './scheduler.messages.js';
import type {
  RealTimeStartRequest,
  RealTimeStopRequest,
  RealTimeStatusRequest,
  RealTimeMetricsRequest,
  RealTimeResolveConflictRequest,
  RealTimeStartedResponse,
  RealTimeStoppedResponse,
  RealTimeCDCEventMessage,
  RealTimeEventsBatchMessage,
  RealTimeStatusResponse,
  RealTimeMetricsResponse,
  RealTimeConflictDetected,
  RealTimeConflictResolvedResponse,
} from './realtime.messages.js';
import type {
  CacheInvalidateAllRequest,
  CacheInvalidateAllResponse,
  CacheGetStatsRequest,
  CacheStatsResponse,
} from './cache.messages.js';
import type {
  SmartActionAnalyzeRequest,
  SmartActionAnalyzeResponse,
  SmartActionErrorResponse,
  QuickSyncSuggestObjectsRequest,
  QuickSyncDetectRelationshipsRequest,
  QuickSyncPreviewRequest,
  QuickSyncExecuteRequest,
  QuickSyncSuggestObjectsResponse,
  QuickSyncDetectRelationshipsResponse,
  QuickSyncPreviewResponse,
  QuickSyncExecuteResponse,
  QuickSyncErrorResponse,
} from './smart-action.messages.js';
import type {
  FrozenConfigGetRequest,
  FrozenConfigSaveRequest,
  FrozenSelectRequest,
  FrozenExtractRequest,
  FrozenManifestGetRequest,
  FrozenLoadRequest,
  FrozenVerifyRequest,
  FrozenStatusRequest,
  FrozenConfigGetResponse,
  FrozenConfigSaveResponse,
  FrozenSelectResponse,
  FrozenExtractResponse,
  FrozenControlResultMessage,
  FrozenManifestGetResponse,
  FrozenLoadResponse,
  FrozenLoadProgressMessage,
  FrozenVerifyResultMessage,
  FrozenStatusResponse,
  FrozenConfigSaveErrorMessage,
  FrozenSelectErrorMessage,
  FrozenExtractErrorMessage,
  FrozenLoadErrorMessage,
  FrozenVerifyErrorMessage,
} from './frozen.messages.js';

/** Message from WebView to Extension (requests) */
export type WebViewToExtensionMessage =
  // Org
  | OrgListRequest
  | OrgConnectRequest
  | OrgDisconnectRequest
  // Seed
  | SeedExecuteRequest
  | SeedDescribeGlobalRequest
  | SeedDescribeObjectRequest
  | SeedTemplateSaveRequest
  | SeedTemplateLoadRequest
  | SeedTemplateListRequest
  | SeedTemplateDeleteRequest
  | SeedCsvExecuteRequest
  | SeedCsvValidateRequest
  | SeedCloneExecuteRequest
  | SeedClonePreviewRequest
  | SeedCloneDescribeSourceRequest
  | SeedListPersonasRequest
  | SeedCreatePersonaRequest
  // Sync
  | SyncExecuteRequest
  | SyncDescribeGlobalRequest
  | SyncDescribeFieldsRequest
  | SyncConfigSaveRequest
  | SyncConfigLoadRequest
  | SyncConfigListRequest
  | SyncConfigDeleteRequest
  | SyncHistoryListRequest
  | SyncHistoryDetailRequest
  | SyncHistoryRerunRequest
  | SyncHistoryExportRequest
  | SyncScheduleListRequest
  | SyncScheduleUpsertRequest
  | SyncScheduleToggleRequest
  | SyncScheduleDeleteRequest
  // Monitor
  | MonitorRefreshRequest
  | MonitorStartRequest
  | MonitorTrendsRequest
  | MonitorAbortJobRequest
  | MonitorAlertsRequest
  | MonitorAlertAcknowledgeRequest
  | MonitorAlertDismissRequest
  | LiveOperationsRequest
  | MonitorStorageRequest
  | MonitorDeploymentsRequest
  | MonitorApiUsageRequest
  | MonitorErrorLogsRequest
  | MonitorSessionsRequest
  | MonitorApexInsightsRequest
  | MonitorSandboxRefreshRequest
  | OrgHealthScoreRequest
  // Compare + DataOps
  | CompareExecuteRequest
  | CompareStartRequest
  | ComparePermissionsRequest
  | CompareSnapshotsRequest
  | CompareDriftRequest
  | BackupExecuteRequest
  | AnonymizationTemplatesRequest
  | MaskingTemplatesByObjectRequest
  | PIIScanRequest
  | DataOpsBackupRequest
  | DataOpsRollbackRequest
  | DataOpsAnonymizeRequest
  // Governance
  | GovernancePoliciesListRequest
  | GovernancePolicyGetRequest
  | GovernancePolicySaveRequest
  | GovernancePolicyDeleteRequest
  | GovernancePoliciesExportRequest
  | GovernancePoliciesImportRequest
  | GovernanceEvaluateRequest
  | GovernanceTemplatesRequest
  // Automation (pipeline + marketplace + migration + plugins)
  | PipelineRunRequest
  | PipelineExecuteRequest
  | PipelineListRequest
  | PipelineHistoryRequest
  | PipelineSaveRequest
  | PipelineTemplatesRequest
  | MigrationImportRequest
  | MigrationImportSfdmuRequest
  | MarketplaceListRequest
  | MarketplaceInstallRequest
  | PluginsListRequest
  | PluginsLoadRequest
  | PluginsUnloadRequest
  // Autopilot
  | AutopilotScanSchemaRequest
  | AutopilotGeneratePlanRequest
  | AutopilotExecuteRequest
  | AutopilotPauseRequest
  | AutopilotResumeRequest
  | AutopilotSkipNodeRequest
  // Forge
  | ForgePreviewRequest
  | ForgeDiscoverRequest
  | ForgeExecuteRequest
  | ForgePauseRequest
  | ForgeResumeRequest
  | ForgeAbortRequest
  | ForgeTemplatesListRequest
  | ForgeTemplatesSaveRequest
  | ForgeTemplatesDeleteRequest
  | ForgeHistoryListRequest
  | ForgePlanRequest
  | ForgeComplianceRequest
  | ForgeMetadataDiffRequest
  | ForgeTargetPreflightRequest
  // AI
  | AIChatRequest
  | AIConversationCreateRequest
  | AIConversationLoadRequest
  | AIConversationDeleteRequest
  | AIConversationListRequest
  | AIStatusRequest
  | AISaveKeyRequest
  | AINL2SOQLRequest
  | AIResolveErrorRequest
  | AIPersonasRequest
  | AIAnomalyScanRequest
  | AISuggestionsRequest
  | AIGeneratePipelineRequest
  | AISchemaAdviceRequest
  | AIDiagnoseRequestMessage
  | AIApproveActionRequestMessage
  // Settings
  | SettingsGetRequest
  | SettingsUpdateRequest
  | OnboardingCompleteRequest
  | OnboardingResetRequest
  | HintDismissRequest
  | TelemetryStatusRequest
  | TelemetryToggleRequest
  | ConnectivityStatusRequest
  | ConfigExportRequest
  | ConfigImportRequest
  | ConfigCategoriesRequest
  | ConfigValidateRequest
  // Operation lifecycle
  | CancelOperationRequest
  | PauseOperationRequest
  | ResumeOperationRequest
  | ExecutionManualRetryRequest
  | ExecutionAbortRequest
  | ExecutionStatusRequest
  | ExecutionListRequest
  // Bridge control
  | WorkbenchReloadRequest
  | ErrorBoundaryReport
  // Scheduler
  | SchedulerListRequest
  | SchedulerUpsertRequest
  | SchedulerDeleteRequest
  | SchedulerToggleRequest
  // Realtime (CDC)
  | RealTimeStartRequest
  | RealTimeStopRequest
  | RealTimeStatusRequest
  | RealTimeMetricsRequest
  | RealTimeResolveConflictRequest
  // Cache
  | CacheInvalidateAllRequest
  | CacheGetStatsRequest
  // Smart Action
  | SmartActionAnalyzeRequest
  // QuickSync
  | QuickSyncSuggestObjectsRequest
  | QuickSyncDetectRelationshipsRequest
  | QuickSyncPreviewRequest
  | QuickSyncExecuteRequest
  // Frozen Reference Dataset
  | FrozenConfigGetRequest
  | FrozenConfigSaveRequest
  | FrozenSelectRequest
  | FrozenExtractRequest
  | FrozenManifestGetRequest
  | FrozenLoadRequest
  | FrozenVerifyRequest
  | FrozenStatusRequest;

/** Message from Extension to WebView (responses / events) */
export type ExtensionToWebViewMessage =
  // Org
  | OrgListResponse
  | OrgStatusChanged
  | OrgSelected
  | OrgErrorResponse
  // Bridge control
  | BridgeErrorMessage
  | BridgeProtocolMismatchMessage
  | BridgeReloadBannerMessage
  // Seed
  | SeedTemplateSaveResponse
  | SeedTemplateLoadResponse
  | SeedTemplateListResponse
  | SeedTemplateDeleteResponse
  | SeedCsvValidateResponse
  | SeedCsvExecuteResponse
  | SeedCsvErrorResponse
  | SeedClonePreviewResponse
  | SeedCloneDescribeSourceResponse
  | SeedCloneExecuteResponse
  | SeedCloneErrorResponse
  | SeedListPersonasResponse
  | SeedCreatePersonaResponse
  | SeedExecuteResponse
  | SeedDescribeGlobalResponse
  | SeedDescribeObjectResponse
  | SeedErrorResponse
  // Sync
  | SyncConfigSaveResponse
  | SyncConfigLoadResponse
  | SyncConfigListResponse
  | SyncConfigDeleteResponse
  | SyncHistoryListResponse
  | SyncHistoryDetailResponse
  | SyncHistoryExportResponse
  | SyncHistoryErrorResponse
  | SyncScheduleListResponse
  | SyncScheduleUpsertResponse
  | SyncScheduleToggleResponse
  | SyncScheduleDeleteResponse
  | SyncExecuteResponse
  | SyncDescribeGlobalResponse
  | SyncDescribeFieldsResponse
  | SyncErrorResponse
  | SyncScheduleErrorResponse
  // Monitor
  | MonitorAbortJobResponse
  | MonitorAlertsResultMessage
  | MonitorAlertAcknowledgeResponse
  | MonitorAlertDismissResponse
  | LiveOperationsResponse
  | MonitorStorageResponse
  | MonitorDeploymentsResponse
  | MonitorApiUsageResponse
  | MonitorErrorLogsResponse
  | MonitorSessionsResponse
  | MonitorApexInsightsResponse
  | MonitorSandboxRefreshResponse
  | OrgHealthScoreResponse
  | MonitorDataMessage
  | MonitorTrendsDataMessage
  | MonitorErrorResponse
  // Compare
  | CompareExecuteResponse
  | ComparePermissionsResponse
  | CompareSnapshotsResponse
  | CompareDriftResponse
  | CompareErrorResponse
  // DataOps
  | AnonymizationTemplatesResponse
  | MaskingTemplatesByObjectResponse
  | PIIScanResponse
  | DataOpsBackupResponse
  | DataOpsRollbackResponse
  | DataOpsAnonymizeResponse
  | DataOpsErrorResponse
  // Governance
  | GovernancePoliciesListResult
  | GovernancePolicyResult
  | GovernancePolicySaveResponse
  | GovernancePolicyDeleteResponse
  | GovernancePoliciesExportResponse
  | GovernancePoliciesImportResponse
  | GovernanceEvaluateResponse
  | GovernanceTemplatesResponse
  | GovernanceErrorResponse
  // Automation
  | PipelineTemplatesResponse
  | PipelineListResponse
  | PipelineHistoryResponse
  | PipelineSaveResponse
  | PipelineRunResponse
  | PipelineErrorResponse
  | MigrationImportResponse
  | MigrationImportSfdmuResponse
  | MigrationErrorResponse
  | MarketplaceListResponse
  | MarketplaceInstallResponse
  | PluginsListResponse
  | PluginsLoadResponse
  | PluginsUnloadResponse
  // Autopilot
  | AutopilotSchemaResult
  | AutopilotPlanReady
  | AutopilotNodeProgress
  | AutopilotNodeCompleted
  | AutopilotNodeFailed
  | AutopilotCompleted
  | AutopilotComplianceReportReady
  | AutopilotErrorResponse
  // Forge
  | ForgeTargetPreflightResponse
  | ForgeTargetPreflightErrorMessage
  | ForgePreviewResponse
  | ForgePreviewErrorMessage
  | ForgeDiscoverResponse
  | ForgeDiscoverProgressMessage
  | ForgeDiscoverErrorMessage
  | ForgeExecuteResponse
  | ForgeProgressMessage
  | ForgeExecuteErrorMessage
  | ForgeTemplatesListResponse
  | ForgeTemplatesSaveResponse
  | ForgeTemplatesSaveErrorMessage
  | ForgeTemplatesDeleteResponse
  | ForgeTemplatesDeleteErrorMessage
  | ForgeHistoryListResponse
  | ForgePlanResponse
  | ForgePlanErrorMessage
  | ForgeComplianceResponse
  | ForgeComplianceErrorMessage
  | ForgeMetadataDiffResponse
  | ForgeMetadataDiffErrorMessage
  // AI
  | AIChatResponse
  | AIConversationCreatedResponse
  | AIConversationLoadedResponse
  | AIConversationDeletedResponse
  | AIConversationListResponse
  | AIErrorResponse
  | AIStatusResponse
  | AISaveKeyResponse
  | AINL2SOQLResponse
  | AIResolveErrorResponse
  | AIPersonasResponse
  | AIAnomalyScanResponse
  | AISuggestionsResponse
  | AIGeneratePipelineResponse
  | AISchemaAdviceResponse
  | AIProviderStatusMessage
  | AIDiagnoseResponseMessage
  | AIApproveActionResponseMessage
  | AIBudgetStateMessage
  | AIBudgetWarnMessage
  | AIBudgetExceededMessage
  // Settings
  | SettingsResponse
  | NotificationMessage
  | OnboardingShowMessage
  | WhatsNewShowMessage
  | TelemetryStatusResponse
  | TelemetryToggleResponse
  | ConnectivityStatusResponse
  | ConfigExportResponse
  | ConfigImportResponse
  | ConfigCategoriesResponse
  | ConfigValidateResponse
  | StateSyncMessage
  | SettingsErrorResponse
  | ConfigErrorResponse
  | EasterEggShowMessage
  // Operation lifecycle
  | OperationStarted
  | OperationProgress
  | OperationCompleted
  | OperationFailed
  | GrappeStarted
  | GrappePartitionProgress
  | GrappeBackPressure
  | GrappeCompleted
  | ExecutionProgressMessage
  | ExecutionRetryStatusMessage
  | ExecutionAbortResponse
  | ExecutionStatusResponse
  | ExecutionListResponse
  | ExecutionErrorResponse
  // Scheduler
  | SchedulerListResponse
  | SchedulerUpsertResponse
  | SchedulerDeleteResponse
  | SchedulerToggleResponse
  // Realtime (CDC)
  | RealTimeStartedResponse
  | RealTimeStoppedResponse
  | RealTimeCDCEventMessage
  | RealTimeEventsBatchMessage
  | RealTimeStatusResponse
  | RealTimeMetricsResponse
  | RealTimeConflictDetected
  | RealTimeConflictResolvedResponse
  // Cache
  | CacheInvalidateAllResponse
  | CacheStatsResponse
  // Smart Action
  | SmartActionAnalyzeResponse
  | SmartActionErrorResponse
  // QuickSync
  | QuickSyncSuggestObjectsResponse
  | QuickSyncDetectRelationshipsResponse
  | QuickSyncPreviewResponse
  | QuickSyncExecuteResponse
  | QuickSyncErrorResponse
  // Frozen Reference Dataset
  | FrozenConfigGetResponse
  | FrozenConfigSaveResponse
  | FrozenSelectResponse
  | FrozenExtractResponse
  | FrozenControlResultMessage
  | FrozenManifestGetResponse
  | FrozenLoadResponse
  | FrozenLoadProgressMessage
  | FrozenVerifyResultMessage
  | FrozenStatusResponse
  | FrozenConfigSaveErrorMessage
  | FrozenSelectErrorMessage
  | FrozenExtractErrorMessage
  | FrozenLoadErrorMessage
  | FrozenVerifyErrorMessage;
