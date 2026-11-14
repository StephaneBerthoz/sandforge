import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  WholeOrgSample,
  WholeOrgSampleBudget,
  WholeOrgSampleDropReason,
} from '@sandforge/shared';
import { drawWords, mbOf, percentOf, sampleNumber as n, wholeReasonWords } from './sampleWords';

/** What makes the bytes the sample may take: the share of what is left, the MB asked, the automation's room. */
function termsWords(t: TFunction, budget: WholeOrgSampleBudget): string {
  const terms: string[] = [];
  if (budget.limitedBy === 'within' && budget.withinMB !== undefined) {
    terms.push(t('forgeRun.wholeOrgDryRun.sample.terms.within', { within: n(budget.withinMB) }));
  } else if (budget.remainingMB !== undefined) {
    terms.push(
      t('forgeRun.wholeOrgDryRun.sample.terms.storage', {
        share: n(Math.round((budget.share ?? 0) * 100)),
        remaining: n(budget.remainingMB),
        rounding: n(budget.roundingMB ?? 0),
      }),
    );
  }
  if (budget.automationMB !== undefined && budget.automationMB > 0) {
    terms.push(
      t('forgeRun.wholeOrgDryRun.sample.terms.automation', { automation: n(budget.automationMB) }),
    );
  }
  return terms.join(', ');
}

/** The first bound that held the sample, as the sentence names it. */
function limitWords(
  t: TFunction,
  limitedBy: WholeOrgSampleBudget['limitedBy'],
  orgs: { source: string; target: string },
): string {
  return t(`forgeRun.wholeOrgDryRun.sample.limitedBy.${limitedBy}`, orgs);
}

/** Why a record the draw reached is left out, as the list says it. */
function dropWords(t: TFunction, reason: WholeOrgSampleDropReason): string {
  return t(`forgeRun.wholeOrgDryRun.sample.dropReason.${reason}`);
}

/** Props for {@link ForgeWholeOrgSample}. */
export interface ForgeWholeOrgSampleProps {
  sample: WholeOrgSample;
  /** The two orgs, as the user knows them. */
  source: string;
  target: string;
}

/**
 * What a simulation of a sample of the whole org drew, said before the rest
 * of its dry run, whose counts are then the plan's: the records it keeps of
 * the source and from how many objects, the share of each object's roots,
 * the seed and the draw; what it takes of the target against what it may
 * take, what gives that, and the first bound that held it; what it keeps of
 * each object and how each record came in — drawn, under a parent, as a
 * parent, or with the whole object —; the objects copied whole and why, the
 * children the cap left out, the objects none of whose records it keeps,
 * said apart and never as empty, the records set aside by id, those it
 * reached and leaves out by why, the lookups it writes empty, what drawing it
 * sent the source, and where its plan is kept for the run.
 */
