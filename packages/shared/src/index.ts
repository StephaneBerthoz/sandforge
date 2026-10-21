// Barrel exports — Types
export * from './types/common.types.js';
export * from './types/org.types.js';
export * from './types/errors.types.js';
export * from './types/grappe.types.js';
export * from './types/seed.types.js';
export * from './types/clone.types.js';
export * from './types/sync.types.js';
export * from './types/monitor.types.js';
export * from './types/governance.types.js';
export * from './types/compare.types.js';
export * from './types/dataops.types.js';
export * from './types/automation.types.js';
export {
  type AutopilotNodeStatus,
  type RelationshipType,
  type AutopilotNode,
  type AutopilotEdge,
  type CycleResolutionStrategy,
  type CycleResolution,
  type GraphStats,
  type AutopilotGraph,
  type ExecutionWave,
  type ExecutionPlan,
  type AutopilotLeftOutReason,
  type AutopilotLookupLeftEmpty,
  type AutopilotPlanScope,
  type AutopilotCurrencyPlan,
  type ExpectedPersonalData,
  type AnonymizationSummary,
  type AutopilotConfig,
  type AutopilotObjectListing,
  type AutopilotEventType,
  type AutopilotEvent,
  type AutopilotNodeProgressEvent,
  type AutopilotNodeCompletedEvent,
  type AutopilotNodeFailedEvent,
  type AutopilotRefusal,
  type AnonymizationOverride,
  type PIICategory,
  type PIIFieldDetection,
  type AnonymizedPersona,
  type AutopilotAnonymizationRule,
} from './types/autopilot.types.js';
export * from './types/compliance.types.js';
export * from './types/reporting.types.js';
export * from './types/messages.types.js';
export * from './types/precheck.types.js';
export * from './types/settings.types.js';
export * from './types/forge.types.js';
export * from './types/frozen.types.js';
export * from './types/quickSync.types.js';
export * from './types/execution.types.js';
export * from './types/smart-action.types.js';

// Barrel exports — Bridge
// NOTE: PROTOCOL_VERSION + isVersionCompatible are re-exported as named exports
// (not via `export *`) so Vite's ESM interop can read them reliably when the
// dist is compiled to CommonJS. See #vite-cjs-interop in the E2E setup notes.
export { PROTOCOL_VERSION, isVersionCompatible } from './bridge/protocolVersion.js';
export type { ProtocolVersion } from './bridge/protocolVersion.js';
export * from './bridge/messageSchemas.js';

// Barrel exports — Schemas
export * from './schemas/seed-config.schema.js';
export * from './schemas/sync-config.schema.js';
export * from './schemas/autopilot.schema.js';
export * from './schemas/forge.schema.js';
export * from './schemas/robustness-config.schema.js';
export * from './schemas/quickSync.schema.js';
export * from './schemas/ai/index.js';

// Barrel exports — Constants
export * from './constants/sf-limits.js';
export * from './constants/sf-field-types.js';
export * from './constants/error-codes.js';
export * from './constants/defaults.js';
export * from './constants/ai-config.js';
export * from './constants/monitor.js';
export * from './constants/seed-templates.js';
export * from './constants/seed-locales.js';
export * from './constants/faker-methods.js';
export * from './constants/faker-field-defaults.js';
export * from './constants/sync-templates.js';
export * from './constants/data-quality.js';
export * from './constants/metadata-deploy.js';
export { TRIGGERED_RUN_PREFIX, isTriggeredRun } from './constants/pipeline-triggers.js';
export * from './constants/data-compliance.js';
export {
  SIDEPANEL_LOCALE_NAMESPACES,
  sidepanelLocaleSubset,
} from './constants/sidepanel-locale.js';
export {
  ALLOW_DUPLICATE_RULE_HEADER,
  duplicateRuleHeaders,
  DUPLICATE_RULE_ERROR,
  isDuplicateRuleError,
  ALREADY_EXISTS_ERROR,
  isAlreadyExistsError,
} from './constants/duplicate-rules.js';
export {
  AUTO_ASSIGN_HEADER,
  forgeWriteHeaders,
  recordWriteHeaders,
  type ForgeWriteOptions,
} from './constants/forge-write-headers.js';
export {
  isProvisioningObject,
  isFileBodiedObject,
  isUncopyableObject,
  UNCOPYABLE_OBJECT_NAMES,
} from './constants/uncopyable-objects.js';
export {
  BYTES_PER_MB,
  FILE_COPY_DEFAULT_MAX_MB,
  FILE_COPY_CEILING_MB,
  SYNC_FILES_DEFAULT_RUN_MB,
  SYNC_FILES_MAX_RUN_MB,
  fileCopyRefusal,
  isFileContentField,
} from './constants/file-copy.js';
export { SYNC_CONFLICT_STRATEGIES } from './constants/sync-conflict-strategies.js';
export {
  PLATFORM_REQUIRED_FIELDS,
  isPlatformRequiredField,
  isInsertOnlyField,
  isRequiredLookup,
  isSettableField,
} from './constants/platform-required-fields.js';
export {
  LOCKED_PAST_DRAFT,
  STATUS_NEEDS_CHILDREN,
  type ChildrenAStatusNeeds,
  type LockedPastDraft,
} from './constants/status-children.js';
export {
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_OBJECT,
  PRICEBOOK_ENTRY_BOOK_FIELD,
  STANDARD_PRICEBOOK_SOQL,
  isPricebookEntry,
  seedsStandardPricebook,
  splitStandardPricebookEntries,
  dedupePricebookEntries,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  type PricebookEntryKey,
} from './constants/standard-pricebook.js';
export {
  EXCLUSIVE_FIELD_GROUPS,
  exclusiveFieldsToDrop,
  type ExclusiveFieldGroup,
} from './constants/exclusive-fields.js';
export {
  SAVED_TEMPLATE_METHODS,
  isSavedTemplateMethod,
  TEMPLATE_FIELD_PATTERN,
  TEMPLATE_NAME_MAX_LENGTH,
  TEMPLATE_MAX_RULES,
  TEMPLATE_SETTING_MAX,
  savedRuleSettingProblem,
  savedTemplateRuleSchema,
  type SavedTemplateMethod,
  type SavedTemplateRuleConfig,
  type SavedRuleSettingProblem,
} from './constants/saved-anonymization-templates.js';

