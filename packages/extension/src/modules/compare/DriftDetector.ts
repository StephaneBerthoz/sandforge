import diff from 'microdiff';
import type {
  DiffStatus,
  MetadataComponentType,
  OrgSnapshot,
  FieldDelta,
  PermissionDelta,
  DriftDelta,
  DriftEventPayload,
} from '@sandforge/shared';

import { canonicalizeField, canonicalizePermissionSet } from './drift-canonical.js';
import type { MetricBus } from '../monitor/MetricBus.js';

/** A component that has drifted from its baseline */
export interface DriftedComponent {
  componentType: MetadataComponentType;
  fullName: string;
  changeType: DiffStatus;
  detectedAt: string;
}

/** Result of a drift detection run */
export interface DriftResult {
  orgId: string;
  driftedComponents: DriftedComponent[];
  driftScore: number;
  detectedAt: string;
}

/** Function signature for fetching component names for a snapshot */
export type FetchComponentNamesFn = (
  snapshotId: string,
  componentType: MetadataComponentType,
) => string[];

/**
 * Minimal shape of a Salesforce CustomObject describe used by Drift v2
 * field-level diffing. Only the keys consumed by `detectFieldDrift` are
 * declared; the canonicalization step (`canonicalizeField`) drops everything
 * else before microdiff sees it.
 */
export interface ObjectDescribeLike {
  /** API name of the object (e.g. `Account`, `Custom__c`). */
  name: string;
  /**
   * Field describes. Each entry MUST carry at least a `name` so we can pair
   * across snapshots; the rest is allowlisted by `canonicalizeField`.
   */
  fields?: Array<{ name: string } & Record<string, unknown>>;
}

/**
 * Minimal shape of a PermissionSet or Profile describe used by Drift v2
 * permission-level diffing. The canonicalization step
 * (`canonicalizePermissionSet`) sorts the array entries before they are
 * compared so the wire-order does not produce spurious deltas.
 */
export interface PermissionContainerLike {
  /** API name of the Profile or PermissionSet. */
  name: string;
  fieldPermissions?: Array<
    { field: string; read?: boolean; edit?: boolean } & Record<string, unknown>
  >;
  objectPermissions?: Array<
    {
      object: string;
      read?: boolean;
      edit?: boolean;
      create?: boolean;
      delete?: boolean;
      viewAllRecords?: boolean;
      modifyAllRecords?: boolean;
    } & Record<string, unknown>
  >;
}

/**
 * Snapshot-pair payload consumed by `scanAndEmit`. Bundles the per-object
 * describes + permission containers at a point in time. Plan 03-04 keeps
 * the structure minimal — the existing `SnapshotManager` (Compare module)
 * loads richer payloads but only this projection is needed for drift.
 */
export interface SnapshotPayload {
  /** All object describes captured at this snapshot. */
  objects?: ObjectDescribeLike[];
  /** All Profile / PermissionSet describes captured at this snapshot. */
  permissionContainers?: PermissionContainerLike[];
}

/** Hard cap on `DriftEventPayload.deltas` (mirrors the shared schema cap). */
const DELTAS_HARD_CAP = 500;

/** Debounce window per (orgId, snapshotPairId) — P-03.2. */
const DEBOUNCE_WINDOW_MS = 60_000;

/**
 * Significance threshold: a CustomObject describe with fewer than 1% of its
 * fields touched produces ONLY informational drift, which we suppress (caller
 * still sees the field-by-field detail via `detectFieldDrift` directly).
 *
 * Permission deltas + breaking changes (removed, type-changed) bypass this
 * filter — they are always emitted.
 */
const INFORMATIONAL_FIELD_PCT_THRESHOLD = 0.01;

/**
 * Detects configuration drift between two org snapshots.
 *
 * v1.x — `detect()` does object-level (added/removed component fullNames).
 *   Signature preserved for backward compatibility (consumers in
 *   `CompareOrchestrator` etc. still call this).
 *
 * Plan 03-04 (v2) adds three new pure methods + one orchestration entry:
 *   - {@link detectFieldDrift} — field-level diffs from CustomObject describes.
 *   - {@link detectPermissionDrift} — read/edit flag flips on Profile / PermSet.
 *   - {@link scanAndEmit} — debounce + threshold filter + emit on `MetricBus`.
 */
export class DriftDetector {
  private readonly fetchComponentNames: FetchComponentNamesFn;

  /** Last-emit timestamp keyed by `snapshotPairId` for debouncing (P-03.2). */
  private readonly recentEmits: Map<string, number> = new Map();

  constructor(fetchComponentNames: FetchComponentNamesFn) {
    this.fetchComponentNames = fetchComponentNames;
  }

