/**
 * Coverage-matrix selection — picks WHICH root records
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
 * (judged on the candidate's own records — see ScopedDossierHealthChecker):
 * a combination whose candidates are all "lame" is reported as uncovered,
 * with the reason the last one was turned away, never silently kept.
 *
 * The volumetry budget (default 2 500 records) is verified MECHANICALLY
 * after selection: beyond it, selection refuses with
 * {@link VolumetryBudgetExceededError}.
 */

import type { FrozenSelectProgress, FrozenSelectionStop } from '@sandforge/shared';
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
  /**
   * The records of the candidate's own scope, per object, when the check
   * measured them: what a selection that stops before its final measure adds
   * up for the roots it kept.
   */
  measured?: Record<string, number>;
}

/** Injected per-dossier health check. */
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
  /** Volumetry ceiling, records — default 2 500. */
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
    /**
     * Set when the roots were not measured together — the selection stopped
     * first — and the figures are each kept root's own measure, added up.
     */
    summed?: true;
  };
  /** ISO timestamp of the selection (decision date for the manifest). */
  selectedAt: string;
  /** Set when the selection stopped short: where, and what it never reached. */
  stopped?: FrozenSelectionStop;
}

/** What a selection is told as it runs, and what stops it. */
export interface SelectionRunOptions {
  /**
   * Stops the selection at its next step, and stops waiting on the call in
   * flight: what it decided is kept and returned. `timeout` as the abort's
   * reason says the time ran out; anything else, that it was cancelled.
   */
  signal?: AbortSignal;
  /** Told each step as it starts. */
  onProgress?: (step: FrozenSelectProgress) => void;
}

/** Raised inside a selection when its signal fires. */
class SelectionStopped extends Error {
  constructor() {
    super('Selection stopped');
    this.name = 'SelectionStopped';
  }
}

/** Wait for `work`, or stop waiting as soon as `signal` fires. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new SelectionStopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SelectionStopped());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Default volumetry ceiling. */
export const DEFAULT_BUDGET_MAX_RECORDS = 2_500;

const DEFAULT_CANDIDATES_PER_COMBINATION = 3;

/** How many of the heaviest objects a refused budget names. */
const HEAVIEST_NAMED = 5;

/**
 * The heaviest objects of a measure, the root's object aside, with their
 * counts: those a refused budget suggests leaving out.
 */
function heaviestObjects(
  measured: Record<string, number>,
  rootObject?: string,
): Array<{ objectApiName: string; count: number }> {
  return Object.entries(measured)
    .filter(([objectApiName, count]) => objectApiName !== rootObject && count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, HEAVIEST_NAMED)
    .map(([objectApiName, count]) => ({ objectApiName, count }));
}

/**
 * Thrown when the measured volumetry exceeds the configured budget.
 *
 * It names the heaviest objects and suggests leaving them out. Run for real
 * on a large org, a refusal that said only to narrow the axes or raise the
 * budget left the person to read the per-object counts, and it took fourteen
 * `excludedObjects` found that way to load anything.
 */
