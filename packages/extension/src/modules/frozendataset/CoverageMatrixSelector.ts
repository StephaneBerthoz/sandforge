/**
 * Coverage-matrix selection (spec §1) — picks WHICH root records
 * ("dossiers") enter the frozen dataset. This is deliberately not a
 * random sample: coverage axes are crossed, one healthy root is retained
 * per observed combination, plus one per declared edge case.
 *
 * SOQL feasibility note (documented choice): SOQL has no cross-object
 * GROUP BY CUBE, and axes are client-configurable, so the matrix is
 * enumerated in two steps:
 *   1. each axis runs its own aggregate query (`valuesSoql`, e.g.
 *      `SELECT Prestation__c axisValue, COUNT(Id) cnt FROM Dossier__c
 *      GROUP BY Prestation__c`) to list the values OBSERVED in the source
 *      org — the row alias `axisValue` is the contract;
 *   2. each combination of axis values (cartesian product) is probed with
 *      a deterministic candidate query (`... ORDER BY Id ASC LIMIT n`) —
 *      a combination is "observed" iff the probe returns at least one
 *      candidate.
 *
 * Health per dossier goes through the injected {@link DossierHealthChecker}
 * (backed by the existing Forge graph discovery — see
 * ForgeGraphHealthChecker): a combination whose candidates are all "lame"
 * is reported as uncovered, never silently kept.
 *
 * The volumetry budget (default 2 500 records) is verified MECHANICALLY
 * after selection: beyond it, selection refuses with
 * {@link VolumetryBudgetExceededError}.
 */

import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { renderQueryTemplate } from './queryTemplates.js';

/** One configurable coverage axis. */
export interface CoverageAxis {
  /** Stable axis name (used in combination keys). */
  name: string;
  /** Human label (UI/reporting). */
  label: string;
  /**
   * Field on the ROOT object filtered by this axis' values when probing
   * combinations.
   */
  filterField: string;
  /**
   * Aggregate SOQL enumerating the axis values observed in the source
   * org. Rows must expose the value under the `axisValue` alias.
   * May contain `{{TOKEN}}` placeholders rendered from `config.tokens`.
   */
  valuesSoql: string;
}

/** A declared edge case: one extra root retained per marker (data marker). */
export interface EdgeCaseDefinition {
  /** Stable edge-case name. */
  name: string;
  /** Human label. */
  label: string;
  /**
   * WHERE fragment selecting the marker in data (e.g.
   * `Flag_Litige__c = true`). Wrapped in parens when combined.
   */
  whereFragment: string;
}

/** Health verdict for one candidate root record. */
export interface DossierHealth {
  healthy: boolean;
  /** Why the dossier is lame, when it is. */
  reason?: string;
}

/** Injected per-dossier health check (graph completeness). */
export interface DossierHealthChecker {
  check(rootRecordId: string): Promise<DossierHealth>;
}

/** Injected one-shot SOQL query function. */
export type SoqlQueryFn = (soql: string) => Promise<Record<string, unknown>[]>;

/**
 * Injected volumetry measurement: given the retained root IDs, return
 * the per-object record counts of the full extraction scope (children
 * included — the real footprint, not just roots).
 */
export type ScopeVolumetryFn = (rootRecordIds: string[]) => Promise<Record<string, number>>;

/** Full selector configuration. */
export interface CoverageMatrixConfig {
  /** API name of the root ("dossier") object. */
  rootObject: string;
  axes: CoverageAxis[];
  edgeCases: EdgeCaseDefinition[];
  /** Volumetry ceiling, records — default 2 500 (spec §1). */
  budgetMaxRecords?: number;
  /** Candidates probed per combination before declaring it uncovered. */
  candidatesPerCombination?: number;
  /** Token values (from the sas) for `{{TOKEN}}` placeholders in SOQL. */
  tokens?: Record<string, string>;
}

/** One retained root record. */
export interface SelectedRoot {
  rootRecordId: string;
  /** Combination key, e.g. `prestation=RC|logiciel=Kairos`, or edge-case name. */
  combinationKey: string;
  /** Axis values of the combination (empty for edge cases). */
  axisValues: Record<string, string | null>;
  /** Set when this root was retained for an edge case. */
  edgeCase?: string;
}

