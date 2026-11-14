import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useForgeStore, type MetadataDiffEntry } from '../../stores/useForgeStore';
import { Button } from '../../components/ui/Button';
import { withFieldExcluded } from '../../utils/forgeGapDecisions';
import { ReviewAdminCopy } from './ReviewAdminCopy';

/**
 * What the tab says of an object the user the clone writes as may not create,
 * by who may, as the target said: of a report, which no user creates, it said
 * to give that user Create on it.
 */
const NOT_CREATABLE_KEYS: Readonly<
  Record<NonNullable<MetadataDiffEntry['notCreatableBy']>, string>
> = {
  platform: 'forgeRun.review.objectNoUserCreates',
  setup: 'forgeRun.review.objectNoUserCreates',
  feature: 'forgeRun.review.objectFeatureOff',
  parent: 'forgeRun.review.objectThroughParent',
  user: 'forgeRun.review.objectNotCreateable',
};

/** CSS classes for severity badge variants. */
const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-status-info/10 text-status-info',
  warning: 'bg-status-warning/10 text-status-warning',
  error: 'bg-status-error/10 text-status-error',
};

/**
 * Each severity in the page's language: the badge said the code's English in
 * capitals, INFO, WARNING, ERROR, beside a sentence in French or Japanese.
 */
const SEVERITY_KEYS: Readonly<Record<MetadataDiffEntry['severity'], string>> = {
  info: 'forgeRun.review.metadata.severity.info',
  warning: 'forgeRun.review.metadata.severity.warning',
  error: 'forgeRun.review.metadata.severity.error',
};

/** The issues about a field, which the run can leave out of its object's rows. */
const FIELD_ISSUES: ReadonlySet<MetadataDiffEntry['issue']> = new Set([
  'missing',
  'type_mismatch',
  'permission_denied',
]);

/**
 * A difference in the page's language, by its code and what it carries: the
 * field's type in each org, the org that would not describe the object and
 * its own words. The extension's English sentence, which said all of it,
 * stays for a code the page does not word, or one without what it needs.
 */
function diffWords(t: TFunction, diff: MetadataDiffEntry): string {
  const named = { object: diff.objectApiName, field: diff.fieldApiName };
  switch (diff.issue) {
    case 'object_not_createable':
      return t(NOT_CREATABLE_KEYS[diff.notCreatableBy ?? 'user'], named);
    case 'missing':
      return t('forgeRun.review.metadata.missing', named);
    case 'permission_denied':
      return t('forgeRun.review.metadata.permissionDenied', named);
    case 'object_missing':
      return t('forgeRun.review.metadata.objectMissing', named);
    case 'type_mismatch':
      return diff.sourceType !== undefined && diff.targetType !== undefined
        ? t('forgeRun.review.metadata.typeMismatch', {
            ...named,
            sourceType: diff.sourceType,
            targetType: diff.targetType,
          })
        : diff.details;
    case 'unreadable':
      return diff.unreadIn !== undefined
        ? t(
            diff.unreadIn === 'source'
              ? 'forgeRun.review.metadata.unreadableSource'
              : 'forgeRun.review.metadata.unreadableTarget',
            { ...named, error: diff.orgError ?? '' },
          )
        : diff.details;
  }
}

/**
 * The changes to the target's Setup that would let what the tab lists go in,
 * as they are copied for its admin: Edit on a field the user may not set,
 * Create on an object they may not create, the feature an object comes with.
 * Empty when no difference asks a grant.
 */
function adminText(t: TFunction, diffs: readonly MetadataDiffEntry[]): string {
  const steps: string[] = [];
  for (const diff of diffs) {
    const named = { object: diff.objectApiName, field: diff.fieldApiName };
    if (diff.issue === 'permission_denied') {
      steps.push(t('forgeRun.review.metadata.admin.grantFieldEdit', named));
    } else if (diff.issue === 'object_not_createable') {
      if (diff.notCreatableBy === 'feature') {
        steps.push(t('forgeRun.gaps.admin.step.enableFeature', named));
      } else if (diff.notCreatableBy === undefined || diff.notCreatableBy === 'user') {
        steps.push(t('forgeRun.gaps.admin.step.grantCreate', named));
      }
    }
  }
  if (steps.length === 0) return '';
  return [t('forgeRun.gaps.admin.heading'), '', ...steps.map((step) => `- ${step}`)].join('\n');
}

/** Props for {@link ReviewMetadataTab}. */
export interface ReviewMetadataTabProps {
  /** True while ForgeReview's forge:metadata-diff:request is still in flight. */
  pending?: boolean;
  /** Message from forge:metadata-diff:error, when the comparison could not run. */
  error?: string | null;
  /** Compare the two orgs' schemas again: an object one of them would not describe. */
  onCompareAgain?: () => void;
}

/**
 * Metadata tab within the Forge Review phase.
 *
 * Shows a list of metadata differences (missing fields, type mismatches,
 * permission issues) between source and target orgs, each with a severity badge,
 * in the page's language, and what to do about it where the page does it: a
 * field left out of its object's rows, an object left out of the clone, a
 * comparison again of an object an org would not describe, and the grants to
 * copy for the target's admin. Each said what Execute does in English, and
 * the page offered nothing.
 *
 * The request itself lives in ForgeReview so it fires once per phase mount
 * rather than on every visit to this tab; the two props carry its outcome.
 */