  // ─── v1.x — object-level drift (UNCHANGED signature) ──────────────────────

  /**
   * Detect drift between a baseline and current snapshot.
   * Returns a DriftResult with a list of drifted components and a score.
   */
  detect(orgId: string, baseline: OrgSnapshot, current: OrgSnapshot): DriftResult {
    const now = new Date().toISOString();
    const driftedComponents: DriftedComponent[] = [];

    const allTypes = new Set([...baseline.componentTypes, ...current.componentTypes]);

    for (const componentType of allTypes) {
      const baselineNames = new Set(this.fetchComponentNames(baseline.id, componentType));
      const currentNames = new Set(this.fetchComponentNames(current.id, componentType));

      for (const name of currentNames) {
        if (!baselineNames.has(name)) {
          driftedComponents.push({
            componentType,
            fullName: name,
            changeType: 'added',
            detectedAt: now,
          });
        }
      }

      for (const name of baselineNames) {
        if (!currentNames.has(name)) {
          driftedComponents.push({
            componentType,
            fullName: name,
            changeType: 'removed',
            detectedAt: now,
          });
        }
      }
    }

    const totalBaseline = Math.max(baseline.componentCount, 1);
    const driftScore = Math.min(100, Math.round((driftedComponents.length / totalBaseline) * 100));

    return {
      orgId,
      driftedComponents,
      driftScore,
      detectedAt: now,
    };
  }

  // ─── Plan 03-04 v2 ────────────────────────────────────────────────────────

  /**
   * Field-level drift between two object describes.
   *
   * Strategy:
   *   1. Index each describe's fields by `name`.
   *   2. Canonicalize each field via {@link canonicalizeField} so noise keys
   *      (`lastModifiedDate`, …) and unstable orderings drop out — P-03.2.
   *   3. Diff the canonical projections with `microdiff`; classify each path
   *      change into one of the `FieldDelta.changeKind` values.
   *
   * Pure: no I/O, no logger, no clock for `detectedAt` beyond `new Date()`.
   * Caller (`scanAndEmit`) owns side effects.
   */
  detectFieldDrift(prev: ObjectDescribeLike, curr: ObjectDescribeLike): FieldDelta[] {
    const objectApiName = curr.name;
    const detectedAt = new Date().toISOString();
    const out: FieldDelta[] = [];

    const prevFields = new Map<string, Record<string, unknown>>();
    for (const f of prev.fields ?? []) {
      prevFields.set(
        f.name,
        (canonicalizeField(f) as Record<string, unknown>) ?? {},
      );
    }
    const currFields = new Map<string, Record<string, unknown>>();
    for (const f of curr.fields ?? []) {
      currFields.set(
        f.name,
        (canonicalizeField(f) as Record<string, unknown>) ?? {},
      );
    }

    // Added — present in curr, missing from prev.
    for (const [name, after] of currFields) {
      if (!prevFields.has(name)) {
        out.push({
          objectApiName,
          fieldApiName: name,
          changeKind: 'added',
          after,
          detectedAt,
        });
      }
    }
    // Removed — present in prev, missing from curr.
    for (const [name, before] of prevFields) {
      if (!currFields.has(name)) {
        out.push({
          objectApiName,
          fieldApiName: name,
          changeKind: 'removed',
          before,
          detectedAt,
        });
      }
    }
    // Modified — diff the canonical projection. ONE delta per field per kind.
    for (const [name, currField] of currFields) {
      const prevField = prevFields.get(name);
      if (!prevField) continue;
      const changes = diff(prevField, currField);
      if (changes.length === 0) continue;
      // Collect distinct change kinds — avoid duplicate deltas if e.g. two
      // picklist entries change in the same field (one delta with
      // `picklist-changed` is enough).
      const kinds = new Set<FieldDelta['changeKind']>();
      for (const c of changes) {
        const top = c.path[0];
        if (top === 'type') kinds.add('type-changed');
        else if (top === 'length') kinds.add('length-changed');
        else if (top === 'picklistValues') kinds.add('picklist-changed');
        else if (top === 'required') kinds.add('required-changed');
        else kinds.add('type-changed');
      }
      for (const kind of kinds) {
        out.push({
          objectApiName,
          fieldApiName: name,
          changeKind: kind,
          before: prevField,
          after: currField,
          detectedAt,
        });
      }
    }
    return out;
  }