/** A combination for which no healthy root could be retained. */
export interface UncoveredCombination {
  combinationKey: string;
  reason: string;
}

/** Selector output. */
export interface CoverageSelectionResult {
  /** Retained roots — exactly one per observed combination / edge case. */
  roots: SelectedRoot[];
  /** Combinations observed but without any healthy candidate. */
  uncovered: UncoveredCombination[];
  volumetry: {
    measured: Record<string, number>;
    total: number;
    budgetMax: number;
  };
  /** ISO timestamp of the selection (decision date for the manifest). */
  selectedAt: string;
}

/** Default volumetry ceiling (spec §1). */
export const DEFAULT_BUDGET_MAX_RECORDS = 2_500;

const DEFAULT_CANDIDATES_PER_COMBINATION = 3;

/** Thrown when the measured volumetry exceeds the configured budget. */
export class VolumetryBudgetExceededError extends Error {
  constructor(
    readonly measured: Record<string, number>,
    readonly total: number,
    readonly budgetMax: number,
  ) {
    super(
      `Volumetry budget exceeded: ${total} records measured for a budget of ${budgetMax}. ` +
        `Narrow the coverage axes/edge cases or raise budgetMaxRecords explicitly. ` +
        `Per-object counts: ${JSON.stringify(measured)}`,
    );
    this.name = 'VolumetryBudgetExceededError';
  }
}

/** Error thrown for malformed axis query results. */
export class CoverageSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageSelectionError';
  }
}

/** Dependencies injected into {@link CoverageMatrixSelector}. */
export interface CoverageMatrixSelectorDeps {
  query: SoqlQueryFn;
  checkHealth: DossierHealthChecker;
  measureVolumetry: ScopeVolumetryFn;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/**
 * Selects one healthy root record per observed axis-value combination,
 * plus one per declared edge case, under a mechanical volumetry budget.
 */
export class CoverageMatrixSelector {
  private readonly deps: CoverageMatrixSelectorDeps;

  constructor(deps: CoverageMatrixSelectorDeps) {
    this.deps = deps;
  }

