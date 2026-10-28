import * as z from 'zod';

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
 *     with `.loose()` tolerated on nested objects whose exact shape isn't
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
  return z.object({ ...baseShape, type: z.literal(type), payload: z.unknown().optional() }).loose();
}

// ─── Domain: Org ─────────────────────────────────────────────────────────────
const OrgMessages = [
  msg('org:list'),
  msg('org:list:response'),
  msg('org:connect'),
  msg('org:connect:cancel'),
  // A device-flow sign-in's code, correlated to the org:connect that asked for it.
  msg('org:device-code'),
  msg('org:disconnect'),
  msg('org:select'),
  msg('org:update'),
  msg('org:open-in-browser'),
  msg('org:open-in-browser:response'),
  // Whether the CLI answers and how many orgs it holds, asked as Organizations opens.
  msg('org:cli-status'),
  msg('org:cli-status:response'),
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
  // The removal of what a Seed run created, from the run's results.
  msg('seed:removal:info'),
  msg('seed:removal:info:response'),
  msg('seed:removal:list'),
  msg('seed:removal:list:response'),
  msg('seed:remove'),
  msg('seed:remove:response'),
  msg('seed:remove:error'),
  msg('seed:remove:sweep'),
  msg('seed:remove:sweep:response'),
  msg('seed:remove:sweep:error'),
  // A record a Seed run created, opened in the org it wrote to.
  msg('seed:open-record'),
  msg('seed:open-record:response'),
  msg('seed:open-record:error'),
  // What the target runs as a seed creates its records, read before Start.
  msg('seed:automation'),
  msg('seed:automation:response'),
  msg('seed:automation:error'),
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
  // Agentforce test data: scenario packs, their seed and their agent's test file.
  msg('seed:scenario:packs'),
  msg('seed:scenario:packs:response'),
  msg('seed:scenario:prepare'),
  msg('seed:scenario:prepare:response'),
  msg('seed:scenario:execute'),
  msg('seed:scenario:agents'),
  msg('seed:scenario:agents:response'),
  msg('seed:scenario:save'),
  msg('seed:scenario:save:response'),
  msg('seed:scenario:test-file'),
  msg('seed:scenario:test-file:response'),
] as const;
export const SeedMessageSchema = z.discriminatedUnion('type', SeedMessages);

