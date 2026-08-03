import { describe, expect, it } from 'vitest';
import {
  CoverageMatrixSelector,
  DEFAULT_BUDGET_MAX_RECORDS,
  VolumetryBudgetExceededError,
  type CoverageMatrixConfig,
  type DossierHealthChecker,
  type SoqlQueryFn,
  type ScopeVolumetryFn,
} from './CoverageMatrixSelector.js';

/** Fixed clock for deterministic selectedAt. */
const NOW = new Date('2026-08-03T09:00:00Z');

interface FakeOrg {
  axisValues: Record<string, Array<string | null>>;
  /** Candidates per WHERE fragment signature, in Id order. */
  candidates: Array<{ whereIncludes: string[]; ids: string[] }>;
}

function buildQuery(org: FakeOrg, captured?: string[]): SoqlQueryFn {
  return async (soql: string) => {
    captured?.push(soql);
    const axisMatch = /GROUP BY (\w+)/.exec(soql);
    if (axisMatch) {
      const field = axisMatch[1];
      const values = org.axisValues[field] ?? [];
      return values.map((v) => ({ axisValue: v }));
    }
    for (const candidate of org.candidates) {
      if (candidate.whereIncludes.every((frag) => soql.includes(frag))) {
        return candidate.ids.map((id) => ({ Id: id }));
      }
    }
    return [];
  };
}

function healthChecker(lameIds: ReadonlySet<string>): DossierHealthChecker {
  return {
    check: async (rootRecordId: string) =>
      lameIds.has(rootRecordId)
        ? { healthy: false, reason: 'lame dossier (incomplete graph)' }
        : { healthy: true },
  };
}

const baseConfig: CoverageMatrixConfig = {
  rootObject: 'Dossier__c',
  axes: [
    {
      name: 'prestation',
      label: 'Prestation',
      filterField: 'Prestation__c',
      valuesSoql:
        'SELECT Prestation__c axisValue, COUNT(Id) cnt FROM Dossier__c GROUP BY Prestation__c',
    },
    {
      name: 'logiciel',
      label: 'Logiciel de missionnement',
      filterField: 'Logiciel__c',
      valuesSoql:
        'SELECT Logiciel__c axisValue, COUNT(Id) cnt FROM Dossier__c GROUP BY Logiciel__c',
    },
  ],
  edgeCases: [
    { name: 'litige', label: 'Dossier en litige', whereFragment: 'Flag_Litige__c = true' },
  ],
};

const org: FakeOrg = {
  axisValues: { Prestation__c: ['RC', 'MRH'], Logiciel__c: ['Kairos', 'Autre'] },
  candidates: [
    { whereIncludes: ["Prestation__c = 'RC'", "Logiciel__c = 'Kairos'"], ids: ['D1'] },
    { whereIncludes: ["Prestation__c = 'RC'", "Logiciel__c = 'Autre'"], ids: ['D2', 'D3'] },
    { whereIncludes: ["Prestation__c = 'MRH'", "Logiciel__c = 'Kairos'"], ids: ['D4'] },
    { whereIncludes: ["Prestation__c = 'MRH'", "Logiciel__c = 'Autre'"], ids: ['D5'] },
    { whereIncludes: ['Flag_Litige__c = true'], ids: ['D9'] },
  ],
};

function volumetry(perRoot: number): ScopeVolumetryFn {
  return async (rootIds) => ({ Dossier__c: rootIds.length, Ligne__c: rootIds.length * perRoot });
}