// Barrel exports — Utils
export * from './utils/sf-utils.js';
export * from './utils/org-kind.js';
export * from './utils/format-utils.js';
export * from './utils/persona-field-rules.js';
export * from './utils/seed-relations.js';
export * from './utils/account-kinds.js';
export {
  FORGE_GUIDE_URL,
  SALESFORCE_HELP_SEARCH_URL,
  bannerHintOf,
  cataloguedErrorCodes,
  guideAnchorOf,
  helpSearchUrlOf,
  isCataloguedErrorCode,
  panelWordingOf,
  translateError,
  type ErrorHint,
  type ErrorHintModule,
  type ErrorHintSeverity,
  type TranslateErrorOptions,
} from './utils/error-hints.js';
export {
  groupRecordErrors,
  parseRecordError,
  type ParsedRecordError,
  type RecordErrorGroup,
} from './utils/record-error-groups.js';
export {
  forgeRemovalPlanCountsLeft,
  forgeRemovalPlanLeft,
  forgeRemovalPlanOf,
  forgeRunCountsLeft,
  forgeRunCreatedRecords,
  forgeRunCreatedSome,
  forgeRunLinkedKept,
  forgeRunLinkedKeptCount,
  forgeRunRecordsLeft,
  removalTookAll,
  type ForgeRunCounted,
  type ForgeRunObjectRecords,
} from './utils/forge-run-records.js';
export {
  csvCell,
  idMapCsv,
  idMapCsvLines,
  idMapRows,
  type IdMapOutcome,
  type IdMapRow,
} from './utils/forge-id-map.js';
export {
  leftOutAsEmptyTable,
  leftOutByTheUser,
  objectsBeyondTheGraph,
} from './utils/forge-graph-nodes.js';
export { FORGE_GRAPH_VIEWS, isForgeGraphView } from './utils/forge-graph-view.js';
export { leftOutCosts, type ForgeLeftOutCost } from './utils/forge-left-out-costs.js';
export {
  forgeGapId,
  forgeGapParts,
  gapAssignEntry,
  gapAssignments,
  mergeGaps,
} from './utils/forge-gaps.js';
export type { ForgeGapAssignment, ForgeGapParts } from './utils/forge-gaps.js';
export {
  assignPermsetCommand,
  automationByWrite,
  blindedBy,
  bypassAssignmentsOf,
  bypassesOfWrites,
  bypassPermissionsOf,
  emailsPerInsertOf,
  firedOnInsert,
  firedOnRemovalOf,
  firedOnWriteOf,
  heldBypassPermissionsOf,
  removalBypassesOf,
  removalRisksOf,
  type ForgeAutomationFired,
  type ForgeAutomationOfWrite,
  type ForgeAutomationWrite,
  type ForgeBypassAssignment,
  type ForgeEmailsPerInsert,
  type ForgeFiredOnWrite,
} from './utils/forge-target-automation.js';
export { seedEmailEstimates, seedEmailsRefused } from './utils/seed-automation.js';
export {
  FORGE_READ_CEILING_PER_OBJECT,
  FORGE_MAX_RECORDS_PER_OBJECT_BOUND,
  FORGE_RUN_GATE_CODES,
  forgeRunGateStopOf,
  isForgeRunGateCode,
  type ForgeRunGateCode,
  type ForgeRunGateStop,
} from './utils/forge-run-gate.js';
export {
  COMPARE_DIFFERENCE_COUNT,
  conditionDefect,
  conditionSourceDefect,
  evaluateCondition,
  PRECHECK_VARIABLES,
  PREVIOUS_STEP_STATUS,
  type ConditionSourceDefect,
} from './utils/pipelineCondition.js';
export {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  APPROVAL_MAX_TIMEOUT_MINUTES,
  approvalDefect,
  approvalTimeoutMinutes,
  isPipelineStepType,
  isRetiredPipelineStepType,
  PIPELINE_STEP_TYPES,
  RETIRED_PIPELINE_STEP_TYPES,
  type ApprovalDefect,
} from './utils/pipelineStepRules.js';

// Barrel exports — Templates
export * from './templates/forge-builtin-templates.js';
export * from './templates/forge-anonymization-presets.js';
