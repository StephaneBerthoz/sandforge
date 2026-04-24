# Plan 01-02 — Knip Post-Cleanup Baseline

**Captured:** 2026-04-24
**Phase:** 01 — Hardening Foundations
**Task:** 01-02-07 — baseline for future milestones to trend against.

## Context

After the Knip cleanup pass (Tasks 01-02-04, 01-02-05, 01-02-06), the repository
still carries a long-tail of flagged items. Most are accepted legacy surface area
that we intentionally preserve:

- **Dev dependencies flagged but KEPT** (13):
  `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`,
  `eslint-config-prettier` — loaded by ESLint config at runtime, not imported in TS.
  `@vscode/vsce` — consumed by `vsce package`. `@axe-core/playwright` — consumed by
  e2e specs. `@vitest/coverage-v8` — consumed by `pnpm test:coverage` script.
  `ts-morph` — reserved for Plan 01-04 (bridge-hardening codemods).

- **Runtime dep flagged but KEPT** (1):
  `zod` in `packages/webview/package.json` — kept as a hedge for Plan 01-04
  validation work; zero runtime cost since it's already a transitive of
  `@sandforge/shared`.

- **Unused exported types (467)**: a mix of component prop interfaces
  (`*Props`), typed event handlers, result payloads, and Zustand slice types.
  These are exported for documentation clarity and are not costing bundle size.
  A future targeted sweep (perhaps per-module) can reduce these incrementally;
  not a v1.3.0 priority.

- **Duplicate export (1)**: `orgTypeToGuardTier|orgTypeToSafetyTier` in
  `packages/shared/src/utils/sf-utils.ts` — same symbol exported under two
  names for backwards-compat; intentional.

## Trend baseline

| Metric                      | Before 01-02 | After 01-02 | Target v1.4 |
| :-------------------------- | -----------: | ----------: | ----------: |
| Unused exports              |           12 |           0 |           0 |
| Unused files                |            2 |           0 |           0 |
| Unused runtime dependencies |           15 |           1 |           0 |
| Unused devDependencies      |           13 |          13 |         0–5 |
| Unused exported types       |          337 |         467 |         <200 |
| Duplicate exports           |            1 |           1 |           0 |

The "unused exported types" count grew because some previously-unused
exports became visible after removing their external barrel wrappers.
Follow-up task recommended: sweep `*Props` interfaces whose component
is only referenced by a single call site.

## Gate for future milestones

`pnpm knip` remains non-blocking in CI (`.github/workflows/knip.yml`)
but publishes a report artifact on every run. When a milestone aims to
reduce findings, compare against this baseline.

---

## Full Knip output (post-cleanup)