describe('CoverageMatrixSelector', () => {
  it('retains exactly one root per observed combination plus one per edge case', async () => {
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(3),
      now: () => NOW,
    });
    const result = await selector.select(baseConfig);

    // 2 prestations × 2 logiciels = 4 combinations + 1 edge case.
    // Axis values are sorted (MRH < RC, Autre < Kairos), so combinations
    // enumerate in that deterministic order.
    expect(result.roots).toHaveLength(5);
    expect(result.roots.map((r) => r.rootRecordId)).toEqual(['D5', 'D4', 'D2', 'D1', 'D9']);
    const keys = result.roots.map((r) => r.combinationKey);
    expect(new Set(keys).size).toBe(5);
    expect(keys).toContain('prestation=RC|logiciel=Kairos');
    expect(keys).toContain('edge:litige');
    expect(result.uncovered).toEqual([]);
    expect(result.selectedAt).toBe(NOW.toISOString());
  });

  it('skips lame candidates and reports combinations with no healthy root', async () => {
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      // D2 is lame → D3 retained instead; D5 (only candidate) is lame → uncovered.
      checkHealth: healthChecker(new Set(['D2', 'D5'])),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });
    const result = await selector.select(baseConfig);

    const rcAutre = result.roots.find((r) => r.combinationKey === 'prestation=RC|logiciel=Autre');
    expect(rcAutre?.rootRecordId).toBe('D3');
    expect(result.roots).toHaveLength(4);
    expect(result.uncovered).toEqual([
      {
        combinationKey: 'prestation=MRH|logiciel=Autre',
        reason: 'no healthy candidate among the 3 probed',
      },
    ]);
  });

  it('probes candidates deterministically (ORDER BY Id ASC LIMIT n)', async () => {
    const captured: string[] = [];
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org, captured),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });
    await selector.select(baseConfig);
    const probes = captured.filter((q) => q.startsWith('SELECT Id FROM Dossier__c'));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe).toContain('ORDER BY Id ASC LIMIT 3');
    }
  });

  it('verifies the volumetry budget MECHANICALLY — refuses beyond it', async () => {
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(500), // 5 roots → 2505 records > 2500
      now: () => NOW,
    });
    await expect(selector.select(baseConfig)).rejects.toThrow(VolumetryBudgetExceededError);
    await expect(selector.select(baseConfig)).rejects.toThrow(/2505.*2500/);
  });

  it('defaults the budget to 2 500 records', async () => {
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(3),
      now: () => NOW,
    });
    const result = await selector.select(baseConfig);
    expect(result.volumetry.budgetMax).toBe(DEFAULT_BUDGET_MAX_RECORDS);
    expect(result.volumetry.total).toBe(5 + 15);
  });

  it('renders {{TOKEN}} placeholders in axis queries from sas tokens', async () => {
    const captured: string[] = [];
    const config: CoverageMatrixConfig = {
      ...baseConfig,
      tokens: { AS_OF: '2026-08-01T00:00:00Z' },
      axes: [
        {
          name: 'prestation',
          label: 'Prestation',
          filterField: 'Prestation__c',
          valuesSoql:
            'SELECT Prestation__c axisValue FROM Dossier__c WHERE CreatedDate <= {{AS_OF}} GROUP BY Prestation__c',
        },
      ],
      edgeCases: [],
    };
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org, captured),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });
    await selector.select(config);
    expect(captured[0]).toContain('CreatedDate <= 2026-08-01T00:00:00Z');
    expect(captured[0]).not.toContain('{{');
  });

  it('supports NULL axis values with an IS-NULL-style filter', async () => {
    const nullOrg: FakeOrg = {
      axisValues: { Prestation__c: ['RC', null] },
      candidates: [
        { whereIncludes: ["Prestation__c = 'RC'"], ids: ['D1'] },
        { whereIncludes: ['Prestation__c = NULL'], ids: ['D7'] },
      ],
    };
    const config: CoverageMatrixConfig = {
      ...baseConfig,
      axes: [baseConfig.axes[0]],
      edgeCases: [],
    };
    const selector = new CoverageMatrixSelector({
      query: buildQuery(nullOrg),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });
    const result = await selector.select(config);
    // NULL sorts first (deterministic value ordering).
    expect(result.roots.map((r) => r.combinationKey)).toEqual(['prestation=NULL', 'prestation=RC']);
  });
});
