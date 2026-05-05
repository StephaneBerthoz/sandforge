import { z } from 'zod';

/**
 * Domain-level Zod discriminated unions for every bridge message type.
 *
 * Each domain is its own `z.discriminatedUnion('type', [...])`. The full bridge
 * surface is the union of all domains. This gives us:
 *
 *   - O(1) type dispatch at parse time (discriminated unions are indexed by the
 *     discriminant value).
 *   - Clear domain ownership when new messages are added.
 *   - Small schemas per member — each member validates only the fields it owns,
 *     with `.passthrough()` tolerated on nested objects whose exact shape isn't
 *     strictly guarded yet (i.e. the goal is envelope + type coverage, not full
 *     payload validation which will be tightened incrementally).
 *
 * Coverage audit (2026-04-24): every literal `type: 'xxx:yyy'` value appearing
 * in `packages/shared/src/types/messages.types.ts` is represented below. If a
 * new message type is introduced, add it to the matching domain union or
 * create a new domain union and extend {@link BridgeMessageSchema}.
 */

// Base shape that every member shares — id, type, timestamp, optional correlationId.
const baseShape = {
  id: z.string().min(1),
  timestamp: z.number().finite(),
  correlationId: z.string().min(1).optional(),
};

/**
 * Helper to build a member schema: base + discriminant + optional payload
 * passthrough. Keeps per-member declarations concise and consistent.
 */
function msg<T extends string>(type: T) {
  return z
    .object({ ...baseShape, type: z.literal(type), payload: z.unknown().optional() })
    .passthrough();
}

// ─── Domain: Org ─────────────────────────────────────────────────────────────
export const OrgMessageSchema = z.discriminatedUnion('type', [
  msg('org:list'),
  msg('org:list:response'),
  msg('org:connect'),
  msg('org:disconnect'),
  msg('org:statusChanged'),
  msg('org:selected'),
]);

// ─── Domain: Seed ────────────────────────────────────────────────────────────
export const SeedMessageSchema = z.discriminatedUnion('type', [
  msg('seed:execute'),
  msg('seed:describe-global'),
  msg('seed:describe-object'),
  msg('seed:template:save'),
  msg('seed:template:load'),
  msg('seed:template:list'),
  msg('seed:template:delete'),
  msg('seed:template:save:response'),
  msg('seed:template:load:response'),
  msg('seed:template:list:response'),
  msg('seed:template:delete:response'),
  msg('seed:csv:execute'),
  msg('seed:csv:validate'),
  msg('seed:csv:validate:response'),
  msg('seed:clone:execute'),
  msg('seed:clone:preview'),
  msg('seed:clone:preview:response'),
  msg('seed:clone:describe-source'),
  msg('seed:clone:describe-source:response'),
  msg('seed:list-personas'),
  msg('seed:list-personas:response'),
  msg('seed:create-persona'),
  msg('seed:create-persona:response'),
]);

// ─── Domain: Sync ────────────────────────────────────────────────────────────
export const SyncMessageSchema = z.discriminatedUnion('type', [
  msg('sync:execute'),
  msg('sync:describe-global'),
  msg('sync:describe-fields'),
  msg('sync:config:save'),
  msg('sync:config:load'),
  msg('sync:config:list'),
  msg('sync:config:delete'),
  msg('sync:config:save:response'),
  msg('sync:config:load:response'),
  msg('sync:config:list:response'),
  msg('sync:config:delete:response'),
  msg('sync:history:list'),
  msg('sync:history:list:response'),
  msg('sync:history:detail'),
  msg('sync:history:detail:response'),
  msg('sync:history:rerun'),
  msg('sync:history:export'),
  msg('sync:history:export:response'),
  msg('sync:schedule:list'),
  msg('sync:schedule:list:response'),
  msg('sync:schedule:upsert'),
  msg('sync:schedule:upsert:response'),
  msg('sync:schedule:toggle'),
  msg('sync:schedule:toggle:response'),
  msg('sync:schedule:delete'),
  msg('sync:schedule:delete:response'),
]);