export class VolumetryBudgetExceededError extends Error {
  constructor(
    readonly measured: Record<string, number>,
    readonly total: number,
    readonly budgetMax: number,
    rootObject?: string,
  ) {
    const heaviest = heaviestObjects(measured, rootObject);
    const named =
      heaviest.length > 0
        ? `The heaviest: ${heaviest.map((h) => `${h.objectApiName} ${h.count}`).join(', ')}. ` +
          `Leave out those the dataset does not need with excludedObjects ` +
          `(${JSON.stringify(heaviest.map((h) => h.objectApiName))}), narrow the coverage ` +
          `axes/edge cases, or raise budgetMaxRecords explicitly. `
        : `Narrow the coverage axes/edge cases or raise budgetMaxRecords explicitly. `;
    super(
      `Volumetry budget exceeded: ${total} records measured for a budget of ${budgetMax}. ` +
        `${named}Per-object counts: ${JSON.stringify(measured)}`,
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
  /**
   * The type of a field of an object as the source describes it (`boolean`,
   * `double`, `date`…), or nothing when it cannot say: what an axis value is
   * written as in a probe (`axisValueLiteral`). Without it, every value is
   * quoted as text.
   */
  fieldType?: (objectApiName: string, field: string) => Promise<string | undefined>;
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

  /**
   * Run the selection. Throws {@link VolumetryBudgetExceededError} over budget.
   *
   * Stopped by `options.signal` — its time ran out, or it was cancelled — it
   * keeps the combinations it decided and returns them with where it was
   * (`stopped`). Run for real on a large org, a selection died on the
   * handler's timeout after ten minutes with nothing kept and no word on the
   * combination it was probing.
   */
  async select(
    config: CoverageMatrixConfig,
    options: SelectionRunOptions = {},
  ): Promise<CoverageSelectionResult> {
    const budgetMax = config.budgetMaxRecords ?? DEFAULT_BUDGET_MAX_RECORDS;
    const candidateLimit = config.candidatesPerCombination ?? DEFAULT_CANDIDATES_PER_COMBINATION;
    const rootObject = assertSoqlIdentifier(config.rootObject);
    const { signal } = options;
    const tell = (step: FrozenSelectProgress): void => options.onProgress?.(step);
    const roots: SelectedRoot[] = [];
    const uncovered: UncoveredCombination[] = [];
    /** Each kept root's own measure, as its health check took it. */
    const ownMeasures: Array<Record<string, number>> = [];
    /** Where the selection is, for a stop to say. */
    const at: {
      during: FrozenSelectionStop['during'];
      combinationKey?: string;
      candidate?: number;
      pending: string[];
    } = { during: 'axes', pending: [] };
    const stoppedAt = (): CoverageSelectionResult => {
      const measured: Record<string, number> = {};
      for (const own of ownMeasures) {
        for (const [name, count] of Object.entries(own))
          measured[name] = (measured[name] ?? 0) + count;
      }
      const total = Object.values(measured).reduce((sum, n) => sum + n, 0);
      if (total > budgetMax) {
        throw new VolumetryBudgetExceededError(measured, total, budgetMax, rootObject);
      }
      return {
        roots,
        uncovered,
        volumetry: { measured, total, budgetMax, summed: true },
        selectedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        stopped: {
          reason: signal?.reason === 'timeout' ? 'timeout' : 'cancelled',
          during: at.during,
          ...(at.combinationKey !== undefined ? { combinationKey: at.combinationKey } : {}),
          ...(at.candidate !== undefined
            ? { candidate: at.candidate, candidates: candidateLimit }
            : {}),
          notProbed: at.pending,
        },
      };
    };

    try {
      return await this.run(
        config,
        { rootObject, budgetMax, candidateLimit, signal, tell },
        {
          roots,
          uncovered,
          ownMeasures,
          at,
        },
      );
    } catch (error) {
      if (error instanceof SelectionStopped) return stoppedAt();
      throw error;
    }
  }

  /** The steps of {@link select}, which keeps what they decide in `found`. */
  private async run(
    config: CoverageMatrixConfig,
    context: {
      rootObject: string;
      budgetMax: number;
      candidateLimit: number;
      signal: AbortSignal | undefined;
      tell: (step: FrozenSelectProgress) => void;
    },
    found: {
      roots: SelectedRoot[];
      uncovered: UncoveredCombination[];
      ownMeasures: Array<Record<string, number>>;
      at: {
        during: FrozenSelectionStop['during'];
        combinationKey?: string;
        candidate?: number;
        pending: string[];
      };
    },
  ): Promise<CoverageSelectionResult> {
    const { rootObject, budgetMax, candidateLimit, signal, tell } = context;
    const { roots, uncovered, ownMeasures, at } = found;
    const step = <T>(work: Promise<T>): Promise<T> => untilStopped(work, signal);

    // 1. Enumerate the observed values of every axis, and the type of the
    // field each filters on, which says how a probe writes its values.
    const axisValues = new Map<string, Array<string | null>>();
    const axisTypes = new Map<string, string | undefined>();
    for (const axis of config.axes) {
      tell({ phase: 'axis', axis: axis.name });
      axisValues.set(axis.name, await step(this.enumerateAxisValues(axis, config.tokens)));
      axisTypes.set(
        axis.name,
        await step(
          this.deps.fieldType?.(rootObject, axis.filterField).catch(() => undefined) ??
            Promise.resolve(undefined),
        ),
      );
    }

    // 2. Probe every combination of axis values; retain 1 healthy root each.
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
    const keyOf = (combination: Array<{ axis: string; value: string | null }>): string =>
      combination.length === 0
        ? 'all'
        : combination.map((c) => `${c.axis}=${c.value ?? 'NULL'}`).join('|');
    at.pending = [
      ...combinations.map(keyOf),
      ...config.edgeCases.map((edgeCase) => `edge:${edgeCase.name}`),
    ];
    const pick = async (key: string, where: string): Promise<PickResult> => {
      at.during = 'combination';
      at.combinationKey = key;
      at.candidate = undefined;
      at.pending = at.pending.filter((pending) => pending !== key);
      return this.pickHealthyRoot(rootObject, where, candidateLimit, config.tokens, {
        step,
        onCandidate: (candidate) => {
          at.candidate = candidate;
          tell({ phase: 'candidate', combinationKey: key, candidate, candidates: candidateLimit });
        },
      });
    };
    for (const [index, combination] of combinations.entries()) {
      const combinationKey = keyOf(combination);
      tell({ phase: 'combination', combinationKey, index: index + 1, of: combinations.length });
      const where = combination
        .map((c) => {
          const field = assertSoqlIdentifier(
            config.axes.find((a) => a.name === c.axis)?.filterField ?? '',
          );
          return c.value === null
            ? `${field} = NULL`
            : `${field} = ${axisValueLiteral(c.value, axisTypes.get(c.axis))}`;
        })
        .join(' AND ');
      const retained = await pick(combinationKey, where);
      const axisValuesRecord: Record<string, string | null> = {};
      for (const c of combination) {
        axisValuesRecord[c.axis] = c.value;
      }
      if (retained.id) {
        roots.push({ rootRecordId: retained.id, combinationKey, axisValues: axisValuesRecord });
        if (retained.measured) ownMeasures.push(retained.measured);
      } else {
        uncovered.push({ combinationKey, reason: uncoveredReason(retained, candidateLimit) });
      }
    }

    // 3. One healthy root per declared edge case (marker in data).
    for (const [index, edgeCase] of config.edgeCases.entries()) {
      const combinationKey = `edge:${edgeCase.name}`;
      tell({ phase: 'combination', combinationKey, index: index + 1, of: config.edgeCases.length });
      const retained = await pick(combinationKey, `(${edgeCase.whereFragment})`);
      if (retained.id) {
        roots.push({
          rootRecordId: retained.id,
          combinationKey,
          axisValues: {},
          edgeCase: edgeCase.name,
        });
        if (retained.measured) ownMeasures.push(retained.measured);
      } else {
        uncovered.push({
          combinationKey: `edge:${edgeCase.name}`,
          reason:
            retained.probed === 0
              ? 'no record matches the edge-case marker'
              : uncoveredReason(retained, candidateLimit),
        });
      }
    }

    // 4. Mechanical volumetry budget verification — refuse beyond budget.
    // Nothing retained is nothing to measure: asked to measure an empty list,
    // the extraction had no root to start from and failed, and the selection
    // died with a discovery error instead of saying what it found.
    at.during = 'measure';
    at.combinationKey = undefined;
    at.candidate = undefined;
    if (roots.length > 0) tell({ phase: 'measure', roots: roots.length });
    const measured =
      roots.length === 0
        ? {}
        : await step(this.deps.measureVolumetry(roots.map((r) => r.rootRecordId)));
    const total = Object.values(measured).reduce((sum, n) => sum + n, 0);
    if (total > budgetMax) {
      throw new VolumetryBudgetExceededError(measured, total, budgetMax, rootObject);
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
    run: {
      step: <T>(work: Promise<T>) => Promise<T>;
      onCandidate: (candidate: number) => void;
    },
  ): Promise<PickResult> {
    const template =
      where === ''
        ? `SELECT Id FROM ${rootObject} ORDER BY Id ASC LIMIT ${Math.max(1, Math.floor(limit))}`
        : `SELECT Id FROM ${rootObject} WHERE ${where} ` +
          `ORDER BY Id ASC LIMIT ${Math.max(1, Math.floor(limit))}`;
    const rows = await run.step(this.deps.query(renderQueryTemplate(template, tokens ?? {})));
    let probed = 0;
    let lastReason: string | undefined;
    for (const row of rows) {
      const id = row.Id;
      if (typeof id !== 'string' || id === '') {
        continue;
      }
      probed++;
      run.onCandidate(probed);
      const health = await run.step(this.deps.checkHealth.check(id));
      if (health.healthy) {
        return { id, probed, ...(health.measured ? { measured: health.measured } : {}) };
      }
      lastReason = health.reason;
    }
    return { id: null, probed, lastReason };
  }
}

/** What probing one combination came to. */
interface PickResult {
  /** The retained root, or null when none was healthy. */
  id: string | null;
  /** Candidates actually probed. */
  probed: number;
  /** Why the last candidate probed was turned away. */
  lastReason?: string;
  /** The retained root's own measure, when its check took one. */
  measured?: Record<string, number>;
}

/**
 * Why a combination went uncovered, in terms a person can act on: the count
 * alone said that candidates failed, never what they failed on.
 */
function uncoveredReason(pick: PickResult, limit: number): string {
  if (pick.probed === 0) return 'no candidate record';
  const base = `no healthy candidate among the ${pick.probed} probed (limit ${limit})`;
  return pick.lastReason ? `${base} — last: ${pick.lastReason}` : base;
}

/** The field types whose SOQL literals are numbers, written bare. */
const NUMBER_TYPES = new Set(['int', 'long', 'double', 'currency', 'percent']);

/**
 * An axis value as a probe's WHERE writes it for the type of the field it
 * filters on: bare for a checkbox, a number, a date or a date and time, as
 * SOQL takes them; quoted as text for any other type, or when the value is
 * not one of its type. Quoted, a checkbox axis on `IsPersonAccount` probed
 * `IsPersonAccount = 'false'`, which the org refused (`INVALID_FIELD`), and
 * the selection kept no root.
 */
export function axisValueLiteral(value: string, fieldType: string | undefined): string {
  const quoted = `'${sanitizeSoqlValue(value)}'`;
  switch (fieldType) {
    case 'boolean':
      return /^(true|false)$/i.test(value) ? value.toLowerCase() : quoted;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : quoted;
    case 'datetime':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/.test(value)
        ? value
        : quoted;
    default:
      if (fieldType !== undefined && NUMBER_TYPES.has(fieldType)) {
        return /^-?\d+(\.\d+)?$/.test(value) ? value : quoted;
      }
      return quoted;
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