// ─── Domain: Sync ────────────────────────────────────────────────────────────
const SyncMessages = [
  msg('sync:execute'),
  msg('sync:describe-global'),
  msg('sync:describe-fields'),
  msg('sync:execute:response'),
  // A simulation reads and compares, and writes nothing; pause and resume hold
  // a running sync before its next object or batch.
  msg('sync:simulate'),
  msg('sync:simulate:response'),
  // The order a run writes its objects in, shown on Review before it runs.
  msg('sync:write-order'),
  msg('sync:write-order:response'),
  msg('sync:pause'),
  msg('sync:pause:response'),
  msg('sync:resume'),
  msg('sync:resume:response'),
  msg('sync:describe-global:response'),
  msg('sync:describe-fields:response'),
  // Error channel for config/describe/execute failures.
  msg('sync:error'),
  msg('sync:config:save'),
  msg('sync:config:load'),
  msg('sync:config:list'),
  msg('sync:config:delete'),
  msg('sync:config:reset-delta'),
  msg('sync:config:save:response'),
  msg('sync:config:load:response'),
  msg('sync:config:list:response'),
  msg('sync:config:delete:response'),
  msg('sync:config:reset-delta:response'),
  msg('sync:history:list'),
  msg('sync:history:list:response'),
  msg('sync:history:detail'),
  msg('sync:history:detail:response'),
  msg('sync:history:rerun'),
  msg('sync:history:export'),
  msg('sync:history:export:response'),
  // Error channel consumed by useSyncHistoryStore (payload.message).
  msg('sync:history:error'),
  // What a run created, read from what it kept, and its removal.
  msg('sync:removal:info'),
  msg('sync:removal:info:response'),
  // What earlier runs between two orgs left in the target, before a re-run inserts again.
  msg('sync:earlier-copies'),
  msg('sync:earlier-copies:response'),
  msg('sync:removal:list'),
  msg('sync:removal:list:response'),
  msg('sync:remove'),
  msg('sync:remove:response'),
  msg('sync:remove:error'),
  msg('sync:remove:sweep'),
  msg('sync:remove:sweep:response'),
  msg('sync:remove:sweep:error'),
  msg('sync:remove:automation'),
  msg('sync:remove:automation:response'),
  msg('sync:remove:automation:error'),
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
  // Dashboard snapshot (trends included) and the domain error channel.
  msg('monitor:data'),
  msg('monitor:error'),
  // Opens Setup > Apex Jobs for a stalled job; refusals answer on monitor:error.
  msg('monitor:open-apex-jobs'),
  msg('monitor:open-apex-jobs:response'),
  msg('monitor:live-operations'),
  msg('monitor:live-operations:response'),
  // The list as it is now, pushed as it changes: see `LiveOperationsChanged`.
  msg('monitor:live-operations:changed'),
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
  // variant, which nothing emitted, were purged with the extension-side Monitor v2 removal — no
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
  msg('compare:permissions'),
  msg('compare:snapshots'),
  msg('compare:drift'),
  msg('compare:permissions:response'),
  msg('compare:snapshots:response'),
  msg('compare:drift:response'),
  msg('compare:validate-deployment'),
  msg('compare:validate-deployment:response'),
  msg('compare:deploy'),
  msg('compare:deploy:response'),
  msg('compare:error'),
] as const;
export const CompareMessageSchema = z.discriminatedUnion('type', CompareMessages);

// ─── Domain: DataOps (includes backup, precheck, dataops, governance) ────────
const DataOpsMessages = [
  msg('backup:execute'),
  msg('backup:list'),
  msg('backup:list:result'),
  // The objects the Backup tab reads, as a masking run of the templates plans them in the org.
  msg('backup:objects'),
  msg('backup:objects:response'),
  msg('backup:export'),
  msg('backup:export:result'),
  msg('backup:delete'),
  msg('backup:delete:result'),
  msg('dataops:rollback'),
  msg('dataops:anonymize'),
  msg('dataops:backup:response'),
  msg('dataops:rollback:response'),
  msg('dataops:anonymize:response'),
  msg('dataops:quality-scan'),
  msg('dataops:quality-scan:response'),
  msg('dataops:pii-inventory'),
  msg('dataops:pii-inventory:response'),
  msg('dataops:dsr:search'),
  msg('dataops:dsr:search:response'),
  msg('dataops:dsr:export'),
  msg('dataops:dsr:export:response'),
  msg('dataops:dsr:erase'),
  msg('dataops:dsr:erase:response'),
  msg('dataops:dsr:log'),
  msg('dataops:dsr:log:response'),
  msg('dataops:cleanup:scan'),
  msg('dataops:cleanup:scan:response'),
  msg('dataops:cleanup:export'),
  msg('dataops:cleanup:export:response'),
  msg('dataops:cleanup:delete'),
  msg('dataops:cleanup:delete:response'),
  // Error channel for backup/rollback/anonymize/quality-scan failures, and for
  // the inventory, subject-request and cleanup requests that cannot start.
  msg('dataops:error'),
  msg('dataops:anonymization-templates'),
  msg('dataops:anonymization-templates:response'),
  msg('dataops:anonymization-template:save'),
  msg('dataops:anonymization-template:save:response'),
  msg('dataops:anonymization-template:delete'),
  msg('dataops:anonymization-template:delete:response'),
  msg('dataops:anonymize:coverage'),
  msg('dataops:anonymize:coverage:response'),
  msg('dataops:anonymize:preview'),
  msg('dataops:anonymize:preview:response'),
  msg('precheck:pii-scan'),
  msg('precheck:pii-scan:response'),
  msg('governance:policies:list'),
  // The result channel for governance:policies:list is
  // `governance:policies:result`, not `:response` (same convention as
  // monitor:alerts:result — both handler and webview were built on it).
  msg('governance:policies:result'),
  msg('governance:policy:save'),
  msg('governance:policy:delete'),
  msg('governance:evaluate'),
  msg('governance:templates'),
  msg('governance:policy:save:response'),
  msg('governance:policy:delete:response'),
  msg('governance:evaluate:response'),
  msg('governance:templates:response'),
  // Error channel for governance operations.
  msg('governance:error'),
] as const;
export const DataOpsMessageSchema = z.discriminatedUnion('type', DataOpsMessages);