export const ForgeWholeOrgSample: React.FC<ForgeWholeOrgSampleProps> = ({
  sample,
  source,
  target,
}) => {
  const { t } = useTranslation();
  const tableId = useId();
  const sourceRows =
    sample.objects.reduce((sum, object) => sum + object.sourceRows, 0) +
    sample.noRecordDrawn.reduce((sum, object) => sum + object.sourceRows, 0);
  const childrenCut = sample.objects.flatMap((object) =>
    (object.childrenCut ?? []).map(
      ({ field, rows }) => `${object.objectApiName}.${field} (${n(rows)})`,
    ),
  );
  const { budget } = sample;
  const terms = termsWords(t, budget);
  const facts: Array<{ id: string; text: string }> = [
    ...(sample.whole.length > 0
      ? [
          {
            id: 'whole',
            text: t('forgeRun.wholeOrgDryRun.sample.whole', {
              objects: sample.whole
                .map(({ objectApiName, why }) => `${objectApiName} (${wholeReasonWords(t, why)})`)
                .join(', '),
            }),
          },
        ]
      : []),
    ...(childrenCut.length > 0 && sample.children !== 'all'
      ? [
          {
            id: 'children-cut',
            text: t('forgeRun.wholeOrgDryRun.sample.childrenCut', {
              cap: n(sample.children),
              objects: childrenCut.join(', '),
            }),
          },
        ]
      : []),
    ...(sample.noRecordDrawn.length > 0
      ? [
          {
            id: 'no-record-drawn',
            text: t('forgeRun.wholeOrgDryRun.sample.noRecordDrawn', {
              source,
              objects: sample.noRecordDrawn
                .map(({ objectApiName, sourceRows: rows }) =>
                  t('forgeRun.wholeOrgDryRun.sample.inTheSource', {
                    object: objectApiName,
                    rows: n(rows),
                  }),
                )
                .join(', '),
            }),
          },
        ]
      : []),
    ...(sample.heavyRoots.length > 0
      ? [
          {
            id: 'heavy-roots',
            // Weighed against the target's room, the MB asked aside.
            text: t('forgeRun.wholeOrgDryRun.sample.heavyRoots', {
              target,
              records: sample.heavyRoots
                .map((root) =>
                  t('forgeRun.wholeOrgDryRun.sample.heavyRoot', {
                    object: root.objectApiName,
                    id: root.id,
                    rows: n(root.rows),
                    relation: `${root.relation.objectApiName}.${root.relation.field}`,
                  }),
                )
                .join(', '),
            }),
          },
        ]
      : []),
    ...(sample.dropped.length > 0
      ? [
          {
            id: 'dropped',
            text: t('forgeRun.wholeOrgDryRun.sample.dropped', {
              records: sample.dropped
                .map(({ objectApiName, rows, reason }) =>
                  t('forgeRun.wholeOrgDryRun.sample.droppedOf', {
                    rows: n(rows),
                    object: objectApiName,
                    reason: dropWords(t, reason),
                  }),
                )
                .join('; '),
            }),
          },
        ]
      : []),
    ...(sample.leftEmpty.length > 0
      ? [
          {
            id: 'left-empty',
            text: t('forgeRun.wholeOrgDryRun.sample.leftEmpty', {
              fields: sample.leftEmpty
                .map(({ objectApiName, field, rows }) => `${objectApiName}.${field} (${n(rows)})`)
                .join(', '),
            }),
          },
        ]
      : []),
    ...(sample.newestByIds && sample.newestByIds.length > 0
      ? [
          {
            id: 'newest-by-ids',
            text: t('forgeRun.wholeOrgDryRun.sample.newestByIds', {
              objects: sample.newestByIds.join(', '),
            }),
          },
        ]
      : []),
    {
      id: 'requests',
      text: t('forgeRun.wholeOrgDryRun.sample.requests', {
        requests: n(sample.planRequests.source),
        source,
      }),
    },
    {
      id: 'plan',
      text: t('forgeRun.wholeOrgDryRun.sample.plan', {
        path: sample.plan.path,
        sha: sample.plan.sha256.slice(0, 12),
      }),
    },
  ];

  return (
    <section
      data-testid="forge-whole-org-sample"
      aria-labelledby={`${tableId}-title`}
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-2 px-3 py-2"
    >
      <h4 id={`${tableId}-title`} className="text-xs font-semibold">
        {t('forgeRun.wholeOrgDryRun.sample.title')}
      </h4>
      <p data-testid="forge-whole-org-sample-kept">
        {t('forgeRun.wholeOrgDryRun.sample.kept', {
          kept: n(sample.rows),
          total: n(sourceRows),
          source,
          objects: n(sample.objects.length),
          share: percentOf(sample.share),
          seed: n(sample.seed),
          draw: drawWords(t, sample.draw),
        })}
      </p>
      <p data-testid="forge-whole-org-sample-taken">
        {budget.limitedBy === 'whole'
          ? t('forgeRun.wholeOrgDryRun.sample.takenWhole', {
              taken: mbOf(sample.storageBytes),
              mb: mbOf(budget.bytes),
              terms,
            })
          : t('forgeRun.wholeOrgDryRun.sample.taken', {
              taken: mbOf(sample.storageBytes),
              mb: mbOf(budget.bytes),
              // Held by its records alone, of a target that would not say
              // its storage: what held it says what it may take.
              terms: terms || limitWords(t, budget.limitedBy, { source, target }),
              limit: limitWords(t, budget.limitedBy, { source, target }),
            })}
      </p>
      {sample.objects.length > 0 && (
        // Hundreds of objects scroll within the box, which the keyboard
        // reaches to scroll it: no line of it is a control.
        <div
          role="region"
          aria-labelledby={`${tableId}-caption`}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the list of objects scrolls, and none of its rows is a control to reach it by: the region takes the focus itself, so the keyboard can scroll it.
          tabIndex={0}
          data-testid="forge-whole-org-sample-objects"
          className="max-h-72 overflow-y-auto rounded-md border border-subtle focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent)"
        >
          <table className="w-full text-left">
            <caption id={`${tableId}-caption`} className="px-2 py-1.5 text-left font-semibold">
              {t('forgeRun.wholeOrgDryRun.sample.byObject')}
            </caption>
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('forgeRun.wholeOrgDryRun.object')}
                </th>
                {(['inSource', 'kept', 'drawn', 'below', 'asParents'] as const).map((column) => (
                  <th key={column} scope="col" className="px-2 py-1 text-right font-medium">
                    {t(`forgeRun.wholeOrgDryRun.sample.column.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sample.objects.map((object) => (
                <tr key={object.objectApiName} className="border-t border-subtle">
                  <td className="px-2 py-1 font-mono">{object.objectApiName}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{n(object.sourceRows)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{n(object.kept)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {object.whole ? t('forgeRun.wholeOrgDryRun.sample.wholeCell') : n(object.roots)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {object.whole ? '' : n(object.below)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {object.whole ? '' : n(object.asParents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {facts.map((fact) => (
        <p
          key={fact.id}
          data-testid={`forge-whole-org-sample-${fact.id}`}
          className={fact.id === 'plan' ? 'break-all' : undefined}
        >
          {fact.text}
        </p>
      ))}
    </section>
  );
};
