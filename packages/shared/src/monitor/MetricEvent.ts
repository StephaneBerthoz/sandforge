import { z } from 'zod';

/**
 * Phase 03 Plan 03-01 — `MetricEvent` discriminated union + Zod schemas.
 *
 * # What this module owns
 *
 * The wire-level contract for every event flowing through `MetricBus` (the
 * extension-side metric event bus introduced by Plan 03-01) and through the
 * `monitor:metric*` envelope variants on the WebView bridge.
 *
 * Each event is shaped as `{ type: 'monitor:xxx', payload: T }` and validated
 * by a `.strict()` Zod object so that:
 *
 *   - Adding a new event type tomorrow (e.g. CDC events in Phase 05) requires
 *     adding a member to {@link MetricEventSchema} — anything that fans out
 *     from `event.type` must use {@link assertNever} for compile-time
 *     exhaustiveness (P-03.8 mitigation).
 *   - Unknown extra fields fail validation — Phase 04/05 cannot smuggle
 *     malformed payloads through the bridge.
 *
 * # Why a discriminated union (not a class hierarchy or enum)
 *
 * - Zod's `discriminatedUnion('type', [...])` gives us O(1) parse-time
 *   dispatch and zero-cost narrowing in TypeScript.
 * - The union stays **open** — Phase 04 (Anomaly), Phase 05 (CDC), Phase 06
 *   (Polish) can append their own discriminants without touching existing
 *   members. Each plan owns its own `type` literal so merges are append-only
 *   and conflict-free.
 *
 * # Cross-references
 *
 * - `packages/extension/src/modules/monitor/MetricBus.ts` consumes
 *   {@link MetricEventTypeMap} as the type parameter for `TypedEventEmitter`.
 * - `packages/shared/src/bridge/messageSchemas.ts` registers the
 *   `monitor:metric*` envelope variants that wrap these payloads.
 * - {@link assertNever} is intentionally tiny: any future `switch (event.type)`
 *   that adds a new case without a `default: assertNever(event)` will fail
 *   the TypeScript build.
 */

// ─── Sample primitive ─────────────────────────────────────────────────────────

/**
 * A single metric sample emitted by a {@link MonitorProbe} (Plan 03-03).
 *
 * `seriesId` is a logical handle (e.g. `limits.api`, `apex.errors.last5min`),
 * `orgId` scopes the sample to one Salesforce org, `value` is the scalar
 * datum. Optional `unit` (e.g. `%`, `count`, `ms`) and free-form `tags`
 * (e.g. `{ severity: 'warning' }`) ride along for downstream UI.
 */
