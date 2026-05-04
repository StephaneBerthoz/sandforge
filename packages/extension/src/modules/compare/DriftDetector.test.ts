import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { DriftDetector } from './DriftDetector';
import type {
  FetchComponentNamesFn,
  ObjectDescribeLike,
  PermissionContainerLike,
  SnapshotPayload,
} from './DriftDetector';
import type { OrgSnapshot, MetadataComponentType } from '@sandforge/shared';
import { MetricBus } from '../monitor/MetricBus';
import { FIELD_ALLOWLIST, canonicalizeField } from './drift-canonical';
import { objectDescribeArb } from '../../test/arbitraries';

function createSnapshot(
  id: string,
  orgId: string,
  types: MetadataComponentType[],
  componentCount: number,
): OrgSnapshot {
  return {
    id,
    orgId,
    name: `Snapshot ${id}`,
    componentTypes: types,
    componentCount,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('DriftDetector', () => {
  let detector: DriftDetector;
  let fetchComponentNames: FetchComponentNamesFn;

  beforeEach(() => {
    fetchComponentNames = vi.fn<FetchComponentNamesFn>().mockReturnValue([]);
    detector = new DriftDetector(fetchComponentNames);
  });

  describe('detect', () => {
    it('should return zero drift when baseline and current are identical', () => {
      vi.mocked(fetchComponentNames).mockReturnValue(['ClassA', 'ClassB']);

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 2);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 2);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(0);
      expect(result.driftScore).toBe(0);
    });

    it('should detect added components in current snapshot', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['ClassA'];
        }
        return ['ClassA', 'ClassB'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 2);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(1);
      expect(result.driftedComponents[0].fullName).toBe('ClassB');
      expect(result.driftedComponents[0].changeType).toBe('added');
    });

    it('should detect removed components from baseline', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['ClassA', 'ClassB'];
        }
        return ['ClassA'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 2);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(1);
      expect(result.driftedComponents[0].fullName).toBe('ClassB');
      expect(result.driftedComponents[0].changeType).toBe('removed');
    });

    it('should calculate drift score as percentage of baseline', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['A', 'B', 'C', 'D', 'E'];
        }
        return ['A', 'B', 'C', 'D', 'E', 'F'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 5);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 6);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftScore).toBe(20);
    });

    it('should cap drift score at 100', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return ['A'];
        }
        return ['B', 'C', 'D', 'E'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 4);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftScore).toBeLessThanOrEqual(100);
    });

    it('should handle multiple component types', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId, type) => {
        if (snapshotId === 'snap-1') {
          if (type === 'ApexClass') return ['ClassA'];
          if (type === 'Flow') return ['FlowA'];
          return [];
        }
        if (type === 'ApexClass') return ['ClassA', 'ClassB'];
        if (type === 'Flow') return [];
        return [];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass', 'Flow'], 2);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass', 'Flow'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(2);
      const changes = result.driftedComponents.map((c) => `${c.fullName}:${c.changeType}`);
      expect(changes).toContain('ClassB:added');
      expect(changes).toContain('FlowA:removed');
    });

    it('should include the orgId in the result', () => {
      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 0);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 0);

      const result = detector.detect('org-1', baseline, current);

      expect(result.orgId).toBe('org-1');
    });

    it('should set detectedAt to a valid ISO date', () => {
      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 0);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 0);

      const result = detector.detect('org-1', baseline, current);

      expect(result.detectedAt).toBeDefined();
      expect(new Date(result.detectedAt).toISOString()).toBe(result.detectedAt);
    });

    it('should set detectedAt on each drifted component', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId) => {
        if (snapshotId === 'snap-1') {
          return [];
        }
        return ['NewClass'];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents[0].detectedAt).toBe(result.detectedAt);
    });

    it('should handle component types only in current snapshot', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId, type) => {
        if (snapshotId === 'snap-1') return [];
        if (type === 'Flow') return ['NewFlow'];
        return [];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass', 'Flow'], 2);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents).toHaveLength(1);
      expect(result.driftedComponents[0].componentType).toBe('Flow');
      expect(result.driftedComponents[0].changeType).toBe('added');
    });

    it('should handle baseline componentCount of zero without division error', () => {
      vi.mocked(fetchComponentNames).mockReturnValue([]);

      const baseline = createSnapshot('snap-1', 'org-1', ['ApexClass'], 0);
      const current = createSnapshot('snap-2', 'org-1', ['ApexClass'], 0);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftScore).toBe(0);
    });

    it('should set the correct componentType on drifted components', () => {
      vi.mocked(fetchComponentNames).mockImplementation((snapshotId, type) => {
        if (snapshotId === 'snap-1') return [];
        if (type === 'Layout') return ['AccountLayout'];
        return [];
      });

      const baseline = createSnapshot('snap-1', 'org-1', ['Layout'], 1);
      const current = createSnapshot('snap-2', 'org-1', ['Layout'], 1);

      const result = detector.detect('org-1', baseline, current);

      expect(result.driftedComponents[0].componentType).toBe('Layout');
    });
  });

  // ─── Plan 03-04 — Drift v2 unit tests ─────────────────────────────────────

  describe('detectFieldDrift (Plan 03-04)', () => {
    it('returns an empty array when prev === curr (identity)', () => {
      const obj: ObjectDescribeLike = {
        name: 'Account',
        fields: [
          { name: 'Email__c', type: 'Email', length: 80 },
          { name: 'Phone__c', type: 'Phone', length: 40 },
        ],
      };
      expect(detector.detectFieldDrift(obj, obj)).toEqual([]);
    });

    it('detects an added field', () => {
      const prev: ObjectDescribeLike = {
        name: 'Account',
        fields: [{ name: 'Phone__c', type: 'Phone', length: 40 }],
      };
      const curr: ObjectDescribeLike = {
        name: 'Account',
        fields: [
          { name: 'Phone__c', type: 'Phone', length: 40 },
          { name: 'Email__c', type: 'Email', length: 80 },
        ],
      };
      const out = detector.detectFieldDrift(prev, curr);
      expect(out).toHaveLength(1);
      expect(out[0].fieldApiName).toBe('Email__c');
      expect(out[0].changeKind).toBe('added');
      expect(out[0].objectApiName).toBe('Account');
    });

    it('detects a removed field', () => {
      const prev: ObjectDescribeLike = {
        name: 'Account',
        fields: [
          { name: 'Phone__c', type: 'Phone', length: 40 },
          { name: 'Email__c', type: 'Email', length: 80 },
        ],
      };
      const curr: ObjectDescribeLike = {
        name: 'Account',
        fields: [{ name: 'Email__c', type: 'Email', length: 80 }],
      };
      const out = detector.detectFieldDrift(prev, curr);
      expect(out).toHaveLength(1);
      expect(out[0].fieldApiName).toBe('Phone__c');
      expect(out[0].changeKind).toBe('removed');
    });

    it('detects a type change as `type-changed`', () => {
      const prev: ObjectDescribeLike = {
        name: 'Account',
        fields: [{ name: 'Email__c', type: 'Email', length: 80 }],
      };
      const curr: ObjectDescribeLike = {
        name: 'Account',
        fields: [{ name: 'Email__c', type: 'Text', length: 80 }],
      };
      const out = detector.detectFieldDrift(prev, curr);
      expect(out).toHaveLength(1);
      expect(out[0].fieldApiName).toBe('Email__c');
      expect(out[0].changeKind).toBe('type-changed');
    });

    it('ignores noise fields like `lastModifiedDate` (P-03.2)', () => {
      const prev: ObjectDescribeLike = {
        name: 'Account',
        fields: [
          {
            name: 'Email__c',
            type: 'Email',
            length: 80,
            lastModifiedDate: '2026-05-01T10:00:00Z',
          },
        ],
      };
      const curr: ObjectDescribeLike = {
        name: 'Account',
        fields: [
          {
            name: 'Email__c',
            type: 'Email',
            length: 80,
            lastModifiedDate: '2026-05-02T11:00:00Z',
          },
        ],
      };
      const out = detector.detectFieldDrift(prev, curr);
      expect(out).toEqual([]);
    });
  });

  describe('detectPermissionDrift (Plan 03-04)', () => {
    it('detects a granted read', () => {
      const prev: PermissionContainerLike = {
        name: 'CustomProfile',
        fieldPermissions: [{ field: 'Account.Email__c', read: false, edit: false }],
      };
      const curr: PermissionContainerLike = {
        name: 'CustomProfile',
        fieldPermissions: [{ field: 'Account.Email__c', read: true, edit: false }],
      };
      const out = detector.detectPermissionDrift(prev, curr);
      const reads = out.filter((d) => d.permission === 'read');
      expect(reads).toHaveLength(1);
      expect(reads[0].changeKind).toBe('granted');
      expect(reads[0].fieldApiName).toBe('Account.Email__c');
    });

    it('detects a revoked read', () => {
      const prev: PermissionContainerLike = {
        name: 'CustomProfile',
        fieldPermissions: [{ field: 'Account.Email__c', read: true }],
      };
      const curr: PermissionContainerLike = {
        name: 'CustomProfile',
        fieldPermissions: [{ field: 'Account.Email__c', read: false }],
      };
      const out = detector.detectPermissionDrift(prev, curr);
      const reads = out.filter((d) => d.permission === 'read');
      expect(reads).toHaveLength(1);
      expect(reads[0].changeKind).toBe('revoked');
      expect(reads[0].fieldApiName).toBe('Account.Email__c');
    });

    it('detects an object-level view-all flip', () => {
      const prev: PermissionContainerLike = {
        name: 'CustomProfile',
        objectPermissions: [{ object: 'Account', viewAllRecords: false }],
      };
      const curr: PermissionContainerLike = {
        name: 'CustomProfile',
        objectPermissions: [{ object: 'Account', viewAllRecords: true }],
      };
      const out = detector.detectPermissionDrift(prev, curr);
      const va = out.filter((d) => d.permission === 'view-all');
      expect(va).toHaveLength(1);
      expect(va[0].changeKind).toBe('granted');
      expect(va[0].objectApiName).toBe('Account');
    });
  });

  describe('scanAndEmit (Plan 03-04)', () => {
    let bus: MetricBus;
    let received: Array<{ type: string; payload: unknown }>;

    beforeEach(() => {
      bus = new MetricBus();
      received = [];
      bus.subscribe('monitor:drift:detected', (p) => received.push({ type: 'drift', payload: p }));
    });

    it('debounces emits per (orgId, snapshotPairId) within 60s (P-03.2)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-02T10:00:00Z'));

      const prev: SnapshotPayload = {
        permissionContainers: [
          {
            name: 'CustomProfile',
            fieldPermissions: [{ field: 'Account.Email__c', read: false }],
          },
        ],
      };
      const curr: SnapshotPayload = {
        permissionContainers: [
          {
            name: 'CustomProfile',
            fieldPermissions: [{ field: 'Account.Email__c', read: true }],
          },
        ],
      };

      const first = detector.scanAndEmit('org-1', 'snap-pair-1', prev, curr, bus);
      expect(first).not.toBeNull();
      expect(received).toHaveLength(1);

      // Within the debounce window — second call returns null + does NOT emit.
      vi.advanceTimersByTime(30_000);
      const second = detector.scanAndEmit('org-1', 'snap-pair-1', prev, curr, bus);
      expect(second).toBeNull();
      expect(received).toHaveLength(1);

      // After the window — emits again.
      vi.advanceTimersByTime(31_000);
      const third = detector.scanAndEmit('org-1', 'snap-pair-1', prev, curr, bus);
      expect(third).not.toBeNull();
      expect(received).toHaveLength(2);

      vi.useRealTimers();
    });

    it('suppresses < 1% field touch on a CustomObject (informational)', () => {
      // 200 fields, 1 trivial field-only addition -> 0.5% of fields touched.
      const sharedFields = Array.from({ length: 199 }, (_, i) => ({
        name: `Field${i}__c`,
        type: 'Text',
        length: 100,
      }));
      const prev: SnapshotPayload = {
        objects: [{ name: 'BigObject__c', fields: sharedFields }],
      };
      const curr: SnapshotPayload = {
        objects: [
          {
            name: 'BigObject__c',
            fields: [...sharedFields, { name: 'NewTrivial__c', type: 'Text', length: 100 }],
          },
        ],
      };

      const payload = detector.scanAndEmit('org-1', 'snap-pair-2', prev, curr, bus);
      expect(payload).toBeNull();
      expect(received).toHaveLength(0);
    });

    it('always emits permission deltas (bypass threshold)', () => {
      const prev: SnapshotPayload = {
        permissionContainers: [
          {
            name: 'CustomProfile',
            fieldPermissions: [{ field: 'Account.Email__c', read: false }],
          },
        ],
      };
      const curr: SnapshotPayload = {
        permissionContainers: [
          {
            name: 'CustomProfile',
            fieldPermissions: [{ field: 'Account.Email__c', read: true }],
          },
        ],
      };
      const payload = detector.scanAndEmit('org-1', 'snap-pair-3', prev, curr, bus);
      expect(payload).not.toBeNull();
      expect(payload?.severity).toBe('permission');
      expect(received).toHaveLength(1);
    });

    it('caps the deltas array at 500 (bridge-flood ceiling)', () => {
      // Build a profile with 600 changing field permissions.
      const prevFP = Array.from({ length: 600 }, (_, i) => ({
        field: `Account.Field${i}__c`,
        read: false,
      }));
      const currFP = prevFP.map((p) => ({ ...p, read: true }));

      const prev: SnapshotPayload = {
        permissionContainers: [{ name: 'CustomProfile', fieldPermissions: prevFP }],
      };
      const curr: SnapshotPayload = {
        permissionContainers: [{ name: 'CustomProfile', fieldPermissions: currFP }],
      };

      const payload = detector.scanAndEmit('org-1', 'snap-pair-4', prev, curr, bus);
      expect(payload).not.toBeNull();
      expect(payload?.deltas.length).toBe(500);
      expect(payload?.deltaCount).toBe(500);
    });

    it('emits severity=breaking when a field is removed', () => {
      const prev: SnapshotPayload = {
        objects: [
          {
            name: 'Account',
            fields: [
              { name: 'Email__c', type: 'Email' },
              { name: 'Phone__c', type: 'Phone' },
            ],
          },
        ],
      };
      const curr: SnapshotPayload = {
        objects: [
          {
            name: 'Account',
            fields: [{ name: 'Email__c', type: 'Email' }],
          },
        ],
      };
      const payload = detector.scanAndEmit('org-1', 'snap-pair-5', prev, curr, bus);
      expect(payload?.severity).toBe('breaking');
    });
  });

  // ─── Property tests (Plan 03-04, ≥ 3 properties × 100 runs) ──────────────

  describe('property tests (Plan 03-04)', () => {
    it('detectFieldDrift is idempotent: detect(x, x) is empty', () => {
      fc.assert(
        fc.property(objectDescribeArb, (obj) => {
          const out = detector.detectFieldDrift(obj, obj);
          expect(out).toEqual([]);
        }),
        { numRuns: 100 },
      );
    });

    it('detectFieldDrift is symmetric on (object, field) keys', () => {
      // Set of (objectApiName, fieldApiName) pairs in detectFieldDrift(a, b)
      // equals the set in detectFieldDrift(b, a).
      fc.assert(
        fc.property(objectDescribeArb, objectDescribeArb, (a, b) => {
          // Force the two describes to share an objectApiName so per-object
          // pairing is meaningful (otherwise the two outputs reference
          // different objects and the symmetric property is vacuously true).
          const aHomogenized = { ...a, name: 'Account' };
          const bHomogenized = { ...b, name: 'Account' };
          const ab = detector.detectFieldDrift(aHomogenized, bHomogenized);
          const ba = detector.detectFieldDrift(bHomogenized, aHomogenized);
          const setAB = new Set(ab.map((d) => `${d.objectApiName}::${d.fieldApiName}`));
          const setBA = new Set(ba.map((d) => `${d.objectApiName}::${d.fieldApiName}`));
          expect(setAB).toEqual(setBA);
        }),
        { numRuns: 100 },
      );
    });

    it('canonicalizeField output keys are a subset of FIELD_ALLOWLIST.CustomField', () => {
      const allow = new Set(FIELD_ALLOWLIST.CustomField);
      fc.assert(
        fc.property(
          fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ maxLength: 30 }), {
            maxKeys: 12,
          }),
          (raw) => {
            const out = canonicalizeField(raw as Record<string, unknown>);
            for (const key of Object.keys(out ?? {})) {
              expect(allow.has(key)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── Plan 03-04 vertical-slice integration test ──────────────────────────

  describe('vertical slice (Plan 03-04 demoable)', () => {
    it('Plan 03-04 vertical slice: detect -> emit -> bus subscriber receives DriftEventPayload', () => {
      // Demoable proof that Plan 03-04 ships an end-to-end vertical slice:
      // describe pair -> DriftDetector.scanAndEmit -> MetricBus subscriber
      // sees a typed envelope, with debounce honored on a re-scan.
      const bus = new MetricBus();
      const received: Array<{
        orgId: string;
        snapshotPairId: string;
        summary: string;
        deltaCount: number;
        severity: 'info' | 'breaking' | 'permission';
      }> = [];
      bus.subscribe('monitor:drift:detected', (p) => received.push(p));

      const prev: SnapshotPayload = {
        permissionContainers: [
          {
            name: 'CustomProfile',
            fieldPermissions: [
              { field: 'Account.Email__c', read: false, edit: false },
              { field: 'Account.Phone__c', read: true, edit: false },
            ],
          },
        ],
      };
      const curr: SnapshotPayload = {
        permissionContainers: [
          {
            name: 'CustomProfile',
            fieldPermissions: [
              { field: 'Account.Email__c', read: true, edit: false },
              { field: 'Account.Phone__c', read: true, edit: false },
            ],
          },
        ],
      };

      const payload = detector.scanAndEmit('org-1', 'snap-pair-vertical', prev, curr, bus);
      expect(payload).not.toBeNull();
      expect(received).toHaveLength(1);
      expect(received[0].severity).toBe('permission');
      expect(received[0].deltaCount).toBeGreaterThan(0);
      expect(payload?.deltas.length).toBeLessThanOrEqual(500);

      // Debounce: re-scan within 60 s returns null and does NOT re-emit.
      const second = detector.scanAndEmit('org-1', 'snap-pair-vertical', prev, curr, bus);
      expect(second).toBeNull();
      expect(received).toHaveLength(1);
    });
  });
});