  /** Run the selection. Throws {@link VolumetryBudgetExceededError} over budget. */
  async select(config: CoverageMatrixConfig): Promise<CoverageSelectionResult> {
    const budgetMax = config.budgetMaxRecords ?? DEFAULT_BUDGET_MAX_RECORDS;
    const candidateLimit = config.candidatesPerCombination ?? DEFAULT_CANDIDATES_PER_COMBINATION;
    const rootObject = assertSoqlIdentifier(config.rootObject);

    // 1. Enumerate the observed values of every axis.
    const axisValues = new Map<string, Array<string | null>>();
    for (const axis of config.axes) {
      axisValues.set(axis.name, await this.enumerateAxisValues(axis, config.tokens));
    }

    // 2. Probe every combination of axis values; retain 1 healthy root each.
    const roots: SelectedRoot[] = [];
    const uncovered: UncoveredCombination[] = [];
    // An axis observing zero values yields no combination at all; a
    // config without axes probes the whole root object as one combination.
    const combinations =
      config.axes.length === 0
        ? [[]]
        : cartesian(
            config.axes.map((axis) => ({
              axis: axis.name,
              values: axisValues.get(axis.name) ?? [],
            })),
          );
    for (const combination of combinations) {
      const combinationKey =
        combination.length === 0
          ? 'all'
          : combination.map((c) => `${c.axis}=${c.value ?? 'NULL'}`).join('|');
      const where = combination
        .map((c) => {
          const field = assertSoqlIdentifier(
            config.axes.find((a) => a.name === c.axis)?.filterField ?? '',
          );
          return c.value === null
            ? `${field} = NULL`
            : `${field} = '${sanitizeSoqlValue(c.value)}'`;
        })
        .join(' AND ');
      const retained = await this.pickHealthyRoot(rootObject, where, candidateLimit, config.tokens);
      const axisValuesRecord: Record<string, string | null> = {};
      for (const c of combination) {
        axisValuesRecord[c.axis] = c.value;
      }
      if (retained) {
        roots.push({ rootRecordId: retained, combinationKey, axisValues: axisValuesRecord });
      } else {
        uncovered.push({
          combinationKey,
          reason: `no healthy candidate among the ${candidateLimit} probed`,
        });
      }
    }

    // 3. One healthy root per declared edge case (marker in data).
    for (const edgeCase of config.edgeCases) {
      const retained = await this.pickHealthyRoot(
        rootObject,
        `(${edgeCase.whereFragment})`,
        candidateLimit,
        config.tokens,
      );
      if (retained) {
        roots.push({
          rootRecordId: retained,
          combinationKey: `edge:${edgeCase.name}`,
          axisValues: {},
          edgeCase: edgeCase.name,
        });
      } else {
        uncovered.push({
          combinationKey: `edge:${edgeCase.name}`,
          reason: 'no healthy candidate matching the edge-case marker',
        });
      }
    }

    // 4. Mechanical volumetry budget verification — refuse beyond budget.
    const measured = await this.deps.measureVolumetry(roots.map((r) => r.rootRecordId));
    const total = Object.values(measured).reduce((sum, n) => sum + n, 0);
    if (total > budgetMax) {
      throw new VolumetryBudgetExceededError(measured, total, budgetMax);
    }

    return {
      roots,
      uncovered,
      volumetry: { measured, total, budgetMax },
      selectedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
  }

  /** Run one axis aggregate query and collect the observed `axisValue`s. */
  private async enumerateAxisValues(
    axis: CoverageAxis,
    tokens: Record<string, string> | undefined,
  ): Promise<Array<string | null>> {
    const soql = renderQueryTemplate(axis.valuesSoql, tokens ?? {});
    const rows = await this.deps.query(soql);
    const values: Array<string | null> = [];
    for (const row of rows) {
      if (!('axisValue' in row)) {
        throw new CoverageSelectionError(
          `Axis "${axis.name}" query must alias its grouped value as axisValue ` +
            `(e.g. SELECT ${axis.filterField} axisValue, COUNT(Id) cnt ... GROUP BY ${axis.filterField})`,
        );
      }
      const value = row.axisValue;
      if (value === null || value === undefined) {
        values.push(null);
      } else if (typeof value === 'string') {
        values.push(value);
      } else {
        values.push(String(value));
      }
    }
    // Deterministic order so the selection is reproducible.
    return [...new Set(values)].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  }

  /**
   * Probe up to `limit` candidates for a WHERE clause and retain the
   * first healthy one. Deterministic: candidates are ordered by Id.
   */
  private async pickHealthyRoot(
    rootObject: string,
    where: string,
    limit: number,
    tokens: Record<string, string> | undefined,
  ): Promise<string | null> {
    const template =
      where === ''
        ? `SELECT Id FROM ${rootObject} ORDER BY Id ASC LIMIT ${Math.max(1, Math.floor(limit))}`
        : `SELECT Id FROM ${rootObject} WHERE ${where} ` +
          `ORDER BY Id ASC LIMIT ${Math.max(1, Math.floor(limit))}`;
    const rows = await this.deps.query(renderQueryTemplate(template, tokens ?? {}));
    for (const row of rows) {
      const id = row.Id;
      if (typeof id !== 'string' || id === '') {
        continue;
      }
      const health = await this.deps.checkHealth.check(id);
      if (health.healthy) {
        return id;
      }
    }
    return null;
  }
}

/** Cartesian product of axis values, in deterministic axis order. */
function cartesian(
  axes: Array<{ axis: string; values: Array<string | null> }>,
): Array<Array<{ axis: string; value: string | null }>> {
  let acc: Array<Array<{ axis: string; value: string | null }>> = [[]];
  for (const { axis, values } of axes) {
    const next: Array<Array<{ axis: string; value: string | null }>> = [];
    for (const prefix of acc) {
      for (const value of values) {
        next.push([...prefix, { axis, value }]);
      }
    }
    acc = next;
  }
  // Zero axes → [[]] (single whole-object combination); an axis with zero
  // observed values → [] (no combination to probe).
  return acc;
}