// ─── Domain: Monitor ─────────────────────────────────────────────────────────
export const MonitorMessageSchema = z.discriminatedUnion('type', [
  msg('monitor:refresh'),
  msg('monitor:start'),
  msg('monitor:trends'),
  msg('monitor:abort-job'),
  msg('monitor:abort-job:response'),
  msg('monitor:live-operations'),
  msg('monitor:live-operations:response'),
  msg('monitor:live-operations:updated'),
  msg('monitor:health-score'),
  msg('monitor:health-score:response'),
  msg('monitor:storage'),
  msg('monitor:storage:response'),
  msg('monitor:deployments'),
  msg('monitor:deployments:response'),
  msg('monitor:api-usage'),
  msg('monitor:api-usage:response'),
  msg('monitor:error-logs'),
  msg('monitor:error-logs:response'),
  msg('monitor:sessions'),
  msg('monitor:sessions:response'),
  msg('monitor:apex-insights'),
  msg('monitor:apex-insights:response'),
  msg('monitor:sandbox-refresh'),
  msg('monitor:sandbox-refresh:response'),
  // Phase 03 Plan 03-01 — MetricBus envelope variants. Payload validation is
  // delegated to the inner `MetricEvent`/`MetricSample` Zod schemas at the
  // MetricBus boundary; the bridge schema only enforces envelope + discriminant.
  msg('monitor:metric'),
  msg('monitor:metrics:batch'),
  msg('monitor:metric:subscribe'),
  // Phase 03 Plan 03-06 — ReportExporter envelope variants. Bridge schema
  // enforces envelope + discriminant; payload shapes are typed in
  // `messages.types.ts` (`MonitorExport{Request,Response,Progress}Message`).
  msg('monitor:export:request'),
  msg('monitor:export:response'),
  msg('monitor:export:progress'),
  // Phase 03 Plan 03-07 — Multi-org fleet overview + visibility gate envelope.
  // The request/response handshake powers the MonitorOverviewPage; the
  // visibility message is the audit M1 mitigation (WebView -> Extension).
  // Payload shapes are typed in `messages.types.ts` (`MonitorFleetSummary*`,
  // `MonitorVisibilityMessage`).
  msg('monitor:fleet:summary:request'),
  msg('monitor:fleet:summary:response'),
  msg('monitor:visibility'),
]);

// ─── Domain: Compare ─────────────────────────────────────────────────────────
export const CompareMessageSchema = z.discriminatedUnion('type', [
  msg('compare:execute'),
  msg('compare:start'),
  msg('compare:permissions'),
  msg('compare:snapshots'),
  msg('compare:drift'),
]);

// ─── Domain: DataOps (includes backup, precheck, dataops, governance) ────────
export const DataOpsMessageSchema = z.discriminatedUnion('type', [
  msg('backup:execute'),
  msg('dataops:backup'),
  msg('dataops:rollback'),
  msg('dataops:anonymize'),
  msg('dataops:anonymization-templates'),
  msg('dataops:anonymization-templates:response'),
  msg('dataops:masking-templates-by-object'),
  msg('dataops:masking-templates-by-object:response'),
  msg('precheck:pii-scan'),
  msg('precheck:pii-scan:response'),
  msg('governance:policies:list'),
  msg('governance:policy:get'),
  msg('governance:policy:save'),
  msg('governance:policy:delete'),
  msg('governance:policies:export'),
  msg('governance:policies:import'),
  msg('governance:evaluate'),
  msg('governance:templates'),
]);

