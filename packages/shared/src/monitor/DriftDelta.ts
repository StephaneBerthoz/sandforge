import { z } from 'zod';

/**
 * Phase 03 Plan 03-04 — Drift v2 delta types + Zod schemas.
 *
 * # What this module owns
 *
 * The wire-level contract for drift deltas emitted by Plan 03-04's extended
 * `DriftDetector` (`detectFieldDrift`, `detectPermissionDrift`, `scanAndEmit`).
 * The `DriftEventPayload` is the FULL detail payload used by the bridge
 * `monitor:drift:detected:detail` request-response, while the bus-level
 * envelope in `MetricEvent.ts` (Plan 03-01) carries a slimmed
 * `summary + deltaCount + severity` shape for high-priority subscribers.
 *
 * # Why three sibling delta types instead of one giant union member shape
 *
 * - Field-level drift (`FieldDelta`) is the most common — type/length/picklist
 *   changes per `(objectApiName, fieldApiName)`.
 * - Permission-level drift (`PermissionDelta`) carries `(profileOrPermSetName,
 *   field|object, permission)` keys that don't make sense for field schemas.
 * - Object-level drift (`ObjectDelta`) covers wholesale add/remove/modify of
 *   custom objects.
 *
 * Each shape is `.strict()` so unknown fields fail Zod parse — guards against
 * Phase 04 / 05 senders smuggling malformed payloads through the bridge.
 *
 * # Hard cap on `deltas`
 *
 * `DriftEventPayloadSchema.deltas` is capped at 500 entries. A single
 * scan over a snapshot pair could in theory produce thousands of deltas
 * (think: a brand-new managed package install creating 200 fields × 30
 * profile permissions = 6000 entries). 500 is the bridge-flood ceiling per
 * P-03.2; downstream subscribers can request paginated detail via the
 * forthcoming `monitor:drift:detected:detail` endpoint when needed.
 */

// ─── FieldDelta ──────────────────────────────────────────────────────────────

/**
 * A single field-level drift entry — a CustomField that was added, removed,
 * or had its type / length / picklist / required flag change between two
 * snapshots.
 *
 * `before` and `after` are deliberately `unknown` so callers (UI tables,
 * AI narrators) can render arbitrary describe shapes without a circular
 * dep on Salesforce describe types.
 */
export const FieldDeltaSchema = z
  .object({
    objectApiName: z.string().min(1).max(120),
    fieldApiName: z.string().min(1).max(120),
    changeKind: z.enum([
      'added',
      'removed',
      'type-changed',
      'length-changed',
      'picklist-changed',
      'required-changed',
    ]),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    detectedAt: z.string().datetime(),
  })
  .strict();

export type FieldDelta = z.infer<typeof FieldDeltaSchema>;

// ─── PermissionDelta ─────────────────────────────────────────────────────────

/**
 * A single permission-level drift entry — a Profile or PermissionSet whose
 * field-level OR object-level permission flag flipped between two snapshots.
 *
 * Either `objectApiName` (object-level) OR `fieldApiName` (field-level) is
 * set (mutually exclusive in practice; the schema accepts both as optional
 * to avoid an awkward refinement).
 *
 * `permission` is the specific flag that changed — `read` / `edit` for fields,
 * `create` / `delete` / `view-all` / `modify-all` for objects.
 */
export const PermissionDeltaSchema = z
  .object({
    profileOrPermSetName: z.string().min(1).max(120),
    objectApiName: z.string().min(1).max(120).optional(),
    fieldApiName: z.string().min(1).max(120).optional(),
    changeKind: z.enum(['granted', 'revoked', 'modified']),
    permission: z.enum(['read', 'edit', 'create', 'delete', 'view-all', 'modify-all']),
    before: z.boolean().optional(),
    after: z.boolean().optional(),
    detectedAt: z.string().datetime(),
  })
  .strict();

export type PermissionDelta = z.infer<typeof PermissionDeltaSchema>;

// ─── ObjectDelta ─────────────────────────────────────────────────────────────

/**
 * A single object-level drift entry — a CustomObject that was added, removed,
 * or modified between two snapshots. Used for high-level summaries; per-field
 * detail rides in adjacent `FieldDelta` entries.
 */
export const ObjectDeltaSchema = z
  .object({
    objectApiName: z.string().min(1).max(120),
    changeKind: z.enum(['added', 'removed', 'modified']),
    detectedAt: z.string().datetime(),
  })
  .strict();

export type ObjectDelta = z.infer<typeof ObjectDeltaSchema>;

// ─── DriftDelta union ────────────────────────────────────────────────────────

/**
 * The full drift-delta union used inside `DriftEventPayload.deltas`.
 *
 * NOTE: this is a plain `z.union` (not a discriminated union) because the
 * three shapes share no common discriminant key — `FieldDelta` and
 * `ObjectDelta` both use `objectApiName + changeKind`, while
 * `PermissionDelta` swaps in `profileOrPermSetName`. Zod's plain union does
 * the right thing at parse time (tries each member in order, returns the
 * first that succeeds).
 */
export const DriftDeltaSchema = z.union([
  FieldDeltaSchema,
  PermissionDeltaSchema,
  ObjectDeltaSchema,
]);

export type DriftDelta = z.infer<typeof DriftDeltaSchema>;

// ─── DriftEventPayload ───────────────────────────────────────────────────────

/**
 * The FULL drift event payload carried by the `monitor:drift:detected:detail`
 * bridge request-response. `MetricBus` emits a slimmed envelope (per Plan
 * 03-01 `DriftDetectedEventSchema`) with just `summary + deltaCount +
 * severity`; UI surfaces that need the full delta list (the timeline feed
 * in DriftFeed.tsx) request it on demand.
 *
 * `deltas` is capped at 500 entries — bridge-flood ceiling per P-03.2.
 */
export const DriftEventPayloadSchema = z
  .object({
    orgId: z.string().min(1).max(50),
    snapshotPairId: z.string().min(1).max(200),
    summary: z.string().min(1),
    deltaCount: z.number().int().nonnegative(),
    severity: z.enum(['info', 'breaking', 'permission']),
    deltas: z.array(DriftDeltaSchema).max(500),
  })
  .strict();

export type DriftEventPayload = z.infer<typeof DriftEventPayloadSchema>;
