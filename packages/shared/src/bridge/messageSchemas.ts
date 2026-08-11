import { z } from 'zod';

/**
 * Domain-level Zod discriminated unions for every bridge message type.
 *
 * Each domain declares its member literals as a `const …Messages = [...] as const`
 * array, then its schema is `z.discriminatedUnion('type', …Messages)`. The full
 * bridge surface is a single flattened discriminated union over all domain
 * arrays. This gives us:
 *
 *   - O(1) type dispatch at parse time (discriminated unions are indexed by the
 *     discriminant value — including at the root).
 *   - Clear domain ownership when new messages are added.
 *   - Small schemas per member — each member validates only the fields it owns,
 *     with `.passthrough()` tolerated on nested objects whose exact shape isn't
 *     strictly guarded yet (i.e. the goal is envelope + type coverage, not full
 *     payload validation which will be tightened incrementally).
 *
 * Coverage audit: `types/messages/coverage.test.ts` statically verifies the
 * Zod ↔ TS contract in both directions — every msg() literal below has
 * a TS interface (member of a directional union) with the same `type`, and
 * every TS message interface has its msg() member below. The emission side is
 * covered by `types/messages/emittedChannels.test.ts`, which scans the
 * extension sources and requires every channel literal actually posted to the
 * webview to have its msg() member below. If a new
 * message type is introduced, add it to the matching domain array here AND to
 * the matching `types/messages/<domain>.messages.ts` file (or create a new
 * domain on both sides). Genuinely untypeable-but-live literals go into the
 * test's KNOWN_CONTRACT_GAPS whitelist with a justification.
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
const OrgMessages = [
  msg('org:list'),
  msg('org:list:response'),
  msg('org:connect'),
  msg('org:disconnect'),
  msg('org:select'),
  msg('org:statusChanged'),
  msg('org:selected'),
  msg('org:error'),
] as const;
export const OrgMessageSchema = z.discriminatedUnion('type', OrgMessages);

// ─── Domain: Seed ────────────────────────────────────────────────────────────
const SeedMessages = [
  msg('seed:execute'),
  msg('seed:describe-global'),
  msg('seed:describe-object'),
  msg('seed:execute:response'),
  msg('seed:describe-global:response'),
  msg('seed:describe-object:response'),
  // Error channel for template/describe/execute/persona failures.
  msg('seed:error'),
  msg('seed:template:save'),
  msg('seed:template:load'),
  msg('seed:template:list'),
  msg('seed:template:delete'),
  msg('seed:template:save:response'),
  msg('seed:template:load:response'),
  msg('seed:template:list:response'),
  msg('seed:template:delete:response'),
  msg('seed:csv:execute'),
  msg('seed:csv:execute:response'),
  msg('seed:csv:validate'),
  msg('seed:csv:validate:response'),
  msg('seed:csv:error'),
  msg('seed:clone:execute'),
  msg('seed:clone:execute:response'),
  msg('seed:clone:preview'),
  msg('seed:clone:preview:response'),
  msg('seed:clone:describe-source'),
  msg('seed:clone:describe-source:response'),
  msg('seed:clone:error'),
  msg('seed:list-personas'),
  msg('seed:list-personas:response'),
  msg('seed:create-persona'),
  msg('seed:create-persona:response'),
] as const;
export const SeedMessageSchema = z.discriminatedUnion('type', SeedMessages);

// ─── Domain: Sync ────────────────────────────────────────────────────────────
const SyncMessages = [
  msg('sync:execute'),
  msg('sync:describe-global'),
  msg('sync:describe-fields'),
  msg('sync:execute:response'),
  msg('sync:describe-global:response'),
  msg('sync:describe-fields:response'),
  // Error channel for config/describe/execute failures.
  msg('sync:error'),
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
  // Error channel consumed by useSyncHistoryStore (payload.message).
  msg('sync:history:error'),
  msg('sync:schedule:list'),
  msg('sync:schedule:list:response'),
  msg('sync:schedule:upsert'),
  msg('sync:schedule:upsert:response'),
  msg('sync:schedule:toggle'),
  msg('sync:schedule:toggle:response'),
  msg('sync:schedule:delete'),
  msg('sync:schedule:delete:response'),
  // Error channel for schedule operations.
  msg('sync:schedule:error'),
] as const;
export const SyncMessageSchema = z.discriminatedUnion('type', SyncMessages);

// ─── Domain: Monitor ─────────────────────────────────────────────────────────
const MonitorMessages = [
  msg('monitor:refresh'),
  msg('monitor:start'),
  // Dashboard snapshot (trends included) and the domain error channel.
  msg('monitor:data'),
  msg('monitor:error'),
  msg('monitor:abort-job'),
  msg('monitor:abort-job:response'),
  msg('monitor:live-operations'),
  msg('monitor:live-operations:response'),
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
  // Alert panel (AlertsPanel / AlertHistoryPanel) — the result channel for
  // monitor:alerts is `monitor:alerts:result`, not `:response`.
  msg('monitor:alerts'),
  msg('monitor:alerts:result'),
  msg('monitor:alert:acknowledge'),
  msg('monitor:alert:acknowledge:response'),
  msg('monitor:alert:dismiss'),
  msg('monitor:alert:dismiss:response'),
  // (The `monitor:metric` / `monitor:metrics:batch` / `monitor:metric:subscribe`
  // MetricBus envelope variants + the `monitor:live-operations:updated` push
  // variant were purged with the extension-side Monitor v2 removal — no
  // emitter or consumer remains. The `monitor:export:*` envelopes were removed
  // when ReportExporter was dropped at P2; the legacy `MonitorExport*` TS
  // interfaces are gone too. The `monitor:fleet:summary:request/response` +
  // `monitor:visibility` envelopes were purged when MonitorOverviewPage /
  // useFleetStore / useVisibilityGate were deleted.)
] as const;
export const MonitorMessageSchema = z.discriminatedUnion('type', MonitorMessages);

// ─── Domain: Compare ─────────────────────────────────────────────────────────
const CompareMessages = [
  msg('compare:execute'),
  msg('compare:execute:response'),
  msg('compare:start'),
  msg('compare:permissions'),
  msg('compare:snapshots'),
  msg('compare:drift'),
  msg('compare:permissions:response'),
  msg('compare:snapshots:response'),
  msg('compare:drift:response'),
  msg('compare:error'),
] as const;
export const CompareMessageSchema = z.discriminatedUnion('type', CompareMessages);

// ─── Domain: DataOps (includes backup, precheck, dataops, governance) ────────
const DataOpsMessages = [
  msg('backup:execute'),
  msg('dataops:backup'),
  msg('dataops:rollback'),
  msg('dataops:anonymize'),
  msg('dataops:backup:response'),
  msg('dataops:rollback:response'),
  msg('dataops:anonymize:response'),
  // Error channel for backup/rollback/anonymize failures.
  msg('dataops:error'),
  msg('dataops:anonymization-templates'),
  msg('dataops:anonymization-templates:response'),
  msg('dataops:masking-templates-by-object'),
  msg('dataops:masking-templates-by-object:response'),
  msg('precheck:pii-scan'),
  msg('precheck:pii-scan:response'),
  msg('governance:policies:list'),
  // The result channel for governance:policies:list is
  // `governance:policies:result`, not `:response` (same convention as
  // monitor:alerts:result — both handler and webview were built on it).
  msg('governance:policies:result'),
  msg('governance:policy:get'),
  msg('governance:policy:save'),
  msg('governance:policy:delete'),
  msg('governance:policies:export'),
  msg('governance:policies:import'),
  msg('governance:evaluate'),
  msg('governance:templates'),
  msg('governance:policy:result'),
  msg('governance:policy:save:response'),
  msg('governance:policy:delete:response'),
  msg('governance:policies:export:response'),
  msg('governance:policies:import:response'),
  msg('governance:evaluate:response'),
  msg('governance:templates:response'),
  // Error channel for governance operations.
  msg('governance:error'),
] as const;
export const DataOpsMessageSchema = z.discriminatedUnion('type', DataOpsMessages);

// ─── Domain: Automation (pipeline + marketplace + migration + plugins) ───────
const AutomationMessages = [
  msg('pipeline:run'),
  msg('pipeline:execute'),
  msg('pipeline:run:response'),
  // Error channel for pipeline run/cancel/list/history/save failures.
  msg('pipeline:error'),
  msg('pipeline:templates'),
  msg('pipeline:templates:response'),
  msg('pipeline:list'),
  msg('pipeline:list:response'),
  msg('pipeline:history'),
  msg('pipeline:history:response'),
  msg('pipeline:save'),
  msg('pipeline:save:response'),
  msg('marketplace:list'),
  msg('marketplace:list:response'),
  msg('marketplace:install'),
  msg('marketplace:install:response'),
  msg('migration:import'),
  msg('migration:import:response'),
  msg('migration:import-sfdmu'),
  msg('migration:import-sfdmu:response'),
  // Error channel for migration import failures.
  msg('migration:error'),
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
  msg('autopilot:pause'),
  msg('autopilot:resume'),
  msg('autopilot:skip-node'),
  msg('autopilot:completed'),
  msg('autopilot:compliance-report'),
  // Error channel for autopilot scan/plan/execute/pause/resume/skip failures.
  msg('autopilot:error'),
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
  msg('forge:target-preflight:request'),
  msg('forge:target-preflight:response'),
  msg('forge:target-preflight:error'),
  // Forge responses / progress events / error channels (Extension -> WebView).
  msg('forge:preview:response'),
  msg('forge:preview:error'),
  msg('forge:discover:response'),
  msg('forge:discover:progress'),
  msg('forge:discover:error'),
  msg('forge:execute:response'),
  msg('forge:progress'),
  msg('forge:execute:error'),
  msg('forge:templates:list:response'),
  msg('forge:templates:save:response'),
  msg('forge:templates:save:error'),
  msg('forge:templates:delete:response'),
  msg('forge:templates:delete:error'),
  msg('forge:history:list:response'),
  msg('forge:plan:response'),
  msg('forge:plan:error'),
  msg('forge:compliance:response'),
  msg('forge:compliance:error'),
  msg('forge:metadata-diff:response'),
  msg('forge:metadata-diff:error'),
] as const;
export const AutomationMessageSchema = z.discriminatedUnion('type', AutomationMessages);

// ─── Domain: Execution + Operation lifecycle + grappe ────────────────────────
const ExecutionMessages = [
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
  msg('execution:abort:response'),
  msg('execution:status:response'),
  msg('execution:list:response'),
  // Error channel for execution operations.
  msg('execution:error'),
  msg('grappe:started'),
  msg('grappe:partitionProgress'),
  msg('grappe:completed'),
] as const;
export const ExecutionMessageSchema = z.discriminatedUnion('type', ExecutionMessages);

// ─── Domain: AI ──────────────────────────────────────────────────────────────
const AIMessages = [
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
  // Phase 04 plan 04-05: per-panel-session token budget surface.
  msg('ai:budget:state'),
  msg('ai:budget:warn'),
  msg('ai:budget:exceeded'),
  // Phase 04 plan 04-04: diagnose flow + per-action approve gate.
  msg('ai:diagnose'),
  msg('ai:diagnose:response'),
  msg('ai:approve-action'),
  msg('ai:approve-action:response'),
] as const;
export const AIMessageSchema = z.discriminatedUnion('type', AIMessages);

// ─── Domain: Settings (includes onboarding, hint, telemetry, config, whats-new, notification, state) ─
const SettingsMessages = [
  msg('settings:get'),
  msg('settings:update'),
  msg('settings:response'),
  // Error channels for settings and config-profile operations.
  msg('settings:error'),
  msg('config:error'),
  // Payload-less fun overlay broadcast via postToAllPanels (raw postMessage,
  // outside the broker envelope — see types/messages/settings.messages.ts).
  msg('easter-egg:show'),
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
  msg('error:boundary'),
] as const;
export const SettingsMessageSchema = z.discriminatedUnion('type', SettingsMessages);

// ─── Domain: Realtime (CDC) ──────────────────────────────────────────────────
const RealtimeMessages = [
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
] as const;
export const RealtimeMessageSchema = z.discriminatedUnion('type', RealtimeMessages);

// ─── Domain: Conflict (scheduler — scheduled ops & conflict routing) ─────────
const ConflictMessages = [
  msg('scheduler:list'),
  msg('scheduler:list:response'),
  msg('scheduler:upsert'),
  msg('scheduler:upsert:response'),
  msg('scheduler:delete'),
  msg('scheduler:delete:response'),
  msg('scheduler:toggle'),
  msg('scheduler:toggle:response'),
] as const;
export const ConflictMessageSchema = z.discriminatedUnion('type', ConflictMessages);

// ─── Domain: Cache ───────────────────────────────────────────────────────────
const CacheMessages = [
  msg('cache:invalidate-all'),
  msg('cache:invalidate-all:response'),
  msg('cache:get-stats'),
  msg('cache:stats-response'),
] as const;
export const CacheMessageSchema = z.discriminatedUnion('type', CacheMessages);

// ─── Domain: SmartAction + QuickSync ─────────────────────────────────────────
const SmartActionMessages = [
  msg('smart-action:analyze'),
  msg('smart-action:analyze:response'),
  msg('smart-action:error'),
  msg('quicksync:suggest-objects'),
  msg('quicksync:detect-relationships'),
  msg('quicksync:preview'),
  msg('quicksync:execute'),
  msg('quicksync:suggest-objects:response'),
  msg('quicksync:detect-relationships:response'),
  msg('quicksync:preview:response'),
  msg('quicksync:execute:response'),
  msg('quicksync:error'),
] as const;
export const SmartActionMessageSchema = z.discriminatedUnion('type', SmartActionMessages);

// ─── Domain: Frozen Reference Dataset ────────────────────────────────────────
const FrozenMessages = [
  msg('frozen:config:get'),
  msg('frozen:config:get:response'),
  msg('frozen:config:save'),
  msg('frozen:config:save:response'),
  msg('frozen:select'),
  msg('frozen:select:response'),
  msg('frozen:extract'),
  msg('frozen:extract:response'),
  msg('frozen:control:result'),
  msg('frozen:manifest:get'),
  msg('frozen:manifest:get:response'),
  msg('frozen:load'),
  msg('frozen:load:response'),
  msg('frozen:load:progress'),
  msg('frozen:verify'),
  msg('frozen:verify:result'),
  msg('frozen:status'),
  msg('frozen:status:response'),
  // Error channels for frozen config-save / select / extract / load / verify.
  msg('frozen:config:save:error'),
  msg('frozen:select:error'),
  msg('frozen:extract:error'),
  msg('frozen:load:error'),
  msg('frozen:verify:error'),
] as const;
export const FrozenMessageSchema = z.discriminatedUnion('type', FrozenMessages);

/**
 * Full bridge message surface — one flattened discriminated union over every
 * domain array (370 literals, O(1) dispatch at the boundary).
 *
 * Use `BridgeMessageSchema.safeParse(raw)` at the message boundary to validate
 * any inbound payload. Members whose shape isn't strictly known yet still pass
 * if they include the base fields + a recognised `type` literal (passthrough on
 * extra keys).
 */
export const BridgeMessageSchema = z.discriminatedUnion('type', [
  ...OrgMessages,
  ...SeedMessages,
  ...SyncMessages,
  ...MonitorMessages,
  ...CompareMessages,
  ...DataOpsMessages,
  ...AutomationMessages,
  ...ExecutionMessages,
  ...AIMessages,
  ...SettingsMessages,
  ...RealtimeMessages,
  ...ConflictMessages,
  ...CacheMessages,
  ...SmartActionMessages,
  ...FrozenMessages,
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
