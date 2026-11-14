import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Dices, HardDrive } from 'lucide-react';
import {
  FORGE_SAMPLE_DEFAULTS,
  leftOutByTheUser,
  type ForgeConfig,
  type ForgeGraph,
  type ForgeSampleBudget,
  type ForgeSampleBudgetResponse,
  type ForgeSampleOptions,
  type ForgeWholeOrgStorageCheck,
  type WholeOrgSampleBudget,
} from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useForgeStore } from '../../stores/useForgeStore';
import { formatEstimateSec } from '../../utils/formatters';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';
import { allowanceWords } from './ForgeWholeOrgDryRun';
import { mbOf, sampleNumber as n, wholeReasonWords } from './sampleWords';

/** The caps on the children of a record per relation the list offers, the default among them. */
const CHILDREN_PRESETS = [10, 50, 100, 500, 1_000] as const;

/** The most MB a sample may be asked to take, as the extension bounds it. */
const MOST_MB = 1_000_000;

/** A size typed in the field of the MB asked, or null when it is not one; empty asks none. */
function withinOf(draft: string): number | null | undefined {
  const text = draft.trim().replace(',', '.');
  if (text === '') return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const mb = Number(text);
  return mb > 0 && mb <= MOST_MB ? mb : null;
}

/** The options with those left at their default dropped, as the config keeps them. */
function settled(options: ForgeSampleOptions): ForgeSampleOptions {
  const kept: ForgeSampleOptions = {};
  for (const [key, value] of Object.entries(options) as Array<
    [keyof ForgeSampleOptions, ForgeSampleOptions[keyof ForgeSampleOptions]]
  >) {
    if (value === undefined) continue;
    if (key === 'whole' && Array.isArray(value) && value.length === 0) continue;
    Object.assign(kept, { [key]: value });
  }
  return kept;
}

/**
 * What the budget of a sample is read with: the options that change what it
 * may take, the objects it copies whole and what drawing it reads — the MB
 * asked, the objects asked whole, the draw. The seed, the parents and the
 * children change none of it, and a change of them reads nothing again.
 */
function budgetConfigOf(config: ForgeConfig): ForgeConfig {
  if (!config.sample) return config;
  const { withinMB, whole, draw } = config.sample;
  return {
    ...config,
    sample: settled({
      ...(withinMB !== undefined ? { withinMB } : {}),
      ...(whole ? { whole } : {}),
      ...(draw !== undefined ? { draw } : {}),
    }),
  };
}

/** What every record of the whole org takes against what the target has left. */
function wholeOrgWords(
  t: TFunction,
  check: ForgeWholeOrgStorageCheck,
  target: string,
  budget: WholeOrgSampleBudget | undefined,
): string {
  const estimate = n(Math.round(check.estimateMB * 10) / 10);
  if (check.verdict === 'unread') {
    return t('forgeRun.review.sample.wholeOrg.unread', { estimate, target, reason: check.unread });
  }
  const said = t(`forgeRun.review.sample.wholeOrg.${check.verdict}`, {
    estimate,
    target,
    remaining: n(check.remainingMB),
    max: n(check.maxMB),
  });
  return check.verdict === 'exceeds' && budget
    ? `${said} ${t('forgeRun.review.sample.wholeOrg.offer', { mb: mbOf(budget.bytes) })}`
    : said;
}

/** What the sample may take, and what gives it. */
function budgetWords(
  t: TFunction,
  budget: WholeOrgSampleBudget | undefined,
  target: string,
): string {
  if (!budget) return t('forgeRun.review.sample.budget.unread', { target });
  if (budget.limitedBy === 'within' || budget.remainingMB === undefined) {
    return t('forgeRun.review.sample.budget.within', { mb: mbOf(budget.bytes) });
  }
  return t('forgeRun.review.sample.budget.storage', {
    mb: mbOf(budget.bytes),
    share: n(Math.round((budget.share ?? 0) * 100)),
    remaining: n(budget.remainingMB),
    rounding: n(budget.roundingMB ?? 0),
    target,
  });
}

/** Props for {@link ReviewWholeOrgSample}. */
export interface ReviewWholeOrgSampleProps {
  graph: ForgeGraph;
  /** The two orgs, as the user knows them. */
  source: string;
  target: string;
}