// ─── Domain: Automation (pipeline + marketplace + migration + plugins) ───────
const AutomationMessages = [
  msg('pipeline:execute'),
  msg('pipeline:run:response'),
  // Each step of a running pipeline as it starts and ends (AutomationHandler).
  msg('pipeline:step'),
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
  // The page's answer to an Approval step that waits (AutomationHandler).
  msg('pipeline:approval'),
  // The saved Sync configurations a Sync step can run, with Production Guard's verdict.
  msg('pipeline:sync-configs'),
  msg('pipeline:sync-configs:response'),
  msg('marketplace:list'),
  msg('marketplace:list:response'),
  msg('marketplace:install'),
  msg('marketplace:install:response'),
  msg('migration:import'),
  msg('migration:import:response'),
  msg('migration:import-sfdmu'),
  msg('migration:import-sfdmu:response'),
  // The migration on screen saved as a Sync configuration.
  msg('migration:save-sync-config'),
  msg('migration:save-sync-config:response'),
  // Error channel for migration import failures.
  msg('migration:error'),
  // The object picker's list, and the counts of the objects picked.
  msg('autopilot:list-objects'),
  msg('autopilot:objects-listed'),
  msg('autopilot:count-objects'),
  msg('autopilot:objects-counted'),
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
  // Removes from its target org the records a past run created.
  msg('forge:undo'),
  // Takes up a run that stopped part way where it stopped, from its journal.
  msg('forge:resume-run'),
  // Opens in the browser a record a past run created, in the org it wrote to.
  msg('forge:open-record'),
  // Verifies what a past run created, once the target has settled.
  msg('forge:verify:request'),
  // Saves the Id map of a past run whose ids are in its journal.
  msg('forge:export-ids:request'),
  msg('forge:plan:request'),
  msg('forge:compliance:request'),
  msg('forge:metadata-diff:request'),
  // Rehearses a run: its rows created in the target, every write rolled back.
  msg('forge:rehearse:request'),
  // Reads what the target org runs on the objects a run writes.
  msg('forge:automation:request'),
  // Reads what the target org runs on the objects a past run's removal deletes.
  msg('forge:undo-automation:request'),
  msg('forge:undo-sweep:request'),
  // Reads from the target org's metadata what will refuse or surprise a run.
  msg('forge:gaps:request'),
  // An org's active users, for Review's owner mapping.
  msg('forge:users:request'),
  // Forge responses / progress events / error channels (Extension -> WebView).
  msg('forge:preview:response'),
  msg('forge:preview:error'),
  msg('forge:discover:response'),
  msg('forge:discover:progress'),
  msg('forge:discover:error'),
  // A stop that named nothing while several Forge operations were under way.
  msg('forge:abort:error'),
  msg('forge:execute:response'),
  msg('forge:progress'),
  msg('forge:execute:error'),
  msg('forge:templates:list:response'),
  msg('forge:templates:save:response'),
  msg('forge:templates:save:error'),
  msg('forge:templates:delete:response'),
  msg('forge:templates:delete:error'),
  msg('forge:history:list:response'),
  msg('forge:undo:response'),
  msg('forge:undo:error'),
  msg('forge:open-record:response'),
  msg('forge:open-record:error'),
  msg('forge:verify:response'),
  msg('forge:verify:error'),
  msg('forge:export-ids:response'),
  msg('forge:export-ids:error'),
  msg('forge:plan:response'),
  msg('forge:plan:error'),
  msg('forge:compliance:response'),
  msg('forge:compliance:error'),
  msg('forge:metadata-diff:response'),
  msg('forge:metadata-diff:error'),
  msg('forge:rehearse:progress'),
  msg('forge:rehearse:response'),
  msg('forge:rehearse:error'),
  msg('forge:automation:response'),
  msg('forge:automation:error'),
  msg('forge:undo-automation:response'),
  msg('forge:undo-automation:error'),
  msg('forge:undo-sweep:response'),
  msg('forge:undo-sweep:error'),
  msg('forge:gaps:response'),
  msg('forge:gaps:error'),
  msg('forge:users:response'),
  msg('forge:users:error'),
] as const;
export const AutomationMessageSchema = z.discriminatedUnion('type', AutomationMessages);