// ─── Domain: Automation (pipeline + marketplace + migration + plugins) ───────
export const AutomationMessageSchema = z.discriminatedUnion('type', [
  msg('pipeline:run'),
  msg('pipeline:execute'),
  msg('pipeline:templates'),
  msg('pipeline:templates:response'),
  msg('pipeline:list'),
  msg('pipeline:history'),
  msg('pipeline:save'),
  msg('marketplace:list'),
  msg('marketplace:list:response'),
  msg('marketplace:install'),
  msg('marketplace:install:response'),
  msg('migration:import'),
  msg('migration:import:response'),
  msg('migration:import-sfdmu'),
  msg('migration:import-sfdmu:response'),
  msg('plugins:list'),
  msg('plugins:list:response'),
  msg('plugins:load'),
  msg('plugins:load:response'),
  msg('plugins:unload'),
  msg('plugins:unload:response'),
  msg('autopilot:scan-schema'),
  msg('autopilot:schema-result'),
  msg('autopilot:generate-plan'),
  msg('autopilot:plan-ready'),
  msg('autopilot:execute'),
  msg('autopilot:node-progress'),
  msg('autopilot:node-completed'),
  msg('autopilot:node-failed'),
  msg('autopilot:pause'),
  msg('autopilot:resume'),
  msg('autopilot:skip-node'),
  msg('autopilot:completed'),
  msg('autopilot:compliance-report'),
  msg('forge:preview'),
  msg('forge:discover'),
  msg('forge:execute'),
  msg('forge:pause'),
  msg('forge:resume'),
  msg('forge:abort'),
  msg('forge:templates:list'),
  msg('forge:templates:save'),
  msg('forge:templates:delete'),
  msg('forge:history:list'),
  msg('forge:plan:request'),
  msg('forge:compliance:request'),
  msg('forge:metadata-diff:request'),
]);

// ─── Domain: Execution + Operation lifecycle + grappe ────────────────────────
export const ExecutionMessageSchema = z.discriminatedUnion('type', [
  msg('operation:cancel'),
  msg('operation:pause'),
  msg('operation:resume'),
  msg('operation:started'),
  msg('operation:progress'),
  msg('operation:completed'),
  msg('operation:failed'),
  msg('execution:progress'),
  msg('execution:retry-status'),
  msg('execution:manual-retry'),
  msg('execution:abort'),
  msg('execution:status'),
  msg('execution:list'),
  msg('grappe:started'),
  msg('grappe:partitionProgress'),
  msg('grappe:backPressure'),
  msg('grappe:completed'),
]);

// ─── Domain: AI ──────────────────────────────────────────────────────────────
export const AIMessageSchema = z.discriminatedUnion('type', [
  msg('ai:chat'),
  msg('ai:chat:response'),
  msg('ai:conversation:create'),
  msg('ai:conversation:created'),
  msg('ai:conversation:load'),
  msg('ai:conversation:loaded'),
  msg('ai:conversation:delete'),
  msg('ai:conversation:deleted'),
  msg('ai:conversation:list'),
  msg('ai:conversation:list:response'),
  msg('ai:status'),
  msg('ai:status:response'),
  msg('ai:save-key'),
  msg('ai:save-key:response'),
  msg('ai:error'),
  msg('ai:nl2soql'),
  msg('ai:nl2soql:response'),
  msg('ai:resolve-error'),
  msg('ai:resolve-error:response'),
  msg('ai:personas'),
  msg('ai:personas:response'),
  msg('ai:anomaly-scan'),
  msg('ai:anomaly-scan:response'),
  msg('ai:suggestions'),
  msg('ai:suggestions:response'),
  msg('ai:generate-pipeline'),
  msg('ai:generate-pipeline:response'),
  msg('ai:schema-advice'),
  msg('ai:schema-advice:response'),
  // Phase 04 plan 04-02: provider status banner (breaker open / half-open / closed).
  msg('ai:provider:status'),
  // Phase 04 plan 04-03: per-tool-call trace event (start / success / error).
  msg('ai:tool-trace'),
  // Phase 04 plan 04-05: per-panel-session token budget surface.
  msg('ai:budget:state'),
  msg('ai:budget:warn'),
  msg('ai:budget:exceeded'),
  // Phase 04 plan 04-04: diagnose flow + per-action approve gate.
  msg('ai:diagnose'),
  msg('ai:diagnose:response'),
  msg('ai:approve-action'),
  msg('ai:approve-action:response'),
]);