  /**
   * Permission-level drift between two Profile/PermissionSet describes.
   *
   * Strategy:
   *   1. Canonicalize both via {@link canonicalizePermissionSet} so the
   *      `fieldPermissions` / `objectPermissions` arrays are sorted by their
   *      stable key — P-03.2.
   *   2. Walk every entry on both sides; emit one delta per (field|object,
   *      permission) flag flip.
   *
   * Pure: same contract as {@link detectFieldDrift}.
   */
  detectPermissionDrift(
    prev: PermissionContainerLike,
    curr: PermissionContainerLike,
  ): PermissionDelta[] {
    const profileOrPermSetName = curr.name;
    const detectedAt = new Date().toISOString();
    const out: PermissionDelta[] = [];

    const cPrev =
      canonicalizePermissionSet(prev as unknown as Record<string, unknown>) ?? {};
    const cCurr =
      canonicalizePermissionSet(curr as unknown as Record<string, unknown>) ?? {};

    // ─── Field-level permissions (read, edit) ───
    const prevFP = new Map<string, { read?: boolean; edit?: boolean } & Record<string, unknown>>();
    for (const p of (cPrev.fieldPermissions ?? []) as Array<
      { field?: unknown } & Record<string, unknown>
    >) {
      if (typeof p.field === 'string') prevFP.set(p.field, p);
    }
    const currFP = new Map<string, { read?: boolean; edit?: boolean } & Record<string, unknown>>();
    for (const p of (cCurr.fieldPermissions ?? []) as Array<
      { field?: unknown } & Record<string, unknown>
    >) {
      if (typeof p.field === 'string') currFP.set(p.field, p);
    }

    const fieldKeys = new Set<string>([...prevFP.keys(), ...currFP.keys()]);
    for (const field of fieldKeys) {
      const prevPerm = prevFP.get(field);
      const currPerm = currFP.get(field);

      for (const k of ['read', 'edit'] as const) {
        const beforeVal = Boolean(prevPerm?.[k]);
        const afterVal = Boolean(currPerm?.[k]);
        if (beforeVal !== afterVal) {
          out.push({
            profileOrPermSetName,
            fieldApiName: field,
            changeKind: afterVal ? 'granted' : 'revoked',
            permission: k,
            before: beforeVal,
            after: afterVal,
            detectedAt,
          });
        }
      }
    }

    // ─── Object-level permissions (read, edit, create, delete, viewAll, modifyAll) ───
    const prevOP = new Map<string, Record<string, unknown>>();
    for (const p of (cPrev.objectPermissions ?? []) as Array<
      { object?: unknown } & Record<string, unknown>
    >) {
      if (typeof p.object === 'string') prevOP.set(p.object, p);
    }
    const currOP = new Map<string, Record<string, unknown>>();
    for (const p of (cCurr.objectPermissions ?? []) as Array<
      { object?: unknown } & Record<string, unknown>
    >) {
      if (typeof p.object === 'string') currOP.set(p.object, p);
    }

    const objectKeys = new Set<string>([...prevOP.keys(), ...currOP.keys()]);
    for (const object of objectKeys) {
      const prevPerm = prevOP.get(object);
      const currPerm = currOP.get(object);

      const objectFlagPairs: Array<[keyof PermissionDelta['permission'] | string, PermissionDelta['permission']]> = [
        ['read', 'read'],
        ['edit', 'edit'],
        ['create', 'create'],
        ['delete', 'delete'],
        ['viewAllRecords', 'view-all'],
        ['modifyAllRecords', 'modify-all'],
      ];

      for (const [rawKey, permLabel] of objectFlagPairs) {
        const beforeVal = Boolean(prevPerm?.[rawKey as string]);
        const afterVal = Boolean(currPerm?.[rawKey as string]);
        if (beforeVal !== afterVal) {
          out.push({
            profileOrPermSetName,
            objectApiName: object,
            changeKind: afterVal ? 'granted' : 'revoked',
            permission: permLabel,
            before: beforeVal,
            after: afterVal,
            detectedAt,
          });
        }
      }
    }

    return out;
  }

