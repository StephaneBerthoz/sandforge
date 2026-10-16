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
        reason:
          'no healthy candidate among the 1 probed (limit 3) — last: lame dossier (incomplete graph)',
      },
    ]);
  });

  it('says what an empty selection found instead of measuring nothing', async () => {
    // Every candidate lame: asked to measure an empty list, the extraction
    // had no root to start from, and the whole selection died on that error.
    let measuredWith: string[] | undefined;
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: healthChecker(new Set(['D1', 'D2', 'D3', 'D4', 'D5', 'D9'])),
      measureVolumetry: async (rootIds) => {
        measuredWith = rootIds;
        return {};
      },
      now: () => NOW,
    });
    const result = await selector.select(baseConfig);

    expect(measuredWith).toBeUndefined();
    expect(result.roots).toEqual([]);
    expect(result.volumetry).toEqual({ measured: {}, total: 0, budgetMax: 2500 });
    expect(result.uncovered).toHaveLength(5);
    for (const u of result.uncovered) {
      expect(u.reason).toContain('lame dossier (incomplete graph)');
    }
  });

  it('tells an edge case with no marked record from one whose records are lame', async () => {
    const selector = new CoverageMatrixSelector({
      query: buildQuery({ ...org, candidates: org.candidates.slice(0, 4) }),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });
    const result = await selector.select(baseConfig);
    expect(result.uncovered).toEqual([
      { combinationKey: 'edge:litige', reason: 'no record matches the edge-case marker' },
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

  it('names the heaviest objects past the budget, the root aside, and suggests leaving them out', async () => {
    // Run for real, the refusal said only to narrow the axes or raise the
    // budget, and the objects to leave out had to be read off the counts.
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: healthChecker(new Set()),
      measureVolumetry: async () => ({
        Dossier__c: 5,
        ServiceTerritory: 39_540,
        OrderForm__c: 10_281,
        Offer__c: 6_840,
        Coverage__c: 2_624,
        PolicyCoverage__c: 831,
        Note__c: 12,
        Empty__c: 0,
      }),
      now: () => NOW,
    });

    const refusal = await selector.select(baseConfig).then(
      () => new Error('the selection was not refused'),
      (err: unknown) => err as Error,
    );

    expect(refusal).toBeInstanceOf(VolumetryBudgetExceededError);
    expect(refusal.message).toContain(
      'The heaviest: ServiceTerritory 39540, OrderForm__c 10281, Offer__c 6840, ' +
        'Coverage__c 2624, PolicyCoverage__c 831. Leave out those the dataset does not need ' +
        'with excludedObjects (["ServiceTerritory","OrderForm__c","Offer__c","Coverage__c",' +
        '"PolicyCoverage__c"])',
    );
    expect(refusal.message).not.toContain('Dossier__c 5');
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

describe('CoverageMatrixSelector — told and stopped', () => {
  /** A checker whose candidates hold `perRoot` lines each, and that waits for `hold` on one id. */
  function measuringChecker(hold?: { id: string; until: Promise<never> }): DossierHealthChecker {
    return {
      check: async (rootRecordId: string) => {
        if (hold && rootRecordId === hold.id) return hold.until;
        return { healthy: true, measured: { Dossier__c: 1, Ligne__c: 2 } };
      },
    };
  }

  it('tells each axis, combination and candidate as it starts, then the measure', async () => {
    const steps: unknown[] = [];
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: healthChecker(new Set(['D2'])),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });

    await selector.select(
      { ...baseConfig, edgeCases: [] },
      { onProgress: (step) => steps.push(step) },
    );

    expect(steps.slice(0, 4)).toEqual([
      { phase: 'axis', axis: 'prestation' },
      { phase: 'axis', axis: 'logiciel' },
      { phase: 'combination', combinationKey: 'prestation=MRH|logiciel=Autre', index: 1, of: 4 },
      {
        phase: 'candidate',
        combinationKey: 'prestation=MRH|logiciel=Autre',
        candidate: 1,
        candidates: 3,
      },
    ]);
    // The lame first candidate of RC|Autre, then its second.
    expect(steps).toContainEqual({
      phase: 'candidate',
      combinationKey: 'prestation=RC|logiciel=Autre',
      candidate: 2,
      candidates: 3,
    });
    expect(steps.at(-1)).toEqual({ phase: 'measure', roots: 4 });
  });

  it('keeps the combinations it decided when its time runs out, and says where it was', async () => {
    // Run for real, a selection died on its timeout with nothing kept and no
    // word on the combination it was probing.
    const controller = new AbortController();
    const measured: string[][] = [];
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: measuringChecker({ id: 'D4', until: new Promise<never>(() => {}) }),
      measureVolumetry: async (ids) => {
        measured.push(ids);
        return {};
      },
      now: () => NOW,
    });

    const running = selector.select(baseConfig, {
      onProgress: (step) => {
        if (
          step.phase === 'candidate' &&
          step.combinationKey === 'prestation=MRH|logiciel=Kairos'
        ) {
          queueMicrotask(() => controller.abort('timeout'));
        }
      },
      signal: controller.signal,
    });
    const result = await running;

    expect(result.roots.map((r) => r.combinationKey)).toEqual(['prestation=MRH|logiciel=Autre']);
    expect(result.stopped).toEqual({
      reason: 'timeout',
      during: 'combination',
      combinationKey: 'prestation=MRH|logiciel=Kairos',
      candidate: 1,
      candidates: 3,
      notProbed: ['prestation=RC|logiciel=Autre', 'prestation=RC|logiciel=Kairos', 'edge:litige'],
    });
    // Not measured together: each kept root's own measure, added up.
    expect(measured).toEqual([]);
    expect(result.volumetry).toEqual({
      measured: { Dossier__c: 1, Ligne__c: 2 },
      total: 3,
      budgetMax: DEFAULT_BUDGET_MAX_RECORDS,
      summed: true,
    });
  });

  it('says a stop it was not timed out by is a cancel', async () => {
    const controller = new AbortController();
    controller.abort();
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: measuringChecker(),
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });

    const result = await selector.select(baseConfig, { signal: controller.signal });

    expect(result.roots).toEqual([]);
    expect(result.stopped).toMatchObject({ reason: 'cancelled', during: 'axes' });
  });

  it('still refuses a stopped selection whose kept roots are past the budget', async () => {
    const controller = new AbortController();
    const selector = new CoverageMatrixSelector({
      query: buildQuery(org),
      checkHealth: {
        check: async (id) =>
          id === 'D4'
            ? new Promise<never>(() => {})
            : { healthy: true, measured: { Dossier__c: 1, Ligne__c: 4_000 } },
      },
      measureVolumetry: volumetry(1),
      now: () => NOW,
    });

    await expect(
      selector.select(baseConfig, {
        signal: controller.signal,
        onProgress: (step) => {
          if (step.phase === 'candidate' && step.combinationKey?.includes('Kairos')) {
            queueMicrotask(() => controller.abort('timeout'));
          }
        },
      }),
    ).rejects.toBeInstanceOf(VolumetryBudgetExceededError);
  });
});