export const MetricSampleSchema = z
  .object({
    /** ISO-8601 timestamp of when the sample was captured. */
    ts: z.string().datetime(),
    /** Logical series identifier (1–200 chars). */
    seriesId: z.string().min(1).max(200),
    /** Salesforce org identifier (1–50 chars). */
    orgId: z.string().min(1).max(50),
    /** Numeric scalar value — must be finite (no NaN/Infinity). */
    value: z.number().finite(),
    /** Optional unit label (e.g. `%`, `count`, `ms`). */
    unit: z.string().min(1).max(20).optional(),
    /** Optional free-form tags. */
    tags: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type MetricSample = z.infer<typeof MetricSampleSchema>;

// ─── Subtype event schemas ───────────────────────────────────────────────────

/**
 * `monitor:metric` — single-sample event. The most common event type;
 * coalesced into {@link MetricBatchEventSchema} when forwarded across the
 * WebView bridge (P-03.9 mitigation).
 */
export const MetricSampleEventSchema = z
  .object({
    type: z.literal('monitor:metric'),
    payload: MetricSampleSchema,
  })
  .strict();

export type MetricSampleEvent = z.infer<typeof MetricSampleEventSchema>;

/**
 * `monitor:metrics:batch` — batched samples produced by the MetricBus
 * coalescing window (default 250 ms) before forwarding to the WebView.
 */
export const MetricBatchEventSchema = z
  .object({
    type: z.literal('monitor:metrics:batch'),
    payload: z
      .object({
        samples: z.array(MetricSampleSchema).min(1).max(1000),
      })
      .strict(),
  })
  .strict();

export type MetricBatchEvent = z.infer<typeof MetricBatchEventSchema>;

/**
 * `monitor:drift:detected` — bus-level envelope for a drift detection event.
 *
 * The full delta payload (per-field, per-permission) lives in Plan 03-04.
 * This variant carries only the summary so downstream subscribers (alerts,
 * notifications) don't have to traverse the full delta tree.
 */
export const DriftDetectedEventSchema = z
  .object({
    type: z.literal('monitor:drift:detected'),
    payload: z
      .object({
        orgId: z.string().min(1).max(50),
        snapshotPairId: z.string().min(1),
        summary: z.string().min(1),
        deltaCount: z.number().int().nonnegative(),
        severity: z.enum(['info', 'breaking', 'permission']),
      })
      .strict(),
  })
  .strict();

export type DriftDetectedEvent = z.infer<typeof DriftDetectedEventSchema>;

/**
 * `monitor:anomaly:detected` — emitted by Plan 03-05 AnomalyEngine when a
 * sample crosses the rolling 3σ band. Payload includes enough context for
 * the Phase 04 AI narrator to compose a human-readable explanation.
 */
export const AnomalyDetectedEventSchema = z
  .object({
    type: z.literal('monitor:anomaly:detected'),
    payload: z
      .object({
        orgId: z.string().min(1).max(50),
        seriesId: z.string().min(1).max(200),
        value: z.number().finite(),
        mean: z.number().finite(),
        stdDev: z.number().finite().nonnegative(),
        zScore: z.number().finite(),
        /** Last 10 samples in chronological order — context for AI narration. */
        recentContext: z.array(MetricSampleSchema).min(0).max(10),
      })
      .strict(),
  })
  .strict();

export type AnomalyDetectedEvent = z.infer<typeof AnomalyDetectedEventSchema>;

/**
 * `monitor:fleet:summary` — emitted by Plan 03-07 multi-org overview.
 * Snapshot of every connected org's headline health/alert numbers.
 */
export const FleetSummaryEventSchema = z
  .object({
    type: z.literal('monitor:fleet:summary'),
    payload: z
      .object({
        orgs: z.array(
          z
            .object({
              orgId: z.string().min(1).max(50),
              name: z.string().min(1),
              healthScore: z.number().int().min(0).max(100),
              lastUpdated: z.string().datetime(),
              alertCount: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export type FleetSummaryEvent = z.infer<typeof FleetSummaryEventSchema>;

// ─── Union ───────────────────────────────────────────────────────────────────

/**
 * The full {@link MetricEvent} discriminated union. Phase 04/05/06 plans
 * extend this list by appending their own `.strict()` member schemas — never
 * by widening an existing member.
 */
export const MetricEventSchema = z.discriminatedUnion('type', [
  MetricSampleEventSchema,
  MetricBatchEventSchema,
  DriftDetectedEventSchema,
  AnomalyDetectedEventSchema,
  FleetSummaryEventSchema,
]);

/** Inferred TS type of any valid {@link MetricEvent}. */
export type MetricEvent = z.infer<typeof MetricEventSchema>;

/**
 * Mapped object type keyed by each event's `type` literal so
 * `TypedEventEmitter<MetricEventTypeMap>` can be parameterised cleanly.
 *
 * The shape is `{ 'monitor:metric': MetricSample, 'monitor:metrics:batch': { samples: MetricSample[] }, ... }`
 * — i.e. **values are payloads, not full events**, matching the existing
 * `TypedEventEmitter.on(type, listener)` contract used by `AutopilotExecutor`
 * and `ForgeOrchestrator`.
 */
export type MetricEventTypeMap = {
  'monitor:metric': MetricSampleEvent['payload'];
  'monitor:metrics:batch': MetricBatchEvent['payload'];
  'monitor:drift:detected': DriftDetectedEvent['payload'];
  'monitor:anomaly:detected': AnomalyDetectedEvent['payload'];
  'monitor:fleet:summary': FleetSummaryEvent['payload'];
};

/**
 * Lookup schema for a given `MetricEvent.type` discriminant.
 *
 * Useful when the bus needs to validate a payload before emitting:
 * `MetricEventSchemaByType['monitor:metric'].parse(samplePayload)`.
 *
 * Any new event type added to {@link MetricEventSchema} MUST also be added
 * here so the bus can validate it — failing to do so does not break the
 * type system but does silently bypass validation, which is detectable
 * by the `MetricBus.test.ts` Zod-coverage test.
 */
export const MetricEventSchemaByType = {
  'monitor:metric': MetricSampleEventSchema.shape.payload,
  'monitor:metrics:batch': MetricBatchEventSchema.shape.payload,
  'monitor:drift:detected': DriftDetectedEventSchema.shape.payload,
  'monitor:anomaly:detected': AnomalyDetectedEventSchema.shape.payload,
  'monitor:fleet:summary': FleetSummaryEventSchema.shape.payload,
} as const satisfies {
  [K in keyof MetricEventTypeMap]: z.ZodType<MetricEventTypeMap[K]>;
};

/**
 * Compile-time exhaustiveness helper (P-03.8 mitigation).
 *
 * Use as the `default:` branch of any `switch (event.type)` so that adding
 * a new {@link MetricEvent} variant without updating the switch fails the
 * TypeScript build with a clear error.
 *
 * @example
 *   switch (event.type) {
 *     case 'monitor:metric': return handleSample(event.payload);
 *     case 'monitor:metrics:batch': return handleBatch(event.payload);
 *     default: return assertNever(event);
 *   }
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled MetricEvent type: ${JSON.stringify(x)}`);
}