// ─── Domain: Execution + Operation lifecycle + grappe ────────────────────────
const ExecutionMessages = [
  msg('operation:started'),
  msg('operation:progress'),
  msg('operation:completed'),
  msg('operation:failed'),
  msg('execution:retry-status'),
  msg('execution:abort'),
  msg('execution:abort:response'),
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
  msg('ai:chat:cancel'),
  msg('ai:conversation:create'),
  msg('ai:conversation:created'),
  msg('ai:conversation:load'),
  msg('ai:conversation:loaded'),
  msg('ai:conversation:delete'),
  msg('ai:conversation:deleted'),
  msg('ai:conversation:delete-all'),
  msg('ai:conversation:deleted-all'),
  msg('ai:conversation:list'),
  msg('ai:conversation:list:response'),
  msg('ai:status'),
  msg('ai:status:response'),
  msg('ai:save-key'),
  msg('ai:save-key:response'),
  msg('ai:settings'),
  msg('ai:settings:response'),
  msg('ai:remove-key'),
  msg('ai:remove-key:response'),
  msg('ai:error'),
  // Stops the model call of a Forge plan, pipeline or scenario draft request.
  msg('ai:tool:cancel'),
  msg('ai:forge-plan'),
  msg('ai:forge-plan:response'),
  msg('ai:anomaly-scan'),
  msg('ai:anomaly-scan:response'),
  msg('ai:generate-pipeline'),
  msg('ai:generate-pipeline:response'),
  msg('ai:scenario-draft'),
  msg('ai:scenario-draft:response'),
  msg('ai:schema-advice'),
  msg('ai:schema-advice:response'),
  // Provider status banner (breaker open / half-open / closed).
  msg('ai:provider:status'),
  // Token budget gauge: one counter for the window, shared by every AI feature.
  msg('ai:budget:state'),
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
  msg('onboarding:show'),
  msg('telemetry:status'),
  msg('telemetry:status:response'),
  msg('telemetry:toggle'),
  msg('telemetry:toggle:response'),
  msg('whats-new:show'),
  msg('notification'),
  msg('state:sync'),
  // Lazy locale loading (webview CSP forbids fetch/dynamic import — the
  // packaged locale JSONs cross the bridge on demand).
  msg('i18n:locale'),
  msg('i18n:locale:response'),
  msg('config:export'),
  msg('config:export:response'),
  msg('config:import'),
  msg('config:import:response'),
  msg('config:categories'),
  msg('config:categories:response'),
  msg('config:validate'),
  msg('config:validate:response'),
  // Bridge control messages (emitted by the MessageBroker itself)
  msg('reports:list'),
  msg('reports:list:response'),
  msg('reports:audit'),
  msg('reports:audit:response'),
  msg('reports:lineage'),
  msg('reports:lineage:response'),
  // A malformed audit or lineage request (INVALID_PAYLOAD).
  msg('reports:error'),
  msg('file:save'),
  msg('file:save:response'),
  msg('bridge:error'),
  msg('bridge:protocol-mismatch'),
  msg('bridge:reload-banner'),
  msg('panel:visibility'),
  // What a panel's page shows, so a panel rebuilt when hidden is released only at rest.
  msg('panel:route'),
  // A page part of which could not be loaded asks for its shell again.
  msg('panel:reload'),
  // What the page a command opened should start (the launcher's first card).
  msg('navigation:intent'),
  msg('workbench:reload'),
  msg('workbench:open-setting'),
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
  msg('realtime:objects'),
  msg('realtime:objects:response'),
  msg('realtime:error'),
  msg('realtime:resolve-conflict'),
  msg('realtime:started'),
  msg('realtime:stopped'),
  msg('realtime:event'),
  msg('realtime:events-batch'),
  msg('realtime:conflict'),
  msg('realtime:conflict-resolved'),
] as const;
export const RealtimeMessageSchema = z.discriminatedUnion('type', RealtimeMessages);

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
  msg('frozen:select:progress'),
  msg('frozen:extract'),
  msg('frozen:extract:response'),
  msg('frozen:control:result'),
  msg('frozen:manifest:get'),
  msg('frozen:manifest:get:response'),
  msg('frozen:load'),
  msg('frozen:load:response'),
  msg('frozen:load:progress'),
  msg('frozen:load:preview'),
  msg('frozen:load:preview:response'),
  msg('frozen:verify'),
  msg('frozen:verify:result'),
  msg('frozen:remove'),
  msg('frozen:remove:response'),
  msg('frozen:remove:sweep'),
  msg('frozen:remove:sweep:response'),
  msg('frozen:remove:preview'),
  msg('frozen:remove:preview:response'),
  msg('frozen:status'),
  msg('frozen:status:response'),
  msg('frozen:rules:clear'),
  msg('frozen:rules:clear:response'),
  // Error channels for frozen config-save / select / extract / load / verify.
  msg('frozen:config:save:error'),
  msg('frozen:select:error'),
  msg('frozen:extract:error'),
  msg('frozen:load:error'),
  msg('frozen:load:preview:error'),
  msg('frozen:verify:error'),
  msg('frozen:remove:error'),
  msg('frozen:remove:sweep:error'),
  msg('frozen:remove:preview:error'),
  msg('frozen:rules:clear:error'),
] as const;
export const FrozenMessageSchema = z.discriminatedUnion('type', FrozenMessages);