// ─── Domain: Settings (includes onboarding, hint, telemetry, config, whats-new, notification, state) ─
export const SettingsMessageSchema = z.discriminatedUnion('type', [
  msg('settings:get'),
  msg('settings:update'),
  msg('settings:response'),
  msg('onboarding:complete'),
  msg('onboarding:reset'),
  msg('onboarding:show'),
  msg('hint:dismiss'),
  msg('telemetry:status'),
  msg('telemetry:status:response'),
  msg('telemetry:toggle'),
  msg('telemetry:toggle:response'),
  msg('whats-new:show'),
  msg('notification'),
  msg('state:sync'),
  msg('connectivity:status'),
  msg('connectivity:status:response'),
  msg('config:export'),
  msg('config:export:response'),
  msg('config:import'),
  msg('config:import:response'),
  msg('config:categories'),
  msg('config:categories:response'),
  msg('config:validate'),
  msg('config:validate:response'),
  // Bridge control messages (emitted by the MessageBroker itself)
  msg('bridge:error'),
  msg('bridge:protocol-mismatch'),
  msg('bridge:reload-banner'),
  msg('workbench:reload'),
]);

// ─── Domain: Realtime (CDC) ──────────────────────────────────────────────────
export const RealtimeMessageSchema = z.discriminatedUnion('type', [
  msg('realtime:start'),
  msg('realtime:stop'),
  msg('realtime:status'),
  msg('realtime:status:response'),
  msg('realtime:metrics'),
  msg('realtime:metrics:response'),
  msg('realtime:resolve-conflict'),
  msg('realtime:started'),
  msg('realtime:stopped'),
  msg('realtime:event'),
  msg('realtime:events-batch'),
  msg('realtime:conflict'),
  msg('realtime:conflict-resolved'),
]);

// ─── Domain: Conflict (scheduler — scheduled ops & conflict routing) ─────────
export const ConflictMessageSchema = z.discriminatedUnion('type', [
  msg('scheduler:list'),
  msg('scheduler:list:response'),
  msg('scheduler:upsert'),
  msg('scheduler:upsert:response'),
  msg('scheduler:delete'),
  msg('scheduler:delete:response'),
  msg('scheduler:toggle'),
  msg('scheduler:toggle:response'),
]);

// ─── Domain: Cache ───────────────────────────────────────────────────────────
export const CacheMessageSchema = z.discriminatedUnion('type', [
  msg('cache:invalidate-all'),
  msg('cache:invalidate-all:response'),
  msg('cache:get-stats'),
  msg('cache:stats-response'),
]);

// ─── Domain: SmartAction + QuickSync ─────────────────────────────────────────
export const SmartActionMessageSchema = z.discriminatedUnion('type', [
  msg('smart-action:analyze'),
  msg('smart-action:analyze:response'),
  msg('quicksync:suggest-objects'),
  msg('quicksync:detect-relationships'),
  msg('quicksync:preview'),
  msg('quicksync:execute'),
]);

/**
 * Full bridge message surface — union of every domain union.
 *
 * Use `BridgeMessageSchema.safeParse(raw)` at the message boundary to validate
 * any inbound payload. Members whose shape isn't strictly known yet still pass
 * if they include the base fields + a recognised `type` literal (passthrough on
 * extra keys).
 */
export const BridgeMessageSchema = z.union([
  OrgMessageSchema,
  SeedMessageSchema,
  SyncMessageSchema,
  MonitorMessageSchema,
  CompareMessageSchema,
  DataOpsMessageSchema,
  AutomationMessageSchema,
  ExecutionMessageSchema,
  AIMessageSchema,
  SettingsMessageSchema,
  RealtimeMessageSchema,
  ConflictMessageSchema,
  CacheMessageSchema,
  SmartActionMessageSchema,
]);

/** Inferred TS type of any valid bridge message (after parse). */
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

/**
 * Envelope schema wrapping every bridge message with a protocol version.
 *
 * Shape: `{ protocolVersion: number, correlationId?: string, payload: BridgeMessage }`.
 *
 * The envelope's `correlationId` is redundant with the inner message's
 * `correlationId` but surfaced at the envelope level for observability tools
 * that don't parse the payload. Either may be set; the handler uses whichever
 * is present.
 */
export const EnvelopedMessageSchema = z.object({
  protocolVersion: z.number().int().positive(),
  correlationId: z.string().min(1).optional(),
  payload: BridgeMessageSchema,
});

/** Inferred TS type of a valid enveloped message. */
export type EnvelopedMessage = z.infer<typeof EnvelopedMessageSchema>;
