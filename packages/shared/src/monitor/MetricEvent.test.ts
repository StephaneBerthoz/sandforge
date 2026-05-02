import { describe, it, expect } from 'vitest';
import {
  MetricEventSchema,
  MetricSampleSchema,
  MetricSampleEventSchema,
  MetricBatchEventSchema,
  DriftDetectedEventSchema,
  AnomalyDetectedEventSchema,
  FleetSummaryEventSchema,
  MetricEventSchemaByType,
  assertNever,
  type MetricEvent,
} from './MetricEvent.js';

const sample = (overrides: Record<string, unknown> = {}) => ({
  ts: '2026-05-02T10:00:00.000Z',
  seriesId: 'limits.api',
  orgId: 'org-1',
  value: 42,
  ...overrides,
});

describe('MetricSampleSchema', () => {
  it('accepts a minimal valid sample', () => {
    expect(MetricSampleSchema.safeParse(sample()).success).toBe(true);
  });

  it('rejects NaN/Infinity values', () => {
    expect(MetricSampleSchema.safeParse(sample({ value: NaN })).success).toBe(false);
    expect(MetricSampleSchema.safeParse(sample({ value: Infinity })).success).toBe(false);
  });

  it('rejects non-ISO timestamps', () => {
    expect(MetricSampleSchema.safeParse(sample({ ts: 'not-iso' })).success).toBe(false);
  });

  it('rejects empty seriesId / orgId', () => {
    expect(MetricSampleSchema.safeParse(sample({ seriesId: '' })).success).toBe(false);
    expect(MetricSampleSchema.safeParse(sample({ orgId: '' })).success).toBe(false);
  });

  it('rejects unknown extra fields (.strict)', () => {
    expect(MetricSampleSchema.safeParse({ ...sample(), extra: 'nope' }).success).toBe(false);
  });
});

describe('MetricEventSchema (discriminated union)', () => {
  it('parses a monitor:metric event', () => {
    const ev: MetricEvent = { type: 'monitor:metric', payload: sample() };
    expect(MetricEventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a monitor:metrics:batch event', () => {
    const ev: MetricEvent = {
      type: 'monitor:metrics:batch',
      payload: { samples: [sample(), sample({ value: 43 })] },
    };
    expect(MetricEventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a monitor:drift:detected event', () => {
    const ev: MetricEvent = {
      type: 'monitor:drift:detected',
      payload: {
        orgId: 'org-1',
        snapshotPairId: 'snap-pair-1',
        summary: 'Permission changed on Profile X',
        deltaCount: 3,
        severity: 'permission',
      },
    };
    expect(MetricEventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a monitor:anomaly:detected event', () => {
    const ev: MetricEvent = {
      type: 'monitor:anomaly:detected',
      payload: {
        orgId: 'org-1',
        seriesId: 'limits.api',
        value: 95,
        mean: 50,
        stdDev: 10,
        zScore: 4.5,
        recentContext: [sample()],
      },
    };
    expect(MetricEventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a monitor:fleet:summary event', () => {
    const ev: MetricEvent = {
      type: 'monitor:fleet:summary',
      payload: {
        orgs: [
          {
            orgId: 'org-1',
            name: 'Prod',
            healthScore: 87,
            lastUpdated: '2026-05-02T10:00:00.000Z',
            alertCount: 2,
          },
        ],
      },
    };
    expect(MetricEventSchema.safeParse(ev).success).toBe(true);
  });

  it('rejects an unknown discriminant', () => {
    expect(MetricEventSchema.safeParse({ type: 'unknown', payload: {} }).success).toBe(false);
  });

  it('rejects an empty batch (min 1)', () => {
    expect(
      MetricEventSchema.safeParse({
        type: 'monitor:metrics:batch',
        payload: { samples: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects an oversized batch (max 1000)', () => {
    const samples = Array.from({ length: 1001 }, (_, i) => sample({ value: i }));
    expect(
      MetricEventSchema.safeParse({
        type: 'monitor:metrics:batch',
        payload: { samples },
      }).success,
    ).toBe(false);
  });
});

describe('MetricEventSchemaByType lookup', () => {
  it('exposes a per-type payload schema for every union member', () => {
    expect(MetricEventSchemaByType['monitor:metric'].safeParse(sample()).success).toBe(true);
    expect(
      MetricEventSchemaByType['monitor:metrics:batch'].safeParse({ samples: [sample()] })
        .success,
    ).toBe(true);
  });

  it('rejects malformed payloads via the lookup', () => {
    expect(
      MetricEventSchemaByType['monitor:metric'].safeParse({ ...sample(), value: NaN }).success,
    ).toBe(false);
  });
});

describe('member schemas (referenced individually)', () => {
  it('all five member schemas parse their canonical example', () => {
    expect(MetricSampleEventSchema.safeParse({ type: 'monitor:metric', payload: sample() }).success).toBe(true);
    expect(
      MetricBatchEventSchema.safeParse({
        type: 'monitor:metrics:batch',
        payload: { samples: [sample()] },
      }).success,
    ).toBe(true);
    expect(
      DriftDetectedEventSchema.safeParse({
        type: 'monitor:drift:detected',
        payload: {
          orgId: 'o',
          snapshotPairId: 'p',
          summary: 's',
          deltaCount: 1,
          severity: 'info',
        },
      }).success,
    ).toBe(true);
    expect(
      AnomalyDetectedEventSchema.safeParse({
        type: 'monitor:anomaly:detected',
        payload: {
          orgId: 'o',
          seriesId: 's',
          value: 1,
          mean: 0,
          stdDev: 1,
          zScore: 1,
          recentContext: [],
        },
      }).success,
    ).toBe(true);
    expect(
      FleetSummaryEventSchema.safeParse({
        type: 'monitor:fleet:summary',
        payload: { orgs: [] },
      }).success,
    ).toBe(true);
  });
});

describe('assertNever (P-03.8 exhaustiveness helper)', () => {
  it('throws when reached at runtime', () => {
    const x = 'rogue' as never;
    expect(() => assertNever(x)).toThrow(/Unhandled MetricEvent type/);
  });
});