// ─── Domain: Checkpoint & Rewind ─────────────────────────────────────────────
const CheckpointMessages = [
  msg('checkpoint:list'),
  msg('checkpoint:list:response'),
  msg('checkpoint:scope'),
  msg('checkpoint:scope:response'),
  msg('checkpoint:take'),
  msg('checkpoint:take:response'),
  // What a rewind would do, read only; the rewind acts on what it confirmed.
  msg('checkpoint:preview'),
  msg('checkpoint:preview:response'),
  msg('checkpoint:rewind'),
  msg('checkpoint:rewind:response'),
  msg('checkpoint:undo'),
  msg('checkpoint:undo:response'),
  msg('checkpoint:delete'),
  msg('checkpoint:delete:response'),
  msg('checkpoint:keep'),
  msg('checkpoint:keep:response'),
  msg('checkpoint:rename'),
  msg('checkpoint:rename:response'),
  msg('checkpoint:ignore-fields'),
  msg('checkpoint:ignore-fields:response'),
  // The rewinds the ledger keeps, read from this machine alone: the histories' marks.
  msg('checkpoint:rewinds'),
  msg('checkpoint:rewinds:response'),
  // Error channel for every checkpoint request: refusals, malformed payloads, failures.
  msg('checkpoint:error'),
] as const;
export const CheckpointMessageSchema = z.discriminatedUnion('type', CheckpointMessages);

/**
 * Full bridge message surface — one flattened discriminated union over every
 * domain array (O(1) dispatch at the boundary).
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
  ...SmartActionMessages,
  ...FrozenMessages,
  ...CheckpointMessages,
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