```markdown
# Knip report

## Unused dependencies (1)

| Name | Location                           | Severity |
| :-- | :--------------------------------- | :------- |
| zod | packages/webview/package.json:40:6 | error    |

## Unused devDependencies (13)

| Name                             | Location                              | Severity |
| :------------------------------- | :------------------------------------ | :------- |
| @typescript-eslint/eslint-plugin | packages/extension/package.json:313:6 | error    |
| @typescript-eslint/parser        | packages/extension/package.json:314:6 | error    |
| eslint-config-prettier           | packages/extension/package.json:319:6 | error    |
| @vscode/vsce                     | packages/extension/package.json:316:6 | error    |
| @typescript-eslint/eslint-plugin | packages/webview/package.json:53:6    | error    |
| @typescript-eslint/parser        | packages/webview/package.json:54:6    | error    |
| eslint-config-prettier           | packages/webview/package.json:59:6    | error    |
| @axe-core/playwright             | packages/webview/package.json:44:6    | error    |
| @typescript-eslint/eslint-plugin | packages/shared/package.json:22:6     | error    |
| @typescript-eslint/parser        | packages/shared/package.json:23:6     | error    |
| eslint-config-prettier           | packages/shared/package.json:26:6     | error    |
| @vitest/coverage-v8              | package.json:25:6                     | error    |
| ts-morph                         | package.json:28:6                     | error    |

## Unused exported types (467)

| Name                         | Location                                                                         | Severity |
| :--------------------------- | :------------------------------------------------------------------------------- | :------- |
| ObjectMaskingTemplate        | packages/extension/src/modules/dataops/templates/MaskingTemplateService.ts:22:18 | error    |
| FieldMaskingRule             | packages/extension/src/modules/dataops/templates/MaskingTemplateService.ts:10:18 | error    |
| Step3ComplianceProps         | packages/webview/src/pages/Autopilot/AutopilotWizard/Step3_Compliance.tsx:7:18   | error    |
| NotificationCenterProps      | packages/webview/src/layouts/NotificationCenter/NotificationCenter.tsx:16:18     | error    |
| Step1ConnectProps            | packages/webview/src/pages/Autopilot/AutopilotWizard/Step1_Connect.tsx:7:18      | error    |
| Step2ObjectsProps            | packages/webview/src/pages/Autopilot/AutopilotWizard/Step2_Objects.tsx:8:18      | error    |
| Step4ReviewProps             | packages/webview/src/pages/Autopilot/AutopilotWizard/Step4_Review.tsx:7:18       | error    |
| QuickSyncPreviewStepProps    | packages/webview/src/pages/Sync/QuickSync/QuickSyncPreviewStep.tsx:11:18         | error    |
| PlanGeneratorOptions         | packages/extension/src/modules/autopilot/ExecutionPlanGenerator.ts:16:18         | error    |
| PersonaCustomizePanelProps   | packages/webview/src/pages/Seed/Persona/PersonaCustomizePanel.tsx:10:18          | error    |
| OrchestratorEventListener    | packages/extension/src/modules/autopilot/AutopilotOrchestrator.ts:76:13          | error    |
| ObjectProgressPanelProps     | packages/webview/src/components/execution/ObjectProgressPanel.tsx:10:18          | error    |
| QuickSyncObjectStepProps     | packages/webview/src/pages/Sync/QuickSync/QuickSyncObjectStep.tsx:10:18          | error    |
| OperationEventListener       | packages/extension/src/core/engine/BackgroundOperationRegistry.ts:31:13          | error    |
| AutopilotPartition           | packages/extension/src/modules/autopilot/AutopilotGrappeAdapter.ts:9:18          | error    |
| AutopilotResult              | packages/extension/src/modules/autopilot/AutopilotOrchestrator.ts:62:18          | error    |
| PersonaPreviewPopoverProps   | packages/webview/src/pages/Seed/Persona/PersonaPreviewPopover.tsx:9:18           | error    |
| CsvValidationPanelProps      | packages/webview/src/pages/Seed/CsvUpload/CsvValidationPanel.tsx:10:18           | error    |
| RegisteredOperation          | packages/extension/src/core/engine/BackgroundOperationRegistry.ts:4:18           | error    |
| PipelineExecutionViewProps   | packages/webview/src/pages/Automation/PipelineExecutionView.tsx:22:18            | error    |
| ErrorRecoveryPanelProps      | packages/webview/src/components/execution/ErrorRecoveryPanel.tsx:8:18            | error    |
| StatusChangeHandler          | packages/extension/src/modules/sync/RealTimeSyncOrchestrator.ts:12:13            | error    |
| ConflictFeedHandler          | packages/extension/src/modules/sync/RealTimeSyncOrchestrator.ts:18:13            | error    |
| EventFeedHandler             | packages/extension/src/modules/sync/RealTimeSyncOrchestrator.ts:15:13            | error    |
| VersionMetadata              | packages/extension/src/modules/automation/PipelineVersioning.ts:21:18            | error    |
| LimitPrediction              | packages/extension/src/modules/monitor/GovernorLimitPredictor.ts:5:18            | error    |
| PipelineDiff                 | packages/extension/src/modules/automation/PipelineVersioning.ts:14:18            | error    |
| OperationChangeHandler       | packages/extension/src/modules/monitor/LiveOperationTracker.ts:38:13             | error    |
| MarketplaceTemplate          | packages/webview/src/pages/Automation/useAutomationPageData.ts:12:18             | error    |
| AutomationPageData           | packages/webview/src/pages/Automation/useAutomationPageData.ts:21:18             | error    |
| PipelineVersion              | packages/extension/src/modules/automation/PipelineVersioning.ts:2:18             | error    |
| LiveOperation                | packages/extension/src/modules/monitor/LiveOperationTracker.ts:10:18             | error    |
| PipelineHistoryViewProps     | packages/webview/src/pages/Automation/PipelineHistoryView.tsx:10:18              | error    |
| CloneObjectSelectorProps     | packages/webview/src/pages/Seed/Clone/CloneObjectSelector.tsx:10:18              | error    |
| AutopilotExecutorEvents      | packages/extension/src/modules/autopilot/AutopilotExecutor.ts:42:13              | error    |
| QuickSyncOrgStepProps        | packages/webview/src/pages/Sync/QuickSync/QuickSyncOrgStep.tsx:9:18              | error    |
| CsvUploadWizardProps         | packages/webview/src/pages/Seed/CsvUpload/CsvUploadWizard.tsx:17:18              | error    |
| QuickSyncFlowActions         | packages/webview/src/pages/Sync/QuickSync/useQuickSyncFlow.ts:40:18              | error    |
| QuickSyncFlowState           | packages/webview/src/pages/Sync/QuickSync/useQuickSyncFlow.ts:10:18              | error    |
| ConsistencyIssue             | packages/extension/src/modules/seed/CrossObjectConsistency.ts:10:18              | error    |
| DetectedFormat               | packages/extension/src/modules/migration/UniversalImporter.ts:37:13              | error    |
| DetectedColumn               | packages/extension/src/modules/migration/UniversalImporter.ts:40:18              | error    |
| RemapResult                  | packages/extension/src/modules/autopilot/RecordIdRemapper.ts:120:18              | error    |
| Step4ConfigureRelationsProps | packages/webview/src/pages/Seed/Step4_ConfigureRelations.tsx:19:18               | error    |
| TriggerConfigPanelProps      | packages/webview/src/pages/Automation/TriggerConfigPanel.tsx:12:18               | error    |
| CsvColumnMapperProps         | packages/webview/src/pages/Seed/CsvUpload/CsvColumnMapper.tsx:9:18               | error    |
| AutopilotObjectInfo          | packages/webview/src/pages/Autopilot/AutopilotWizard/index.ts:2:15               | error    |
| ConsistencyResult            | packages/extension/src/modules/seed/CrossObjectConsistency.ts:4:18               | error    |
| ScheduledEntry               | packages/extension/src/modules/automation/SchedulerService.ts:5:18               | error    |
| GearsetSummary               | packages/extension/src/modules/migration/GearsetImporter.ts:147:18               | error    |
| QuickSyncStep                | packages/webview/src/pages/Sync/QuickSync/useQuickSyncFlow.ts:7:13               | error    |
| ConflictResolutionPanelProps | packages/webview/src/pages/Sync/ConflictResolutionPanel.tsx:19:18                | error    |
| MaskingTemplatePanelProps    | packages/webview/src/pages/DataOps/MaskingTemplatePanel.tsx:24:18                | error    |
| SchedulerCalendarProps       | packages/webview/src/pages/Automation/SchedulerCalendar.tsx:17:18                | error    |
| ClonePreviewPanelProps       | packages/webview/src/pages/Seed/Clone/ClonePreviewPanel.tsx:16:18                | error    |
| CloneResultsPanelProps       | packages/webview/src/pages/Seed/Clone/CloneResultsPanel.tsx:23:18                | error    |
| CloneSourcePickerProps       | packages/webview/src/pages/Seed/Clone/CloneSourcePicker.tsx:11:18                | error    |
| GearsetComponentDiff         | packages/extension/src/modules/migration/GearsetImporter.ts:42:13                | error    |
| PermissionMatrixRow          | packages/extension/src/modules/compare/PermissionCompare.ts:20:18                | error    |
| QuickSyncFlowProps           | packages/webview/src/pages/Sync/QuickSync/QuickSyncFlow.tsx:10:18                | error    |
| AddressTuple                 | packages/extension/src/modules/seed/GeoCoherentGenerator.ts:11:18                | error    |
| TrackedJob                   | packages/extension/src/core/engine/BulkJobProgressTracker.ts:5:18                | error    |
| LiveOperationsPanelProps     | packages/webview/src/pages/Monitor/LiveOperationsPanel.tsx:11:18                 | error    |
| SettingsExportPanelProps     | packages/webview/src/pages/Settings/SettingsExportPanel.tsx:7:18                 | error    |
| GovernanceRuleCondition      | packages/extension/src/modules/monitor/GovernanceEngine.ts:19:13                 | error    |
| ResolvedBatchStrategy        | packages/extension/src/modules/forge/ForgeBatchStrategy.ts:15:18                 | error    |
| ComplianceCheckResult        | packages/extension/src/modules/dataops/ComplianceChecker.ts:9:18                 | error    |
| OrgConnectDialogProps        | packages/webview/src/pages/OrgManager/OrgConnectDialog.tsx:20:18                 | error    |
| PersonaGalleryProps          | packages/webview/src/pages/Seed/Persona/PersonaGallery.tsx:15:18                 | error    |
| MassDeleteProgress           | packages/extension/src/modules/dataops/MassDeleteManager.ts:8:18                 | error    |
| MojitoOverlayProps           | packages/webview/src/components/EasterEgg/MojitoOverlay.tsx:4:18                 | error    |
| QuickSyncCardProps           | packages/webview/src/pages/Sync/QuickSync/QuickSyncCard.tsx:7:18                 | error    |
| AnalyticsSummary             | packages/extension/src/core/reporting/AnalyticsCollector.ts:7:18                 | error    |
| OrgSwitcherProps             | packages/webview/src/components/OrgSwitcher/OrgSwitcher.tsx:8:18                 | error    |
| SettingsPageData             | packages/webview/src/pages/Settings/useSettingsPageData.ts:15:18                 | error    |
| ObjectSizeStats              | packages/extension/src/modules/dataops/StorageOptimizer.ts:11:18                 | error    |
| TrendAnalysis                | packages/extension/src/modules/monitor/OrgTrendAnalyzer.ts:11:18                 | error    |
| ImportResult                 | packages/extension/src/core/config/ConfigProfileManager.ts:33:18                 | error    |
| ExportResult                 | packages/extension/src/core/config/ConfigProfileManager.ts:47:18                 | error    |
| FieldPattern                 | packages/extension/src/modules/seed/DataPatternAnalyzer.ts:33:18                 | error    |
| TrendResult                  | packages/extension/src/modules/monitor/OrgTrendAnalyzer.ts:21:18                 | error    |
| DataPattern                  | packages/extension/src/modules/seed/DataPatternAnalyzer.ts:26:18                 | error    |
| TemplateCustomizeModalProps  | packages/webview/src/pages/Seed/TemplateCustomizeModal.tsx:9:18                  | error    |
| Step3ConfigureFieldsProps    | packages/webview/src/pages/Seed/Step3_ConfigureFields.tsx:29:18                  | error    |
| GuidedFirstStepCardProps     | packages/webview/src/components/ui/GuidedFirstStepCard.tsx:9:18                  | error    |
| ExecutionReportViewProps     | packages/webview/src/pages/Reports/ExecutionReportView.tsx:9:18                  | error    |
| AnalyticsDashboardProps      | packages/webview/src/pages/Reports/AnalyticsDashboard.tsx:27:18                  | error    |
| ForgeTemplateStoreDeps       | packages/extension/src/modules/forge/ForgeTemplateStore.ts:4:18                  | error    |
| SfdmuValuesMappingItem       | packages/extension/src/modules/migration/SfdmuImporter.ts:67:13                  | error    |
| CloneRecordFetcherDeps       | packages/extension/src/modules/seed/CloneRecordFetcher.ts:12:18                  | error    |
| RecordValidationResult       | packages/extension/src/modules/sync/FieldTypeValidator.ts:48:18                  | error    |
| ForgeHistoryStoreDeps        | packages/extension/src/modules/forge/ForgeHistoryStore.ts:11:18                  | error    |
| SfdmuFieldMappingItem        | packages/extension/src/modules/migration/SfdmuImporter.ts:64:13                  | error    |
| FieldValidationResult        | packages/extension/src/modules/sync/FieldTypeValidator.ts:38:18                  | error    |
| RecordValidationError        | packages/extension/src/modules/sync/FieldTypeValidator.ts:56:18                  | error    |
| RetentionCheckResult         | packages/extension/src/modules/dataops/BackupScheduler.ts:14:18                  | error    |
| FieldCompatibility           | packages/extension/src/modules/sync/FieldTypeValidator.ts:22:18                  | error    |
| CsvExecutionStatus           | packages/webview/src/pages/Seed/CsvUpload/useCsvImport.ts:15:13                  | error    |
| CsvExecutionResult           | packages/webview/src/pages/Seed/CsvUpload/useCsvImport.ts:18:18                  | error    |
| MetadataDiffEntry            | packages/extension/src/modules/forge/ForgeMetadataDiff.ts:26:18                  | error    |
| ChunkedBulkConfig            | packages/extension/src/core/engine/ChunkedBulkExecutor.ts:17:18                  | error    |
| CompositeStrategy            | packages/extension/src/core/engine/CompositeApiManager.ts:34:13                  | error    |
| SfdmuScriptObject            | packages/extension/src/modules/migration/SfdmuImporter.ts:61:13                  | error    |
| StatusFooterProps            | packages/webview/src/layouts/StatusFooter/StatusFooter.tsx:8:18                  | error    |
| TelemetrySummary             | packages/extension/src/core/telemetry/TelemetryService.ts:27:18                  | error    |
| ApprovalRequest              | packages/extension/src/modules/automation/ApprovalGate.ts:13:18                  | error    |
| TelemetryModule              | packages/extension/src/core/telemetry/TelemetryService.ts:22:13                  | error    |
| GuidedTourProps              | packages/webview/src/components/GuidedTour/GuidedTour.tsx:36:18                  | error    |
| CompositeGraph               | packages/extension/src/core/engine/CompositeApiManager.ts:20:18                  | error    |
| DependencyEdge               | packages/extension/src/modules/migration/SfdmuImporter.ts:72:18                  | error    |
| TourDefinition               | packages/webview/src/components/GuidedTour/GuidedTour.tsx:24:18                  | error    |
| CsvImportState               | packages/webview/src/pages/Seed/CsvUpload/useCsvImport.ts:25:18                  | error    |
| ProblemReport                | packages/extension/src/modules/compare/ProblemAnalyzer.ts:14:18                  | error    |
| ApexLogIssue                 | packages/extension/src/modules/monitor/ApexLogAnalyzer.ts:15:18                  | error    |
| StepHandler                  | packages/extension/src/modules/automation/StepExecutor.ts:17:13                  | error    |
| ObjectStats                  | packages/extension/src/modules/dataops/StorageOptimizer.ts:4:18                  | error    |
| GrappeOrchestratorEventType  | packages/extension/src/core/grappe/GrappeOrchestrator.ts:17:13                   | error    |
| CDCSubscriptionPanelProps    | packages/webview/src/pages/Sync/CDCSubscriptionPanel.tsx:31:18                   | error    |
| SeedObjectSelectionState     | packages/webview/src/pages/Seed/useSeedObjectSelection.ts:6:18                   | error    |
| ResolvedDependencyGraph      | packages/extension/src/core/engine/DependencyResolver.ts:22:18                   | error    |
| DiffGroupAccordionProps      | packages/webview/src/pages/Compare/DiffGroupAccordion.tsx:8:18                   | error    |
| KeyboardShortcutsProps       | packages/webview/src/components/ui/KeyboardShortcuts.tsx:70:18                   | error    |
| AlertHistoryPanelProps       | packages/webview/src/pages/Monitor/AlertHistoryPanel.tsx:19:18                   | error    |
| LimitExportButtonProps       | packages/webview/src/pages/Monitor/LimitExportButton.tsx:12:18                   | error    |
| DrainProgressCallback        | packages/extension/src/core/connection/OfflineManager.ts:39:13                   | error    |
| ReportGeneratorEvents        | packages/extension/src/core/reporting/ReportGenerator.ts:12:18                   | error    |
| ConfigConflictDisplay        | packages/webview/src/pages/Settings/TeamSharingPanel.tsx:10:18                   | error    |
| TeamSharingPanelProps        | packages/webview/src/pages/Settings/TeamSharingPanel.tsx:17:18                   | error    |
| PostValidationResult         | packages/extension/src/modules/seed/PostSeedValidator.ts:17:18                   | error    |
| StepConfigPanelProps         | packages/webview/src/pages/Automation/StepConfigPanel.tsx:8:18                   | error    |
| HealthEventListener          | packages/extension/src/core/connection/OrgHealthProbe.ts:26:13                   | error    |
| PerformanceHistory           | packages/extension/src/core/engine/PerformanceTracker.ts:15:18                   | error    |
| DisconnectHandler            | packages/extension/src/core/connection/TokenRefresher.ts:35:13                   | error    |
| OfflineEventType             | packages/extension/src/core/connection/OfflineManager.ts:17:13                   | error    |
| TrackedOperation             | packages/extension/src/core/common/DmlOperationTracker.ts:5:18                   | error    |
| ScheduledBackup              | packages/extension/src/modules/dataops/BackupScheduler.ts:4:18                   | error    |
| ApexLogAnalysis              | packages/extension/src/modules/monitor/ApexLogAnalyzer.ts:4:18                   | error    |
| HintBubbleProps              | packages/webview/src/components/HintBubble/HintBubble.tsx:8:18                   | error    |
| MonitorPageData              | packages/webview/src/pages/Monitor/useMonitorPageData.ts:56:18                   | error    |
| LatencyMetrics               | packages/extension/src/core/connection/ConnectionPool.ts:14:18                   | error    |
| TokenEventType               | packages/extension/src/core/connection/TokenRefresher.ts:22:13                   | error    |
| ApprovalStatus               | packages/extension/src/modules/automation/ApprovalGate.ts:2:13                   | error    |
| ApprovalConfig               | packages/extension/src/modules/automation/ApprovalGate.ts:5:18                   | error    |
| DependencyLink               | packages/extension/src/modules/compare/ImpactAnalyzer.ts:11:18                   | error    |
| ImpactAnalysis               | packages/extension/src/modules/compare/ImpactAnalyzer.ts:18:18                   | error    |
| PredictionItem               | packages/webview/src/pages/Monitor/useMonitorPageData.ts:49:18                   | error    |
| CloneLogFn                   | packages/extension/src/modules/seed/CloneRecordFetcher.ts:9:13                   | error    |
| Problem                      | packages/extension/src/modules/compare/ProblemAnalyzer.ts:4:18                   | error    |
| RetryableOperationOptions    | packages/extension/src/core/engine/RetryableOperation.ts:6:18                    | error    |
| CheckpointStateProvider      | packages/extension/src/core/engine/CheckpointManager.ts:28:13                    | error    |
| StreamingPipelineConfig      | packages/extension/src/core/engine/StreamingPipeline.ts:22:18                    | error    |
| MetadataDiffBannerProps      | packages/webview/src/pages/Forge/MetadataDiffBanner.tsx:20:18                    | error    |
| Step2SelectObjectsProps      | packages/webview/src/pages/Seed/Step2_SelectObjects.tsx:16:18                    | error    |
| CategorySelectorProps        | packages/webview/src/pages/Compare/CategorySelector.tsx:28:18                    | error    |
| PermissionMatrixProps        | packages/webview/src/pages/Compare/PermissionMatrix.tsx:23:18                    | error    |
| QualityDashboardProps        | packages/webview/src/pages/DataOps/QualityDashboard.tsx:11:18                    | error    |
| AuditTrailViewerProps        | packages/webview/src/pages/Reports/AuditTrailViewer.tsx:10:18                    | error    |
| AuditTrailPanelProps         | packages/webview/src/pages/Settings/AuditTrailPanel.tsx:26:18                    | error    |
| CheckpointEventType          | packages/extension/src/core/engine/CheckpointManager.ts:31:13                    | error    |
| PipelineCanvasProps          | packages/webview/src/pages/Automation/PipelineCanvas.tsx:8:18                    | error    |
| ConnectivityStatus           | packages/extension/src/core/connection/OfflineManager.ts:4:13                    | error    |
| PerformanceMetrics           | packages/extension/src/core/engine/PerformanceTracker.ts:2:18                    | error    |
| OrgEditDialogProps           | packages/webview/src/pages/OrgManager/OrgEditDialog.tsx:18:18                    | error    |
| SafetyCheckResult            | packages/extension/src/core/precheck/ProductionGuard.ts:15:18                    | error    |
| AffectedComponent            | packages/extension/src/modules/compare/ImpactAnalyzer.ts:4:18                    | error    |
| AuditFilterValues            | packages/webview/src/pages/Settings/AuditTrailPanel.tsx:40:18                    | error    |
| TeamConfigBundle             | packages/extension/src/core/config/TeamConfigService.ts:17:13                    | error    |
| TeamImportResult             | packages/extension/src/core/config/TeamConfigService.ts:37:18                    | error    |
| PooledConnection             | packages/extension/src/core/connection/ConnectionPool.ts:4:18                    | error    |
| TokenRefreshInfo             | packages/extension/src/core/connection/TokenRefresher.ts:5:18                    | error    |
| PipelineListener             | packages/extension/src/core/engine/ExecutionPipeline.ts:39:13                    | error    |
| EncryptionConfig             | packages/extension/src/core/storage/EncryptionManager.ts:4:18                    | error    |
| PersonaCardProps             | packages/webview/src/pages/Seed/Persona/PersonaCard.tsx:57:18                    | error    |
| SforceLimitInfo              | packages/extension/src/core/common/sforceLimitParser.ts:14:18                    | error    |
| TeamShareResult              | packages/extension/src/core/config/TeamConfigService.ts:53:18                    | error    |
| RestoreProgress              | packages/extension/src/modules/dataops/RollbackEngine.ts:8:18                    | error    |
| CsvPreviewProps              | packages/webview/src/pages/Seed/CsvUpload/CsvPreview.tsx:8:18                    | error    |
| ConfigConflict               | packages/extension/src/core/config/TeamConfigService.ts:25:18                    | error    |
| MergeStrategy                | packages/extension/src/core/config/TeamConfigService.ts:20:13                    | error    |
| RefreshStatus                | packages/extension/src/core/connection/TokenRefresher.ts:2:13                    | error    |
| StepCategory                 | packages/extension/src/modules/automation/StepLibrary.ts:4:13                    | error    |
| StepTypeInfo                 | packages/extension/src/modules/automation/StepLibrary.ts:7:18                    | error    |
| DriftResult                  | packages/extension/src/modules/compare/DriftDetector.ts:12:18                    | error    |
| AuditEntry                   | packages/extension/src/core/precheck/ProductionGuard.ts:25:18                    | error    |
| DateRange                    | packages/extension/src/modules/seed/ContextualRanges.ts:18:18                    | error    |
| ConflictDiffViewerProps      | packages/webview/src/pages/Sync/ConflictDiffViewer.tsx:10:18                     | error    |
| FieldMappingCanvasProps      | packages/webview/src/pages/Sync/FieldMappingCanvas.tsx:25:18                     | error    |
| SyncTemplatePickerProps      | packages/webview/src/pages/Sync/SyncTemplatePicker.tsx:11:18                     | error    |
| SchemaValidationResult       | packages/extension/src/modules/sync/SchemaValidator.ts:18:18                     | error    |
| SnapshotTimelineProps        | packages/webview/src/pages/Compare/SnapshotTimeline.tsx:9:18                     | error    |
| HealthScoreGaugeProps        | packages/webview/src/pages/Monitor/HealthScoreGauge.tsx:5:18                     | error    |
| JobInsightsPanelProps        | packages/webview/src/pages/Monitor/JobInsightsPanel.tsx:9:18                     | error    |
| VirtualComboboxProps         | packages/webview/src/components/ui/VirtualCombobox.tsx:18:18                     | error    |
| GovernancePanelProps         | packages/webview/src/pages/Monitor/GovernancePanel.tsx:35:18                     | error    |
| PredictionsTileProps         | packages/webview/src/pages/Monitor/PredictionsTile.tsx:16:18                     | error    |
| AutoMapSuggestionUI          | packages/webview/src/pages/Sync/FieldMappingCanvas.tsx:17:18                     | error    |
| SidebarUriJoinPath           | packages/extension/src/providers/SidebarViewProvider.ts:4:13                     | error    |
| AuditOperationType           | packages/extension/src/core/audit/AuditTrailService.ts:14:13                     | error    |
| AuditExportOptions           | packages/extension/src/core/audit/AuditTrailService.ts:72:18                     | error    |
| AutoMapSuggestion            | packages/extension/src/modules/sync/AutoFieldMapper.ts:11:18                     | error    |
| DriftedComponent             | packages/extension/src/modules/compare/DriftDetector.ts:4:18                     | error    |
| ResolvedRecord               | packages/extension/src/modules/sync/ConflictResolver.ts:4:18                     | error    |
| FieldAnalysis                | packages/extension/src/core/metadata/SchemaAnalyzer.ts:19:18                     | error    |
| OrgIdentity                  | packages/extension/src/core/connection/AuthProvider.ts:33:18                     | error    |
| AuditStatus                  | packages/extension/src/core/audit/AuditTrailService.ts:26:13                     | error    |
| AuditFilter                  | packages/extension/src/core/audit/AuditTrailService.ts:54:18                     | error    |
| AmountRange                  | packages/extension/src/modules/seed/ContextualRanges.ts:8:18                     | error    |
| SchemaError                  | packages/extension/src/modules/sync/SchemaValidator.ts:11:18                     | error    |
| AuditEntry                   | packages/extension/src/core/audit/AuditTrailService.ts:49:13                     | error    |
| ObjectSet                    | packages/extension/src/modules/sync/ObjectSetManager.ts:2:18                     | error    |
| SeedOrgSelectionState        | packages/webview/src/pages/Seed/useSeedOrgSelection.ts:6:18                      | error    |
| DiffDetailModalProps         | packages/webview/src/pages/Compare/DiffDetailModal.tsx:9:18                      | error    |
| HealthScoreCardProps         | packages/webview/src/pages/Monitor/HealthScoreCard.tsx:9:18                      | error    |
| TemplateGalleryState         | packages/webview/src/pages/Seed/useTemplateGallery.ts:43:18                      | error    |
| SeedFieldConfigState         | packages/webview/src/pages/Seed/useSeedFieldConfig.ts:13:18                      | error    |
| DeployFromDiffProps          | packages/webview/src/pages/Compare/DeployFromDiff.tsx:11:18                      | error    |
| DriftDashboardProps          | packages/webview/src/pages/Compare/DriftDashboard.tsx:28:18                      | error    |
| AnonymizePanelProps          | packages/webview/src/pages/DataOps/AnonymizePanel.tsx:11:18                      | error    |
| DataSubjectRequest           | packages/extension/src/modules/dataops/GDPRManager.ts:15:18                      | error    |
| ErasurePlanObject            | packages/extension/src/modules/dataops/GDPRManager.ts:52:18                      | error    |
| UsePersonasReturn            | packages/webview/src/pages/Seed/Persona/usePersonas.ts:7:18                      | error    |
| LoadedPluginInfo             | packages/extension/src/core/plugins/PluginManager.ts:130:18                      | error    |
| AdjustmentResult             | packages/extension/src/modules/seed/VRAutoAdjuster.ts:23:18                      | error    |
| FieldMapperProps             | packages/webview/src/components/graph/FieldMapper.tsx:16:18                      | error    |
| StepPaletteEntry             | packages/webview/src/pages/Automation/StepPalette.tsx:10:18                      | error    |
| StepPaletteProps             | packages/webview/src/pages/Automation/StepPalette.tsx:16:18                      | error    |
| CloneWizardProps             | packages/webview/src/pages/Seed/Clone/CloneWizard.tsx:36:18                      | error    |
| SeedWizardState              | packages/webview/src/pages/Seed/useSeedWizardState.ts:34:18                      | error    |
| RollbackResult               | packages/extension/src/core/engine/RollbackManager.ts:16:18                      | error    |
| ObjectAnalysis               | packages/extension/src/core/metadata/SchemaAnalyzer.ts:4:18                      | error    |
| PIIFieldResult               | packages/extension/src/modules/dataops/GDPRManager.ts:33:18                      | error    |
| ArchiveEntry                 | packages/extension/src/modules/dataops/DataArchiver.ts:5:18                      | error    |
| ScriptResult                 | packages/extension/src/modules/sync/MigrationScript.ts:2:18                      | error    |
| ErasurePlan                  | packages/extension/src/modules/dataops/GDPRManager.ts:42:18                      | error    |
| DSRStatus                    | packages/extension/src/modules/dataops/GDPRManager.ts:12:13                      | error    |
| RealTimeSyncPanelProps       | packages/webview/src/pages/Sync/RealTimeSyncPanel.tsx:9:18                       | error    |
| SyncPreviewPanelProps        | packages/webview/src/pages/Sync/SyncPreviewPanel.tsx:36:18                       | error    |
| TransformBuilderProps        | packages/webview/src/pages/Sync/TransformBuilder.tsx:11:18                       | error    |
| ForgeNodeDetailProps         | packages/webview/src/pages/Forge/ForgeNodeDetail.tsx:10:18                       | error    |
| Step5SetVolumesProps         | packages/webview/src/pages/Seed/Step5_SetVolumes.tsx:14:18                       | error    |
| BatchRecommendation          | packages/extension/src/core/engine/BatchOptimizer.ts:21:18                       | error    |
| BulkExecutionResult          | packages/extension/src/core/engine/BulkApiExecutor.ts:9:18                       | error    |
| SeedFieldRulesState          | packages/webview/src/pages/Seed/useSeedFieldRules.ts:40:18                       | error    |
| OrgManagerListener           | packages/extension/src/core/connection/OrgManager.ts:13:13                       | error    |
| DangerConfirmProps           | packages/webview/src/components/ui/DangerConfirm.tsx:19:18                       | error    |
| SandboxBannerProps           | packages/webview/src/components/ui/SandboxBanner.tsx:11:18                       | error    |
| AuditLoggerEvents            | packages/extension/src/core/reporting/AuditLogger.ts:15:18                       | error    |
| SettingsPageProps            | packages/webview/src/pages/Settings/SettingsPage.tsx:44:18                       | error    |
| SuggestionImpact             | packages/extension/src/modules/ai/SmartSuggestions.ts:5:13                       | error    |
| BackupObjectInfo             | packages/extension/src/core/storage/BackupStorage.ts:19:18                       | error    |
| FieldStatistics              | packages/extension/src/modules/ai/AnomalyDetector.ts:33:18                       | error    |
| ExtensionPoints              | packages/extension/src/core/plugins/PluginManager.ts:65:18                       | error    |
| ValidationError              | packages/extension/src/modules/seed/SeedValidator.ts:11:18                       | error    |
| BulkJobOptions               | packages/extension/src/core/engine/BulkApiManager.ts:24:18                       | error    |
| RollbackStatus               | packages/extension/src/core/engine/RollbackManager.ts:3:13                       | error    |
| PreCheckResult               | packages/extension/src/core/plugins/PluginManager.ts:36:18                       | error    |
| ConfirmVariant               | packages/webview/src/components/ui/DangerConfirm.tsx:16:13                       | error    |
| AnomalyReport                | packages/extension/src/modules/ai/AnomalyDetector.ts:18:18                       | error    |
| AdjustmentLog                | packages/extension/src/modules/seed/VRAutoAdjuster.ts:9:18                       | error    |
| SfdxOrgEntry                 | packages/extension/src/core/connection/SfdxBridge.ts:49:18                       | error    |
| StepCategory                 | packages/webview/src/pages/Automation/StepPalette.tsx:7:13                       | error    |
| Suggestion                   | packages/extension/src/modules/ai/SmartSuggestions.ts:8:18                       | error    |
| Savepoint                    | packages/extension/src/core/engine/RollbackManager.ts:6:18                       | error    |
| JobStats                     | packages/extension/src/modules/monitor/JobMonitor.ts:16:18                       | error    |
| SyncScheduleExecutorDeps     | packages/extension/src/modules/sync/SyncScheduler.ts:7:15                        | error    |
| GrappeMonitorEventType       | packages/extension/src/core/grappe/GrappeMonitor.ts:11:13                        | error    |
| ObjectImpactAnalysis         | packages/extension/src/modules/sync/SyncAnalyzer.ts:10:18                        | error    |
| SmartActionCardProps         | packages/webview/src/pages/Home/SmartActionCard.tsx:13:18                        | error    |
| Step6ReviewPlanProps         | packages/webview/src/pages/Seed/Step6_ReviewPlan.tsx:8:18                        | error    |
| TemplateGalleryProps         | packages/webview/src/pages/Seed/TemplateGallery.tsx:12:18                        | error    |
| ObjectSetEditorProps         | packages/webview/src/pages/Sync/ObjectSetEditor.tsx:20:18                        | error    |
| ComputeTrendOptions          | packages/extension/src/modules/monitor/trendUtils.ts:9:18                        | error    |
| ForgeTableViewProps          | packages/webview/src/pages/Forge/ForgeTableView.tsx:26:18                        | error    |
| ForgeTemplatesProps          | packages/webview/src/pages/Forge/ForgeTemplates.tsx:13:18                        | error    |
| PIIDetectionResult           | packages/extension/src/core/precheck/PIIDetector.ts:20:18                        | error    |
| CrudFlsCheckResult           | packages/extension/src/core/metadata/CrudFlsGuard.ts:7:18                        | error    |
| SchemaCacheOptions           | packages/extension/src/core/metadata/SchemaCache.ts:14:18                        | error    |
| ExtensionPointName           | packages/extension/src/core/plugins/PluginManager.ts:6:13                        | error    |
| SyncImpactAnalysis           | packages/extension/src/modules/sync/SyncAnalyzer.ts:23:18                        | error    |
| ErrorBoundaryProps           | packages/webview/src/components/ui/ErrorBoundary.tsx:6:18                        | error    |
| SkeletonPanelProps           | packages/webview/src/components/ui/SkeletonPanel.tsx:6:18                        | error    |
| SkeletonTableProps           | packages/webview/src/components/ui/SkeletonTable.tsx:6:18                        | error    |
| RiskScoreCardProps           | packages/webview/src/pages/Compare/RiskScoreCard.tsx:9:18                        | error    |
| SeedExecutionState           | packages/webview/src/pages/Seed/useSeedExecution.ts:10:18                        | error    |
| NotificationState            | packages/webview/src/stores/useNotificationStore.ts:35:18                        | error    |
| SyncScheduleState            | packages/webview/src/stores/useSyncScheduleStore.ts:10:18                        | error    |
| CleanupPanelProps            | packages/webview/src/pages/DataOps/CleanupPanel.tsx:11:18                        | error    |
| RestorePanelProps            | packages/webview/src/pages/DataOps/RestorePanel.tsx:11:18                        | error    |
| LineageGraphProps            | packages/webview/src/pages/Reports/LineageGraph.tsx:11:18                        | error    |
| WhatsNewPageProps            | packages/webview/src/pages/Welcome/WhatsNewPage.tsx:82:18                        | error    |
| ValidationResult             | packages/extension/src/modules/seed/SeedValidator.ts:4:18                        | error    |
| AnomalySeverity              | packages/extension/src/modules/ai/AnomalyDetector.ts:5:13                        | error    |
| FakerMethodName              | packages/extension/src/modules/seed/FakerFallback.ts:7:13                        | error    |
| AuditLogFilter               | packages/extension/src/core/reporting/AuditLogger.ts:6:18                        | error    |
| LiveGraphProps               | packages/webview/src/components/graph/LiveGraph.tsx:15:18                        | error    |
| AnomalyType                  | packages/extension/src/modules/ai/AnomalyDetector.ts:2:13                        | error    |
| CycleInfo                    | packages/extension/src/core/metadata/ObjectGraph.ts:20:18                        | error    |
| PIIField                     | packages/extension/src/core/precheck/PIIDetector.ts:10:18                        | error    |
| Anomaly                      | packages/extension/src/modules/ai/AnomalyDetector.ts:8:18                        | error    |
| ResolutionHistoryEntry       | packages/extension/src/modules/ai/ErrorResolver.ts:41:18                         | error    |
| CDCConnectionHandler         | packages/extension/src/modules/sync/CDCListener.ts:26:13                         | error    |
| MigrationFileReader          | packages/extension/src/bridge/ExtensionHandlers.ts:47:15                         | error    |
| Step1SelectOrgProps          | packages/webview/src/pages/Seed/Step1_SelectOrg.tsx:7:18                         | error    |
| SeedRelationsState           | packages/webview/src/pages/Seed/useSeedRelations.ts:5:18                         | error    |
| FileDropZoneProps            | packages/webview/src/components/ui/FileDropZone.tsx:9:18                         | error    |
| SkeletonCardProps            | packages/webview/src/components/ui/SkeletonCard.tsx:6:18                         | error    |
| OrgInfoPanelProps            | packages/webview/src/pages/Monitor/OrgInfoPanel.tsx:8:18                         | error    |
| SchemaSuggestion             | packages/extension/src/modules/ai/SchemaAdvisor.ts:45:18                         | error    |
| SyncHistoryState             | packages/webview/src/stores/useSyncHistoryStore.ts:10:18                         | error    |
| ContextMenuProps             | packages/webview/src/components/ui/ContextMenu.tsx:14:18                         | error    |
| InfoTooltipProps             | packages/webview/src/components/ui/InfoTooltip.tsx:42:18                         | error    |
| ImpactGraphProps             | packages/webview/src/pages/Compare/ImpactGraph.tsx:33:18                         | error    |
| BackupPanelProps             | packages/webview/src/pages/DataOps/BackupPanel.tsx:11:18                         | error    |
| AlertsPanelProps             | packages/webview/src/pages/Monitor/AlertsPanel.tsx:18:18                         | error    |
| TrendChartsProps             | packages/webview/src/pages/Monitor/TrendCharts.tsx:27:18                         | error    |
| ReportsPageProps             | packages/webview/src/pages/Reports/ReportsPage.tsx:20:18                         | error    |
| WelcomePageProps             | packages/webview/src/pages/Welcome/WelcomePage.tsx:42:18                         | error    |
| CDCEventHandler              | packages/extension/src/modules/sync/CDCListener.ts:23:13                         | error    |
| CDCErrorHandler              | packages/extension/src/modules/sync/CDCListener.ts:29:13                         | error    |
| InfraServices                | packages/extension/src/bridge/ExtensionHandlers.ts:45:15                         | error    |
| SchemaAdvice                 | packages/extension/src/modules/ai/SchemaAdvisor.ts:53:18                         | error    |
| SyncPageData                 | packages/webview/src/pages/Sync/useSyncPageData.ts:32:18                         | error    |
| EffortLevel                  | packages/extension/src/modules/ai/SchemaAdvisor.ts:33:13                         | error    |
| QueueStatus                  | packages/extension/src/core/engine/QueueManager.ts:15:18                         | error    |
| PIIWarning                   | packages/webview/src/pages/Sync/useSyncPageData.ts:26:18                         | error    |
| AIModules                    | packages/extension/src/bridge/ExtensionHandlers.ts:46:15                         | error    |
| GraphNode                    | packages/extension/src/core/metadata/ObjectGraph.ts:2:18                         | error    |
| CloneExecutionStatus         | packages/webview/src/pages/Seed/Clone/useClone.ts:22:13                          | error    |
| QuickSeedFlowProps           | packages/webview/src/pages/Seed/QuickSeedFlow.tsx:14:18                          | error    |
| ForgeResultsProps            | packages/webview/src/pages/Forge/ForgeResults.tsx:23:18                          | error    |
| Step7ExecuteProps            | packages/webview/src/pages/Seed/Step7_Execute.tsx:20:18                          | error    |
| QueryLimitConfig             | packages/extension/src/core/common/queryLimits.ts:11:18                          | error    |
| SyncExportFormat             | packages/webview/src/stores/useSyncHistoryStore.ts:7:13                          | error    |
| ErrorBannerProps             | packages/webview/src/components/ui/ErrorBanner.tsx:6:18                          | error    |
| OrgDropdownProps             | packages/webview/src/components/ui/OrgDropdown.tsx:8:18                          | error    |
| ProgressBarProps             | packages/webview/src/components/ui/ProgressBar.tsx:5:18                          | error    |
| VirtualListProps             | packages/webview/src/components/ui/VirtualList.tsx:7:18                          | error    |
| OrgSelectorProps             | packages/webview/src/pages/Compare/OrgSelector.tsx:7:18                          | error    |
| SmartActionState             | packages/webview/src/pages/Home/useSmartAction.ts:13:18                          | error    |
| HealthGaugeProps             | packages/webview/src/pages/Monitor/HealthGauge.tsx:6:18                          | error    |
| LimitsPanelProps             | packages/webview/src/pages/Monitor/LimitsPanel.tsx:9:18                          | error    |
| SeedPIIScanState             | packages/webview/src/pages/Seed/useSeedPIIScan.ts:17:18                          | error    |
| CDCMetricsState              | packages/webview/src/stores/useCDCMetricsStore.ts:13:18                          | error    |
| BreadcrumbProps              | packages/webview/src/components/ui/Breadcrumb.tsx:11:18                          | error    |
| DiffViewerProps              | packages/webview/src/pages/Compare/DiffViewer.tsx:10:18                          | error    |
| TrendChartProps              | packages/webview/src/pages/Monitor/TrendChart.tsx:23:18                          | error    |
| UseCloneReturn               | packages/webview/src/pages/Seed/Clone/useClone.ts:30:18                          | error    |
| OrgCardProps                 | packages/webview/src/pages/OrgManager/OrgCard.tsx:11:18                          | error    |
| CacheStats                   | packages/extension/src/core/cache/CacheManager.ts:12:18                          | error    |
| FixFailure                   | packages/extension/src/core/precheck/AutoFixer.ts:15:18                          | error    |
| MessageResponseHandler       | packages/webview/src/hooks/useMessageResponse.ts:25:18                           | error    |
| SandboxDetectionResult       | packages/webview/src/hooks/useSandboxDetection.ts:6:18                           | error    |
| LoadingScreenProps           | packages/webview/src/components/LoadingScreen.tsx:7:18                           | error    |
| Step8ResultsProps            | packages/webview/src/pages/Seed/Step8_Results.tsx:9:18                           | error    |
| EmptyStateModule             | packages/webview/src/components/ui/EmptyState.tsx:5:13                           | error    |
| SeedNL2SOQLState             | packages/webview/src/pages/Seed/useSeedNL2SOQL.ts:5:18                           | error    |
| SeedVolumesState             | packages/webview/src/pages/Seed/useSeedVolumes.ts:4:18                           | error    |
| TokenUsageStats              | packages/extension/src/modules/ai/AIAssistant.ts:46:18                           | error    |
| ExecutionStatus              | packages/webview/src/stores/useAutopilotStore.ts:15:13                           | error    |
| CopyButtonProps              | packages/webview/src/components/ui/CopyButton.tsx:8:18                           | error    |
| EmptyStateProps              | packages/webview/src/components/ui/EmptyState.tsx:8:18                           | error    |
| JsonViewerProps              | packages/webview/src/components/ui/JsonViewer.tsx:5:18                           | error    |
| PageHeaderProps              | packages/webview/src/components/ui/PageHeader.tsx:6:18                           | error    |
| PaginationProps              | packages/webview/src/components/ui/Pagination.tsx:7:18                           | error    |
| AutopilotState               | packages/webview/src/stores/useAutopilotStore.ts:56:18                           | error    |
| AccordionProps               | packages/webview/src/components/ui/Accordion.tsx:12:18                           | error    |
| BentoTileProps               | packages/webview/src/components/ui/BentoGrid.tsx:19:18                           | error    |
| CopyButtonSize               | packages/webview/src/components/ui/CopyButton.tsx:5:13                           | error    |
| DataTableProps               | packages/webview/src/components/ui/DataTable.tsx:26:18                           | error    |
| LogStreamProps               | packages/webview/src/components/ui/LogStream.tsx:18:18                           | error    |
| GDPRPanelProps               | packages/webview/src/pages/DataOps/GDPRPanel.tsx:47:18                           | error    |
| JobsPanelProps               | packages/webview/src/pages/Monitor/JobsPanel.tsx:22:18                           | error    |
| JobsTableProps               | packages/webview/src/pages/Monitor/JobsTable.tsx:15:18                           | error    |
| AutoFixResult                | packages/extension/src/core/precheck/AutoFixer.ts:9:18                           | error    |
| AutopilotStep                | packages/webview/src/stores/useAutopilotStore.ts:12:13                           | error    |
| SidebarProps                 | packages/webview/src/layouts/Sidebar/Sidebar.tsx:59:18                           | error    |
| LiveStats                    | packages/webview/src/stores/useAutopilotStore.ts:18:18                           | error    |
| JobFilter                    | packages/webview/src/pages/Monitor/JobsTable.tsx:12:13                           | error    |
| OrgTier                      | packages/extension/src/core/common/queryLimits.ts:8:13                           | error    |
| ConflictStoreActions         | packages/webview/src/stores/useConflictStore.ts:22:18                            | error    |
| BridgeMutationState          | packages/webview/src/hooks/useBridgeMutation.ts:11:18                            | error    |
| ConflictStoreState           | packages/webview/src/stores/useConflictStore.ts:10:18                            | error    |
| TemplateCardProps            | packages/webview/src/pages/Seed/TemplateCard.tsx:9:18                            | error    |
| StatusDotStatus              | packages/webview/src/components/ui/StatusDot.tsx:5:13                            | error    |
| FavoritesState               | packages/webview/src/stores/useFavoritesStore.ts:4:18                            | error    |
| BentoGridProps               | packages/webview/src/components/ui/BentoGrid.tsx:7:18                            | error    |
| SparklineProps               | packages/webview/src/components/ui/Sparkline.tsx:5:18                            | error    |
| SplitViewProps               | packages/webview/src/components/ui/SplitView.tsx:8:18                            | error    |
| StatusDotProps               | packages/webview/src/components/ui/StatusDot.tsx:8:18                            | error    |
| SettingsState                | packages/webview/src/stores/useSettingsStore.ts:40:18                            | error    |
| PageTabsProps                | packages/webview/src/components/ui/PageTabs.tsx:18:18                            | error    |
| TimelineProps                | packages/webview/src/components/ui/Timeline.tsx:16:18                            | error    |
| PoolStatus                   | packages/extension/src/core/engine/WorkerPool.ts:9:18                            | error    |
| MessageBrokerOptions         | packages/extension/src/bridge/MessageBroker.ts:16:18                             | error    |
| BridgeProviderProps          | packages/webview/src/bridge/BridgeProvider.tsx:11:18                             | error    |
| AboutDialogProps             | packages/webview/src/components/AboutDialog.tsx:7:18                             | error    |
| SoqlBuilderProps             | packages/webview/src/pages/Sync/SoqlBuilder.tsx:8:18                             | error    |
| SankeyFlowProps              | packages/webview/src/pages/Sync/SankeyFlow.tsx:20:18                             | error    |
| AutoSyncConfig               | packages/webview/src/stores/useCDCLiveStore.ts:30:18                             | error    |
| SettingsValues               | packages/webview/src/stores/useSettingsStore.ts:4:18                             | error    |
| KPICardVariant               | packages/webview/src/components/ui/KPICard.tsx:11:13                             | error    |
| OrgBadgeProps                | packages/webview/src/components/ui/OrgBadge.tsx:5:18                             | error    |
| SkeletonProps                | packages/webview/src/components/ui/Skeleton.tsx:5:18                             | error    |
| SkipLinkProps                | packages/webview/src/components/ui/SkipLink.tsx:5:18                             | error    |
| CDCLiveState                 | packages/webview/src/stores/useCDCLiveStore.ts:44:18                             | error    |
| KPICardProps                 | packages/webview/src/components/ui/KPICard.tsx:14:18                             | error    |
| SpinnerProps                 | packages/webview/src/components/ui/Spinner.tsx:13:18                             | error    |
| TopBarProps                  | packages/webview/src/layouts/TopBar/TopBar.tsx:31:18                             | error    |
| DividerOrientation           | packages/webview/src/components/ui/Divider.tsx:5:13                              | error    |
| AnonymizationRule            | packages/shared/src/types/autopilot.types.ts:250:45                              | error    |
| AIChatPanelProps             | packages/webview/src/pages/AI/AIChatPanel.tsx:26:18                              | error    |
| SeedWizardProps              | packages/webview/src/pages/Seed/SeedWizard.tsx:9:13                              | error    |
| SyncWizardProps              | packages/webview/src/pages/Sync/SyncWizard.tsx:7:13                              | error    |
| DividerProps                 | packages/webview/src/components/ui/Divider.tsx:8:18                              | error    |
| StepperProps                 | packages/webview/src/components/ui/Stepper.tsx:5:18                              | error    |
| TooltipProps                 | packages/webview/src/components/ui/Tooltip.tsx:6:18                              | error    |
| GrappeState                  | packages/webview/src/stores/useGrappeStore.ts:12:18                              | error    |
| ButtonProps                  | packages/webview/src/components/ui/Button.tsx:18:18                              | error    |
| SelectProps                  | packages/webview/src/components/ui/Select.tsx:12:18                              | error    |
| ButtonSize                   | packages/webview/src/components/ui/Button.tsx:10:13                              | error    |
| SOQLValidationResult         | packages/extension/src/modules/ai/NL2SOQL.ts:22:18                               | error    |
| GrappePartitionUI            | packages/webview/src/stores/useGrappeStore.ts:5:18                               | error    |
| ValidationResult             | packages/extension/src/core/cli/CliParser.ts:25:18                               | error    |
| BridgeQueryState             | packages/webview/src/hooks/useBridgeQuery.ts:11:18                               | error    |
| ButtonVariant                | packages/webview/src/components/ui/Button.tsx:7:13                               | error    |
| SOQLFavorite                 | packages/extension/src/modules/ai/NL2SOQL.ts:28:18                               | error    |
| SearchResult                 | packages/webview/src/workers/searchWorker.ts:17:18                               | error    |
| SelectOption                 | packages/webview/src/components/ui/Select.tsx:5:18                               | error    |
| SearchMatch                  | packages/webview/src/workers/searchWorker.ts:10:18                               | error    |
| AvatarProps                  | packages/webview/src/components/ui/Avatar.tsx:8:18                               | error    |
| DialogProps                  | packages/webview/src/components/ui/Dialog.tsx:5:18                               | error    |
| DrawerProps                  | packages/webview/src/components/ui/Drawer.tsx:6:18                               | error    |
| ForgePhase                   | packages/webview/src/stores/useForgeStore.ts:63:13                               | error    |
| ForgeState                   | packages/webview/src/stores/useForgeStore.ts:95:18                               | error    |
| AvatarSize                   | packages/webview/src/components/ui/Avatar.tsx:5:13                               | error    |
| ForgeAnonymizationCategory   | packages/webview/src/stores/useForgeStore.ts:28:3                                | error    |
| UsePaginationResult          | packages/webview/src/hooks/usePagination.ts:16:18                                | error    |
| ForgeBatchStrategy           | packages/webview/src/stores/useForgeStore.ts:29:3                                | error    |
| CliOutputFormat              | packages/extension/src/core/cli/CliRunner.ts:6:13                                | error    |
| CardHeaderProps              | packages/webview/src/components/ui/Card.tsx:20:18                                | error    |
| CliCommandName               | packages/extension/src/core/cli/CliParser.ts:2:13                                | error    |
| ForgeGraphEdge               | packages/webview/src/stores/useForgeStore.ts:23:3                                | error    |
| BadgeProps                   | packages/webview/src/components/ui/Badge.tsx:8:18                                | error    |
| InputProps                   | packages/webview/src/components/ui/Input.tsx:5:18                                | error    |
| ToastLevel                   | packages/webview/src/components/ui/Toast.tsx:6:13                                | error    |
| ToastProps                   | packages/webview/src/components/ui/Toast.tsx:9:18                                | error    |
| CliResult                    | packages/extension/src/core/cli/CliRunner.ts:9:18                                | error    |
| CardProps                    | packages/webview/src/components/ui/Card.tsx:12:18                                | error    |
| ChipProps                    | packages/webview/src/components/ui/Chip.tsx:11:18                                | error    |
| TabsProps                    | packages/webview/src/components/ui/Tabs.tsx:13:18                                | error    |
| UsePaginationOptions         | packages/webview/src/hooks/usePagination.ts:4:18                                 | error    |
| ChipVariant                  | packages/webview/src/components/ui/Chip.tsx:5:13                                 | error    |
| DiffResult                   | packages/webview/src/workers/diffWorker.ts:15:18                                 | error    |
| IconProps                    | packages/webview/src/components/ui/Icon.tsx:5:18                                 | error    |
| LogoProps                    | packages/webview/src/components/ui/Logo.tsx:7:18                                 | error    |
| AppState                     | packages/webview/src/stores/useAppStore.ts:39:18                                 | error    |
| ChipSize                     | packages/webview/src/components/ui/Chip.tsx:8:13                                 | error    |
| LogoSize                     | packages/webview/src/components/ui/Logo.tsx:4:13                                 | error    |
| TabItem                      | packages/webview/src/components/ui/Tabs.tsx:5:18                                 | error    |
| AppShellProps                | packages/webview/src/layouts/AppShell.tsx:16:18                                  | error    |
| FieldChange                  | packages/webview/src/workers/diffWorker.ts:9:18                                  | error    |
| VSCodeApi                    | packages/webview/src/hooks/useVSCodeApi.ts:4:18                                  | error    |
| OrgState                     | packages/webview/src/stores/useOrgStore.ts:5:18                                  | error    |
| DateFormatStyle              | packages/webview/src/utils/formatters.ts:19:13                                   | error    |
| ThemeKind                    | packages/webview/src/hooks/useTheme.ts:4:13                                      | error    |
| PanelRouterProps             | packages/webview/src/PanelRouter.tsx:39:18                                       | error    |
| SupportedLanguage            | packages/webview/src/i18n/index.ts:12:13                                         | error    |

## Duplicate exports (1)

| Name                                   | Location                              | Severity |
| :------------------------------------- | :------------------------------------ | :------- |
| orgTypeToGuardTier|orgTypeToSafetyTier | packages/shared/src/utils/sf-utils.ts | error    |

 ELIFECYCLE  Command failed with exit code 1.
```