export const ReviewMetadataTab: React.FC<ReviewMetadataTabProps> = ({
  pending = false,
  error = null,
  onCompareAgain,
}) => {
  const { t } = useTranslation();
  const diffs = useForgeStore((s) => s.metadataDiffs);
  const config = useForgeStore((s) => s.config);
  const graph = useForgeStore((s) => s.graph);
  const updateConfig = useForgeStore((s) => s.updateConfig);
  const setNodesIncluded = useForgeStore((s) => s.setNodesIncluded);
  const copied = useMemo(() => adminText(t, diffs), [t, diffs]);

  if (error) {
    return (
      <div data-testid="review-metadata-tab" className="py-4">
        <p data-testid="metadata-error" className="text-xs text-status-error text-center">
          {error}
        </p>
      </div>
    );
  }

  // An empty list means "not compared yet" until the response lands, so
  // claiming "no differences" while the diff is still running would be a lie.
  if (pending) {
    return (
      <div data-testid="review-metadata-tab" className="py-4">
        <p data-testid="metadata-loading" className="text-xs text-text-secondary text-center">
          {t('forgeRun.review.diffsLoading', 'Comparing metadata schemas...')}
        </p>
      </div>
    );
  }

  if (diffs.length === 0) {
    return (
      <div data-testid="review-metadata-tab" className="py-4">
        <p data-testid="no-diffs" className="text-xs text-text-secondary text-center">
          {t('forgeRun.review.noDiffs', 'No metadata differences detected.')}
        </p>
      </div>
    );
  }

  /** The action of a difference, where the page does one, or what it did. */
  const actionOf = (diff: MetadataDiffEntry, idx: number): React.ReactNode => {
    if (!config) return null;
    if (FIELD_ISSUES.has(diff.issue) && diff.fieldApiName !== '') {
      const ref = { object: diff.objectApiName, field: diff.fieldApiName };
      const out = (config.fieldExclusions?.[ref.object] ?? []).includes(ref.field);
      return (
        <span className="flex items-center gap-2">
          {out && (
            <span data-testid={`diff-${idx}-left-out`} className="text-text-secondary">
              {t('forgeRun.review.metadata.fieldLeftOut')}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            data-testid={`diff-${idx}-leave-field`}
            onClick={() => updateConfig((c) => withFieldExcluded(c, ref, !out))}
          >
            {t(
              out ? 'forgeRun.review.metadata.keepField' : 'forgeRun.review.metadata.leaveField',
              ref,
            )}
          </Button>
        </span>
      );
    }
    if (diff.issue === 'object_missing') {
      const node = graph?.nodes.find((n) => n.objectApiName === diff.objectApiName);
      if (!node) return null;
      return node.included ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid={`diff-${idx}-leave-object`}
          onClick={() => setNodesIncluded([diff.objectApiName], false)}
        >
          {t('forgeRun.review.metadata.leaveObject', { object: diff.objectApiName })}
        </Button>
      ) : (
        <span data-testid={`diff-${idx}-left-out`} className="text-text-secondary">
          {t('forgeRun.review.metadata.objectLeftOut')}
        </span>
      );
    }
    if (diff.issue === 'unreadable' && onCompareAgain) {
      return (
        <Button
          variant="secondary"
          size="sm"
          data-testid={`diff-${idx}-compare-again`}
          onClick={onCompareAgain}
        >
          {t('forgeRun.review.metadata.compareAgain')}
        </Button>
      );
    }
    return null;
  };

  return (
    <div data-testid="review-metadata-tab" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-secondary">
          {t('forgeRun.review.diffsFound', {
            defaultValue: '{{count}} differences found between source and target.',
            count: diffs.length,
          })}
        </p>
        {copied !== '' && <ReviewAdminCopy text={copied} testId="metadata-admin-copy" />}
      </div>
      {diffs.map((diff, idx) => {
        const action = actionOf(diff, idx);
        return (
          <div
            key={`diff-${idx}`}
            data-testid={`diff-${idx}`}
            className="rounded-sm border border-subtle p-2 text-xs"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-text-primary">
                {/* An entry about the object as a whole names no field. */}
                {diff.fieldApiName
                  ? `${diff.objectApiName}.${diff.fieldApiName}`
                  : diff.objectApiName}
              </span>
              <span
                className={`text-[9px] px-1.5 py-0.5 rounded-sm ${SEVERITY_STYLES[diff.severity]}`}
                data-testid={`diff-${idx}-severity`}
              >
                {t(SEVERITY_KEYS[diff.severity])}
              </span>
            </div>
            <p className="text-text-secondary text-[10px]">
              {/* Said in the interface language, with what Execute does about it. */}
              {diffWords(t, diff)}
            </p>
            {action && <div className="mt-1.5 flex flex-wrap items-center gap-2">{action}</div>}
          </div>
        );
      })}
    </div>
  );
};