/**
 * What Review says and sets of the records a clone of the whole org copies
 * of each object: every record, or a sample that fits the target — never
 * imposed. A whole production org rarely fits a Developer sandbox, and the
 * run's gate refuses it whole, writing nothing.
 *
 * It reads, of both orgs' limits (`forge:sample-budget`), what every record
 * would take against what the target has left, and says when that is past
 * it. With a sample, it says what the sample may take and what bounds it,
 * how its roots are drawn — spread over the org by a seed, or the newest
 * first —, about what drawing it reads of the source and how long, and the
 * objects it copies whole of itself; then, folded, the MB it may take, the
 * seed and a draw again, what an optional lookup to a record outside it
 * becomes, the children of a record it takes per relation, and the objects
 * asked to go whole. Nothing is drawn before Simulate or Execute.
 */
export const ReviewWholeOrgSample: React.FC<ReviewWholeOrgSampleProps> = ({
  graph,
  source,
  target,
}) => {
  const { t } = useTranslation();
  const config = useForgeStore((s) => s.config);
  const muteAutomation = useForgeStore((s) => s.muteAutomation);
  const setSample = useForgeStore((s) => s.setSample);
  const choiceName = useId();
  const withinId = useId();
  const withinHintId = useId();
  const drawId = useId();
  const drawHintId = useId();
  const parentsId = useId();
  const childrenId = useId();
  const childrenHintId = useId();
  const wholeListId = useId();
  const sample = config?.sample;
  const sampled = sample !== undefined;

  const budgetConfig = useMemo(() => (config ? budgetConfigOf(config) : null), [config]);
  // The same object while nothing it is made of changes: the query is sent
  // again whenever its payload reads otherwise, and a whole org's graph is
  // large to write out on every render.
  const payload = useMemo(
    () =>
      budgetConfig
        ? { graph, config: budgetConfig, ...(muteAutomation ? { muteAutomation } : {}) }
        : undefined,
    [graph, budgetConfig, muteAutomation],
  );
  const read = useBridgeQuery<ForgeSampleBudgetResponse['payload']>(
    'forge:sample-budget:request',
    payload,
    {
      responseType: 'forge:sample-budget:response',
      errorType: 'forge:sample-budget:error',
      skip: payload === undefined,
    },
  );
  // An answer for a target the page no longer runs to is not this one's.
  const budget: ForgeSampleBudget | undefined =
    read.data && read.data.targetOrgId === config?.targetOrgId ? read.data.budget : undefined;

  /** Change the sample's options as `change` says. */
  const change = (next: (options: ForgeSampleOptions) => ForgeSampleOptions): void => {
    setSample(settled(next(sample ?? {})));
  };

  const [withinDraft, setWithinDraft] = useState(
    sample?.withinMB !== undefined ? String(sample.withinMB) : '',
  );
  // An MB set elsewhere — a past run brought back — shows here.
  useEffect(() => {
    setWithinDraft(sample?.withinMB !== undefined ? String(sample.withinMB) : '');
  }, [sample?.withinMB]);
  const withinRefused = withinOf(withinDraft) === null;

  const [wholeOpen, setWholeOpen] = useState(false);
  const wholeOfItself = useMemo(
    () => new Map((budget?.whole ?? []).map((entry) => [entry.objectApiName, entry.why])),
    [budget],
  );
  const asked = useMemo(() => new Set(sample?.whole ?? []), [sample?.whole]);
  /** The objects the run takes, each of which may be asked to go whole. */
  const taken = useMemo(() => {
    const excluded = new Set(config?.excludedObjects ?? []);
    return graph.nodes
      .filter(
        (node) => node.included && !leftOutByTheUser(node) && !excluded.has(node.objectApiName),
      )
      .map((node) => node.objectApiName)
      .sort();
  }, [graph, config?.excludedObjects]);

  const seed = sample?.seed ?? FORGE_SAMPLE_DEFAULTS.seed;
  const draw = sample?.draw ?? FORGE_SAMPLE_DEFAULTS.draw;
  const parents = sample?.parents ?? FORGE_SAMPLE_DEFAULTS.parents;
  const children = sample?.children ?? FORGE_SAMPLE_DEFAULTS.children;
  const childrenOptions: Array<number | 'all'> = [
    ...new Set<number>([...CHILDREN_PRESETS, ...(typeof children === 'number' ? [children] : [])]),
  ]
    .sort((a, b) => a - b)
    .map((value): number | 'all' => value);
  childrenOptions.push('all');

  const cost = budget?.planReads;
  const selectClass = cn(
    'px-2 py-1 rounded-md text-xs',
    'bg-(--sf-bg-input) text-(--sf-text-input)',
    'border border-(--sf-border-input)',
    'focus:outline-hidden focus:border-forge/50',
  );

  return (
    <div
      data-testid="review-sample"
      className="flex items-start gap-2 rounded-md border border-subtle px-3 py-2"
    >
      <HardDrive size={14} aria-hidden="true" className="mt-1 shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* Every record past what the target has left is a warning while the
            run copies every record: the line alone takes its tint, on which
            the secondary text of the settings below would fall under AA. */}
        <p
          data-testid="review-sample-whole-org"
          role="status"
          className={cn(
            'text-text-primary',
            budget?.wholeOrg.verdict === 'exceeds' &&
              !sampled &&
              'rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1',
          )}
        >
          {read.error !== null
            ? t('forgeRun.review.sample.wholeOrg.failed', { target, message: read.error })
            : budget
              ? wholeOrgWords(t, budget.wholeOrg, target, budget.budget)
              : t('forgeRun.review.sample.wholeOrg.reading', { target })}
        </p>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-semibold text-text-primary">
            {t('forge.recordLimit')}
          </legend>
          <label className="flex items-center gap-2 text-xs text-text-primary">
            <input
              type="radio"
              name={choiceName}
              data-testid="review-sample-every"
              checked={!sampled}
              onChange={() => setSample(undefined)}
            />
            <span>{t('forge.recordLimitEvery')}</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-text-primary">
            <input
              type="radio"
              name={choiceName}
              data-testid="review-sample-fits"
              checked={sampled}
              onChange={() => setSample(sample ?? {})}
            />
            <span>{t('forge.recordLimitSample')}</span>
          </label>
        </fieldset>

        {sampled && (
          <div data-testid="review-sample-options" className="flex flex-col gap-2 text-xs">
            {budget && (
              <p data-testid="review-sample-budget" className="text-text-primary">
                {budgetWords(t, budget.budget, target)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={drawId} className="font-medium text-text-primary">
                {t('forgeRun.review.sample.draw.label')}
              </label>
              <select
                id={drawId}
                data-testid="review-sample-draw"
                aria-describedby={drawHintId}
                value={draw}
                onChange={(e) =>
                  change((o) => ({
                    ...o,
                    draw: e.target.value === 'recent' ? 'recent' : undefined,
                  }))
                }
                className={selectClass}
              >
                <option value="uniform">{t('forgeRun.review.sample.draw.uniform')}</option>
                <option value="recent">{t('forgeRun.review.sample.draw.recent')}</option>
              </select>
            </div>
            <p
              id={drawHintId}
              data-testid="review-sample-draw-hint"
              className="text-text-secondary"
            >
              {t(
                draw === 'recent'
                  ? 'forgeRun.review.sample.draw.recentHint'
                  : 'forgeRun.review.sample.draw.uniformHint',
              )}
            </p>
            {cost && (
              <p data-testid="review-sample-cost" className="text-text-primary">
                {t('forgeRun.review.sample.cost', {
                  source,
                  allowance: allowanceWords(t, cost.source),
                  duration: formatEstimateSec(cost.seconds),
                })}
              </p>
            )}
            {cost?.source.verdict === 'exceeds' && (
              <p
                data-testid="review-sample-cost-refused"
                className="rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1 text-text-primary"
              >
                {t('forgeRun.review.sample.costRefused', { source })}
              </p>
            )}
            {budget && budget.whole.length > 0 && (
              <p data-testid="review-sample-whole" className="text-text-secondary">
                {t('forgeRun.review.sample.whole', {
                  objects: budget.whole
                    .map(
                      ({ objectApiName, why }) => `${objectApiName} (${wholeReasonWords(t, why)})`,
                    )
                    .join(', '),
                })}
              </p>
            )}

            <details data-testid="review-sample-more" className="text-xs">
              <summary className="cursor-pointer text-text-primary">
                {t('forgeRun.review.sample.settings')}
              </summary>
              <div className="mt-2 flex flex-col gap-2 pl-1">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={withinId} className="text-text-primary">
                    {t('forgeRun.review.sample.within.label')}
                  </label>
                  <input
                    id={withinId}
                    type="text"
                    inputMode="decimal"
                    data-testid="review-sample-within"
                    value={withinDraft}
                    aria-describedby={withinHintId}
                    aria-invalid={withinRefused}
                    onChange={(e) => setWithinDraft(e.target.value)}
                    // Taken once the field is left, never keystroke by
                    // keystroke: each MB taken reads both orgs' limits again.
                    onBlur={() => {
                      const mb = withinOf(withinDraft);
                      if (mb === null) {
                        setWithinDraft(
                          sample?.withinMB !== undefined ? String(sample.withinMB) : '',
                        );
                        return;
                      }
                      if (mb !== sample?.withinMB) change((o) => ({ ...o, withinMB: mb }));
                    }}
                    className={cn(
                      'w-20 px-2 py-1 rounded-sm text-xs',
                      'bg-(--sf-bg-input) text-(--sf-text-input)',
                      'border',
                      withinRefused ? 'border-status-error/60' : 'border-(--sf-border-input)',
                    )}
                  />
                  <span className="text-text-secondary">MB</span>
                </div>
                <p id={withinHintId} className="text-text-secondary">
                  {t('forgeRun.review.sample.within.hint')}
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  <Dices size={12} aria-hidden="true" className="text-text-secondary" />
                  <span data-testid="review-sample-seed" className="text-text-primary">
                    {t('forgeRun.review.sample.seed', { seed: n(seed) })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="review-sample-draw-again"
                    onClick={() => change((o) => ({ ...o, seed: seed + 1 }))}
                  >
                    {t('forgeRun.review.sample.drawAgain')}
                  </Button>
                </div>
                <p className="text-text-secondary">{t('forgeRun.review.sample.seedHint')}</p>

                <div className="flex flex-col gap-1">
                  <label htmlFor={parentsId} className="text-text-primary">
                    {t('forgeRun.review.sample.parents.label')}
                  </label>
                  <select
                    id={parentsId}
                    data-testid="review-sample-parents"
                    value={parents}
                    onChange={(e) =>
                      change((o) => ({
                        ...o,
                        parents: e.target.value === 'required' ? 'required' : undefined,
                      }))
                    }
                    className={cn(selectClass, 'self-start')}
                  >
                    <option value="all">{t('forgeRun.review.sample.parents.all')}</option>
                    <option value="required">{t('forgeRun.review.sample.parents.required')}</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor={childrenId} className="text-text-primary">
                    {t('forgeRun.review.sample.children.label')}
                  </label>
                  <select
                    id={childrenId}
                    data-testid="review-sample-children"
                    aria-describedby={childrenHintId}
                    value={String(children)}
                    onChange={(e) => {
                      const value = e.target.value;
                      change((o) => ({
                        ...o,
                        children:
                          value === 'all'
                            ? 'all'
                            : Number(value) === FORGE_SAMPLE_DEFAULTS.children
                              ? undefined
                              : Number(value),
                      }));
                    }}
                    className={cn(selectClass, 'self-start')}
                  >
                    {childrenOptions.map((value) => (
                      <option key={String(value)} value={String(value)}>
                        {value === 'all' ? t('forgeRun.review.sample.children.all') : n(value)}
                      </option>
                    ))}
                  </select>
                  <p id={childrenHintId} className="text-text-secondary">
                    {t('forgeRun.review.sample.children.hint')}
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    data-testid="review-sample-whole-toggle"
                    aria-expanded={wholeOpen}
                    aria-controls={wholeOpen ? wholeListId : undefined}
                    onClick={() => setWholeOpen((open) => !open)}
                  >
                    {t('forgeRun.review.sample.wholeList.toggle', {
                      count: wholeOfItself.size + asked.size,
                      formatted: n(wholeOfItself.size + asked.size),
                    })}
                  </Button>
                  {/* Listed only once asked for: a whole org has up to some
                      two thousand objects, a box each. */}
                  {wholeOpen && (
                    <fieldset
                      id={wholeListId}
                      data-testid="review-sample-whole-list"
                      className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border border-subtle px-2 py-1"
                    >
                      <legend className="sr-only">
                        {t('forgeRun.review.sample.wholeList.legend')}
                      </legend>
                      <p className="text-text-secondary">
                        {t('forgeRun.review.sample.wholeList.hint')}
                      </p>
                      {taken.map((name) => {
                        const why = wholeOfItself.get(name);
                        return (
                          <label key={name} className="flex items-center gap-2 text-text-primary">
                            <input
                              type="checkbox"
                              data-testid={`review-sample-whole-${name}`}
                              checked={why !== undefined || asked.has(name)}
                              disabled={why !== undefined}
                              onChange={(e) => {
                                const on = e.target.checked;
                                change((o) => ({
                                  ...o,
                                  whole: on
                                    ? [...(o.whole ?? []), name].sort()
                                    : (o.whole ?? []).filter((w) => w !== name),
                                }));
                              }}
                            />
                            <span className="font-mono">{name}</span>
                            {why !== undefined && (
                              <span
                                data-testid={`review-sample-whole-why-${name}`}
                                className="text-text-secondary"
                              >
                                {wholeReasonWords(t, why)}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </fieldset>
                  )}
                </div>
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
};