  /**
   * Orchestration entry — scan a snapshot pair, debounce per
   * `(orgId, snapshotPairId)`, threshold-filter informational noise, then
   * emit on the bus.
   *
   *   - **Debounce (P-03.2):** if this `snapshotPairId` was emitted in the
   *     last {@link DEBOUNCE_WINDOW_MS}, returns `null` without emitting.
   *   - **Threshold filter (P-03.2):** if every delta is informational AND
   *     touches < 1% of fields on the largest CustomObject in scope, returns
   *     `null`. Permission deltas + breaking field changes always pass.
   *   - **Bridge cap:** the emitted payload caps `deltas` at 500 entries.
   *
   * Returns the emitted payload (or `null` when suppressed).
   */
  scanAndEmit(
    orgId: string,
    snapshotPairId: string,
    prev: SnapshotPayload,
    curr: SnapshotPayload,
    bus: MetricBus,
  ): DriftEventPayload | null {
    // Debounce gate.
    const lastEmit = this.recentEmits.get(snapshotPairId);
    if (lastEmit !== undefined && Date.now() - lastEmit < DEBOUNCE_WINDOW_MS) {
      return null;
    }

    const fieldDeltas: FieldDelta[] = [];
    const permDeltas: PermissionDelta[] = [];

    // Pair objects by name across the two snapshots.
    const prevObjects = new Map<string, ObjectDescribeLike>();
    for (const o of prev.objects ?? []) prevObjects.set(o.name, o);
    const currObjects = new Map<string, ObjectDescribeLike>();
    for (const o of curr.objects ?? []) currObjects.set(o.name, o);

    for (const [name, currObj] of currObjects) {
      const prevObj = prevObjects.get(name);
      if (!prevObj) continue; // Wholesale-added object — would be an ObjectDelta (not in this scan).
      fieldDeltas.push(...this.detectFieldDrift(prevObj, currObj));
    }

    // Pair permission containers by name.
    const prevPerms = new Map<string, PermissionContainerLike>();
    for (const p of prev.permissionContainers ?? []) prevPerms.set(p.name, p);
    const currPerms = new Map<string, PermissionContainerLike>();
    for (const p of curr.permissionContainers ?? []) currPerms.set(p.name, p);

    for (const [name, currPerm] of currPerms) {
      const prevPerm = prevPerms.get(name);
      if (!prevPerm) continue; // Newly added container — out of scope here.
      permDeltas.push(...this.detectPermissionDrift(prevPerm, currPerm));
    }

    // Severity classification (drives both the bus envelope AND the
    // threshold-filter bypass).
    const hasBreaking = fieldDeltas.some(
      (d) => d.changeKind === 'removed' || d.changeKind === 'type-changed',
    );
    const severity: DriftEventPayload['severity'] =
      permDeltas.length > 0 ? 'permission' : hasBreaking ? 'breaking' : 'info';

    // Threshold filter. Permission + breaking ALWAYS pass; informational
    // field-only deltas pass only when they touch >= 1% of any CustomObject
    // in scope.
    const allDeltas: DriftDelta[] = [...fieldDeltas, ...permDeltas];
    if (allDeltas.length === 0) return null;

    const significantDeltas =
      severity === 'info'
        ? this.filterSignificant(fieldDeltas, currObjects)
        : allDeltas;

    if (significantDeltas.length === 0) return null;

    const cappedDeltas = significantDeltas.slice(0, DELTAS_HARD_CAP);

    const payload: DriftEventPayload = {
      orgId,
      snapshotPairId,
      summary: `${cappedDeltas.length} drift change(s) detected`,
      deltaCount: cappedDeltas.length,
      severity,
      deltas: cappedDeltas,
    };

    // Emit only the slim envelope shape on the bus (per Plan 03-01
    // `DriftDetectedEventSchema`).
    bus.emit('monitor:drift:detected', {
      orgId: payload.orgId,
      snapshotPairId: payload.snapshotPairId,
      summary: payload.summary,
      deltaCount: payload.deltaCount,
      severity: payload.severity,
    });

    this.recentEmits.set(snapshotPairId, Date.now());
    return payload;
  }

  /**
   * Significance filter for the informational severity tier (P-03.2).
   *
   * A field delta is significant if it touches >= 1% of the matching
   * CustomObject's total field count. Below that, the change is treated as
   * noise (a single auto-generated layout adjustment in a 200-field object,
   * say) and dropped.
   */
  private filterSignificant(
    fieldDeltas: FieldDelta[],
    currObjects: Map<string, ObjectDescribeLike>,
  ): DriftDelta[] {
    if (fieldDeltas.length === 0) return [];

    // Group deltas by object so we can compare per-object touch ratio.
    const byObject = new Map<string, FieldDelta[]>();
    for (const d of fieldDeltas) {
      const arr = byObject.get(d.objectApiName) ?? [];
      arr.push(d);
      byObject.set(d.objectApiName, arr);
    }

    const significant: DriftDelta[] = [];
    for (const [objectName, deltas] of byObject) {
      const totalFields = currObjects.get(objectName)?.fields?.length ?? 0;
      // No describe means we can't compute a ratio — keep the delta to be safe.
      if (totalFields === 0) {
        significant.push(...deltas);
        continue;
      }
      const ratio = deltas.length / totalFields;
      if (ratio >= INFORMATIONAL_FIELD_PCT_THRESHOLD) {
        significant.push(...deltas);
      }
    }
    return significant;
  }
}
