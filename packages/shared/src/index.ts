// Barrel exports — Types
export * from './types/common.types.js';
export * from './types/org.types.js';
export * from './types/errors.types.js';
export * from './types/pipeline.types.js';
export * from './types/grappe.types.js';
export * from './types/seed.types.js';
export * from './types/clone.types.js';
export * from './types/sync.types.js';
export * from './types/monitor.types.js';
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
  type AnonymizationSummary,
  type AutopilotConfig,
  type AutopilotEventType,
  type AutopilotEvent,
  type AutopilotNodeProgressEvent,
  type AutopilotNodeCompletedEvent,
  type AutopilotNodeFailedEvent,
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
export * from './schemas/pipeline.schema.js';
export * from './schemas/grappe.schema.js';
export * from './schemas/settings.schema.js';
export * from './schemas/autopilot.schema.js';
export * from './schemas/compliance.schema.js';
export * from './schemas/forge.schema.js';
export * from './schemas/robustness-config.schema.js';
export * from './schemas/quickSync.schema.js';
export * from './schemas/ai/index.js';

// Barrel exports — Constants
export * from './constants/sf-limits.js';
export * from './constants/sf-standard-objects.js';
export * from './constants/sf-field-types.js';
export * from './constants/error-codes.js';
export * from './constants/defaults.js';
export * from './constants/ai-config.js';
export * from './constants/monitor.js';
export * from './constants/seed-templates.js';
export * from './constants/sync-templates.js';

// Barrel exports — Utils
export * from './utils/sf-utils.js';
export * from './utils/format-utils.js';

// Barrel exports — Templates
export * from './templates/forge-builtin-templates.js';
export * from './templates/forge-anonymization-presets.js';
