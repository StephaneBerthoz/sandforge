/**
 * Regression suite for the audit-pass-2 fixes (2026-04-30).
 *
 * Each test pins one finding from `.planning/audit-forge-2026-04-30-v2.md`
 * — if a future refactor reverts the fix, this file goes red. Keeps the
 * suite focused on *behavior* rather than implementation, so cosmetic
 * refactors don't break it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  forgeConfigSchema,
  forgeGraphNodeSchema,
  forgeGraphEdgeSchema,
  forgeGraphSchema,
} from '@sandforge/shared';
import { ForgePlanGenerator } from './ForgePlanGenerator.js';
import { ForgeOrchestrator } from './ForgeOrchestrator.js';
import { SchemaCache } from '../../core/metadata/SchemaCache.js';
import type { ForgeGraph, ForgeConfig } from '@sandforge/shared';

// ─── RT-001: recordId regex validation ──────────────────────────────────

describe('Audit RT-001 — forgeConfigSchema rejects malicious recordId', () => {
  const baseConfig = {
    inputMode: 'record' as const,
    depth: 'direct' as const,
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto' as const,
  };

  it('accepts a valid 15-char Salesforce ID', () => {
    const r = forgeConfigSchema.safeParse({ ...baseConfig, recordId: '001AP00000j2CEg' });
    expect(r.success).toBe(true);
  });

  it('accepts a valid 18-char Salesforce ID', () => {
    const r = forgeConfigSchema.safeParse({ ...baseConfig, recordId: '001AP00000j2CEgYAM' });
    expect(r.success).toBe(true);
  });

  it("rejects an injection payload with a quote", () => {
    const r = forgeConfigSchema.safeParse({ ...baseConfig, recordId: "001' OR Id != null" });
    expect(r.success).toBe(false);
  });

  it('rejects a backslash-escape breakout', () => {
    const r = forgeConfigSchema.safeParse({
      ...baseConfig,
      recordId: "001\\' OR Id IN (SELECT Id FROM Account)",
    });
    expect(r.success).toBe(false);
  });

  it('rejects strings of wrong length', () => {
    expect(forgeConfigSchema.safeParse({ ...baseConfig, recordId: '001ABC' }).success).toBe(false);
    expect(forgeConfigSchema.safeParse({ ...baseConfig, recordId: 'a'.repeat(50) }).success).toBe(false);
  });
});

// ─── RT-002: objectApiName regex validation ─────────────────────────────

describe('Audit RT-002 — forgeGraphNodeSchema rejects malicious objectApiName', () => {
  const validNode = {
    objectApiName: 'Account',
    recordCount: 0,
    fieldCount: 0,
    status: 'idle' as const,
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto' as const,
  };

  it('accepts a standard SObject name', () => {
    expect(forgeGraphNodeSchema.safeParse(validNode).success).toBe(true);
  });

  it('accepts a custom SObject with __c suffix', () => {
    const r = forgeGraphNodeSchema.safeParse({ ...validNode, objectApiName: 'My_Object__c' });
    expect(r.success).toBe(true);
  });

  it('rejects names with a SOQL injection payload', () => {
    const r = forgeGraphNodeSchema.safeParse({
      ...validNode,
      objectApiName: 'Account WHERE Id != null--',
    });
    expect(r.success).toBe(false);
  });

  it('rejects names starting with a digit', () => {
    expect(forgeGraphNodeSchema.safeParse({ ...validNode, objectApiName: '1Account' }).success).toBe(false);
  });

  it('rejects names with a semicolon (DROP attempt)', () => {
    expect(forgeGraphNodeSchema.safeParse({ ...validNode, objectApiName: 'Account; DROP' }).success).toBe(false);
  });

  it('rejects edge with a malformed sourceObject', () => {
    const r = forgeGraphEdgeSchema.safeParse({
      sourceObject: 'A B', // space invalid
      targetObject: 'Account',
      relationshipName: 'r',
      type: 'lookup' as const,
    });
    expect(r.success).toBe(false);
  });
});

// ─── RT-003: graph node/edge bounds + iterative Tarjan ──────────────────

describe('Audit RT-003 — forgeGraphSchema enforces bounds, Tarjan stack-safe', () => {
  it('rejects > 2000 nodes', () => {
    const node = {
      objectApiName: 'A',
      recordCount: 0, fieldCount: 0, status: 'idle' as const, progress: 0, included: true,
      piiFields: [], anonymizeFields: [], level: 0, successCount: 0, failureCount: 0, errors: [],
      createableFieldCount: 0, estimatedSizeMB: 0, estimatedApiCalls: 0, batchStrategy: 'auto' as const,
    };
    const big = {
      nodes: Array.from({ length: 2001 }, (_, i) => ({ ...node, objectApiName: `A${i}` })),
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    expect(forgeGraphSchema.safeParse(big).success).toBe(false);
  });

  it('Tarjan SCC iterative does not stack-overflow on deep chain', () => {
    // Build a 5000-node chain: A0 → A1 → ... → A4999.
    // Recursive Tarjan would hit RangeError around ~10K frames; iterative
    // version handles arbitrarily deep chains in O(V+E).
    const N = 5000;
    const nodes = Array.from({ length: N }, (_, i) => ({
      objectApiName: `A${i}`,
      recordCount: 0, fieldCount: 0, status: 'idle' as const, progress: 0, included: true,
      piiFields: [], anonymizeFields: [], level: 0, successCount: 0, failureCount: 0, errors: [],
      createableFieldCount: 0, estimatedSizeMB: 0, estimatedApiCalls: 0, batchStrategy: 'auto' as const,
    }));
    const edges = Array.from({ length: N - 1 }, (_, i) => ({
      sourceObject: `A${i}`, targetObject: `A${i + 1}`,
      relationshipName: 'r', type: 'lookup' as const,
    }));
    const graph: ForgeGraph = {
      nodes,
      edges,
      totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0,
    };
    const planner = new ForgePlanGenerator();
    // Should not throw RangeError
    expect(() => planner.generate(graph)).not.toThrow();
  });

  it('Tarjan still detects A→B→A cycle correctly', () => {
    const graph: ForgeGraph = {
      nodes: [
        {
          objectApiName: 'A', recordCount: 0, fieldCount: 0, status: 'idle', progress: 0,
          included: true, piiFields: [], anonymizeFields: [], level: 0, successCount: 0,
          failureCount: 0, errors: [], createableFieldCount: 0, estimatedSizeMB: 0,
          estimatedApiCalls: 0, batchStrategy: 'auto',
        },
        {
          objectApiName: 'B', recordCount: 0, fieldCount: 0, status: 'idle', progress: 0,
          included: true, piiFields: [], anonymizeFields: [], level: 0, successCount: 0,
          failureCount: 0, errors: [], createableFieldCount: 0, estimatedSizeMB: 0,
          estimatedApiCalls: 0, batchStrategy: 'auto',
        },
      ],
      edges: [
        { sourceObject: 'A', targetObject: 'B', relationshipName: 'r', type: 'lookup' },
        { sourceObject: 'B', targetObject: 'A', relationshipName: 'r', type: 'lookup' },
      ],
      totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0,
    };
    const planner = new ForgePlanGenerator();
    const plan = planner.generate(graph);
    expect(plan.cycleResolutions.length).toBe(1);
    expect(plan.cycleResolutions[0].objects.sort()).toEqual(['A', 'B']);
  });
});

// ─── RT-004: cacheKeyFor includes all material params ───────────────────

describe('Audit RT-004 — discoveryCache key separates by all material params', () => {
  function makeOrchestrator(): ForgeOrchestrator {
    return new ForgeOrchestrator({
      discoveryService: { discover: async () => ({} as ForgeGraph) } as never,
      executor: { execute: async () => ({}) as never, abort: () => {}, pause: () => {}, resume: () => {} } as never,
    });
  }

  function makeConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
    return {
      inputMode: 'record',
      recordId: '001AP00000j2CEgYAM',
      depth: 'direct',
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
      ...overrides,
    };
  }

  it('different targetOrgId produces different cache keys', () => {
    const orch = makeOrchestrator();
    // Access via private — TS sees it through `as unknown` cast in test only.
    type WithKey = ForgeOrchestrator & { cacheKeyFor: (c: ForgeConfig) => string };
    const k1 = (orch as WithKey).cacheKeyFor(makeConfig({ targetOrgId: 'tgt-a' }));
    const k2 = (orch as WithKey).cacheKeyFor(makeConfig({ targetOrgId: 'tgt-b' }));
    expect(k1).not.toBe(k2);
  });

  it('different anonymizePII produces different cache keys', () => {
    const orch = makeOrchestrator();
    type WithKey = ForgeOrchestrator & { cacheKeyFor: (c: ForgeConfig) => string };
    const k1 = (orch as WithKey).cacheKeyFor(makeConfig({ anonymizePII: false }));
    const k2 = (orch as WithKey).cacheKeyFor(makeConfig({ anonymizePII: true }));
    expect(k1).not.toBe(k2);
  });

  it('different expandOrphanParents produces different cache keys', () => {
    const orch = makeOrchestrator();
    type WithKey = ForgeOrchestrator & { cacheKeyFor: (c: ForgeConfig) => string };
    const k1 = (orch as WithKey).cacheKeyFor(makeConfig({ expandOrphanParents: false }));
    const k2 = (orch as WithKey).cacheKeyFor(makeConfig({ expandOrphanParents: true }));
    expect(k1).not.toBe(k2);
  });

  it('different maxRecordsPerObject produces different cache keys', () => {
    const orch = makeOrchestrator();
    type WithKey = ForgeOrchestrator & { cacheKeyFor: (c: ForgeConfig) => string };
    const k1 = (orch as WithKey).cacheKeyFor(makeConfig({ maxRecordsPerObject: 100 }));
    const k2 = (orch as WithKey).cacheKeyFor(makeConfig({ maxRecordsPerObject: 500 }));
    expect(k1).not.toBe(k2);
  });

  it('identical configs produce the same cache key (cache hit)', () => {
    const orch = makeOrchestrator();
    type WithKey = ForgeOrchestrator & { cacheKeyFor: (c: ForgeConfig) => string };
    const c = makeConfig({ anonymizePII: true, expandOrphanParents: true, maxRecordsPerObject: 50 });
    expect((orch as WithKey).cacheKeyFor(c)).toBe((orch as WithKey).cacheKeyFor({ ...c }));
  });
});

// ─── PERF-002: SchemaCache uses O(1) heuristic, never JSON.stringify ────

describe('Audit PERF-002 — SchemaCache estimateSize is O(1)', () => {
  it('does not call JSON.stringify on describe-shaped payloads', () => {
    // Track JSON.stringify calls. If the heuristic regresses to
    // `JSON.stringify(value).length * 2`, this test will see the spy fire.
    const spy = vi.spyOn(JSON, 'stringify');
    const cache = new SchemaCache<{ fields: Array<{ name: string }>; childRelationships: unknown[] }>({
      defaultTtl: 60_000,
      maxSize: 10,
      maxSizeBytes: 100_000_000,
    });
    cache.set('Account', {
      fields: Array.from({ length: 500 }, (_, i) => ({ name: `f${i}` })),
      childRelationships: [],
    });
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBe(0);
  });

  it('returns a non-zero size estimate for a describe payload', () => {
    const cache = new SchemaCache<{ fields: Array<{ name: string }> }>({
      defaultTtl: 60_000,
      maxSize: 10,
      maxSizeBytes: 100_000_000,
    });
    cache.set('Account', { fields: Array.from({ length: 100 }, (_, i) => ({ name: `f${i}` })) });
    // 100 fields × 250 + 512 base = 25 512 bytes
    expect(cache.estimatedBytes).toBeGreaterThan(20_000);
    expect(cache.estimatedBytes).toBeLessThan(40_000);
  });

  it('evicts when estimated total exceeds maxSizeBytes', () => {
    const cache = new SchemaCache<{ fields: Array<{ name: string }> }>({
      defaultTtl: 60_000,
      maxSize: 100,
      maxSizeBytes: 50_000, // ~200 fields max
    });
    // First entry — 100 fields ≈ 25 512 bytes — fits.
    cache.set('A', { fields: Array.from({ length: 100 }, (_, i) => ({ name: `f${i}` })) });
    expect(cache.size).toBe(1);
    // Second — same size — should evict A to fit B.
    cache.set('B', { fields: Array.from({ length: 100 }, (_, i) => ({ name: `f${i}` })) });
    expect(cache.size).toBe(1);
    expect(cache.get('A')).toBeUndefined();
    expect(cache.get('B')).toBeDefined();
  });
});

