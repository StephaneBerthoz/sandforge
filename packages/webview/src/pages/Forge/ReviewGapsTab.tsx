import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  ForgeConfig,
  ForgeGap,
  ForgeGapDecisionKind,
  ForgeGapKind,
  ForgeGapSeverity,
  ForgeGapSource,
} from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeGapChoice, ForgeKeptDecision } from '../../utils/forgeGapDecisions';
import {
  aboutAValue,
  allowedValues,
  choiceOf,
  decisionOf,
  decisionsAnsweringNoGap,
  gapsToShow,
  isValueKind,
  objectsLeftOut,
  keptDecisionKey,
  offeredDecisions,
  targetRecordTypes,
  undecidedBlockingGaps,
} from '../../utils/forgeGapDecisions';
import { ReviewSaveTemplate } from './ReviewSaveTemplate';

/** The reads of the gaps, in the order the tab names them. */
const SOURCES: readonly ForgeGapSource[] = ['metadata', 'simulation', 'rehearsal'];

/** The severities, the gravest first, as the tab groups the gaps. */
const SEVERITIES: readonly ForgeGapSeverity[] = ['blocking', 'warning', 'info'];

/** How each severity's heading is marked. */
const SEVERITY_STYLES: Readonly<Record<ForgeGapSeverity, string>> = {
  blocking: 'bg-status-error/10 text-status-error',
  warning: 'bg-status-warning/10 text-status-warning',
  info: 'bg-status-info/10 text-status-info',
};

/** Detail entries the tab says in its own words, or uses for a decision. */
const DETAIL_KEYS: Readonly<Record<string, string>> = {
  allowedValues: 'forge.gaps.detail.allowedValues',
  allowed: 'forge.gaps.detail.allowedValues',
  targetRecordTypes: 'forge.gaps.detail.targetRecordTypes',
  mapTo: 'forge.gaps.detail.targetRecordTypes',
};

/** The select value that maps a record type to the object's default: no DeveloperName is. */
const DEFAULT_RECORD_TYPE = '*';

/**
 * How many gaps that will refuse rows no decision answers yet: the Gaps tab's
 * badge.
 */
export function useUndecidedBlockingGaps(): number {
  return useForgeStore((s) => undecidedBlockingGaps(s.gaps, s.config, s.graph));
}

/** What a gap's `value` is, as the tab says it. */
function valueLabel(t: TFunction, gap: ForgeGap): string | null {
  if (gap.value === undefined) return null;
  if (isValueKind(gap.kind)) return t('forge.gaps.value', { value: gap.value });
  switch (gap.kind) {
    case 'rehearsal_refusal':
      return t('forge.gaps.statusCode', { code: gap.value });
    case 'validation_rule':
    case 'duplicate_rule':
      return t('forge.gaps.rule', { name: gap.value });
    case 'record_type_unmapped':
    case 'record_type_unavailable':
      return t('forge.gaps.sourceRecordType', { name: gap.value });
    default:
      return t('forge.gaps.value', { value: gap.value });
  }
}

/** A detail entry's value, as text. */
function detailText(value: string | number | boolean | string[]): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** A chosen decision, as the tab says it. */
function choiceLabel(t: TFunction, gap: ForgeGap, choice: ForgeGapChoice): string {
  switch (choice.kind) {
    case 'map_value':
      return t('forge.gaps.chosen.mapValue', { to: choice.to });
    case 'leave_empty':
      return t(
        aboutAValue(gap)
          ? 'forge.gaps.chosen.leaveEmptyValue'
          : 'forge.gaps.chosen.leaveEmptyField',
      );
    case 'set_default':
      return t('forge.gaps.chosen.setDefault', { value: String(choice.value) });
    case 'truncate':
      return t('forge.gaps.chosen.truncate');
    case 'map_record_type':
      return choice.to === null
        ? t('forge.gaps.chosen.mapRecordTypeDefault')
        : t('forge.gaps.chosen.mapRecordType', { to: choice.to });
    case 'exclude_object':
      return t('forge.gaps.chosen.excludeObject', { object: gap.objectApiName });
    case 'ignore':
      return t('forge.gaps.chosen.ignore');
  }
}

/** A decision a config holds, as the list of those no gap names says it. */
function keptLabel(t: TFunction, kept: ForgeKeptDecision): string {
  switch (kept.kind) {
    case 'picklist': {
      const { object, field, recordType, from, to } = kept.entry;
      const scope = recordType ? t('forge.gaps.kept.scope', { name: recordType }) : '';
      return to === null
        ? t('forge.gaps.kept.picklistEmpty', { object, field, scope, from })
        : t('forge.gaps.kept.picklist', { object, field, scope, from, to });
    }
    case 'record_type': {
      const { object, from, to } = kept.entry;
      return to === null
        ? t('forge.gaps.kept.recordTypeDefault', { object, from })
        : t('forge.gaps.kept.recordType', { object, from, to });
    }
    case 'default':
      return t('forge.gaps.kept.default', { ...kept.entry, value: String(kept.entry.value) });
    case 'truncate':
      return t('forge.gaps.kept.truncate', { ...kept.entry });
    case 'field_excluded':
      return t('forge.gaps.kept.fieldExcluded', { ...kept.entry });
    case 'object_excluded':
      return t('forge.gaps.kept.objectExcluded', { object: kept.object });
    case 'ignored': {
      // An id is `kind|object|field|record type|value` (`forgeGapId`).
      const [kind = '', ...rest] = kept.gapId.split('|');
      const named = i18nKindKnown(kind) ? t(`forge.gaps.kind.${kind}`) : kind;
      const gap = [named, ...rest.filter((part) => part !== '')].join(' · ');
      return t('forge.gaps.kept.ignored', { gap });
    }
  }
}

/** Every kind of gap the shared contract names. */
const KINDS: ReadonlySet<string> = new Set<ForgeGapKind>([
  'picklist_value_refused',
  'dependent_value_invalid',
  'picklist_value_absent',
  'required_field_missing',
  'value_too_long',
  'number_out_of_range',
  'record_type_unmapped',
  'record_type_unavailable',
  'currency_inactive',
  'unique_value_collision',
  'lookup_filter',
  'validation_rule',
  'duplicate_rule',
  'api_budget',
  'rehearsal_refusal',
]);

/** Whether `kind` is one the catalogue names. */
function i18nKindKnown(kind: string): kind is ForgeGapKind {
  return KINDS.has(kind);
}

/** Props of {@link GapItem}. */
interface GapItemProps {
  gap: ForgeGap;
  config: ForgeConfig | null;
  decide: (gap: ForgeGap, choice: ForgeGapChoice | null) => void;
}

/**
 * One gap: what it is and where it was found, then the decisions it offers,
 * or the one taken and the way to take it back.
 */
const GapItem: React.FC<GapItemProps> = ({ gap, config, decide }) => {
  const { t } = useTranslation();
  const id = useId();
  const kept = decisionOf(config, gap);
  const chosen = kept ? choiceOf(kept) : null;
  const offered = offeredDecisions(gap);
  const [defaultValue, setDefaultValue] = useState('');
  const undoRef = useRef<HTMLButtonElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  /** Where the focus goes once the decision taken here shows: the controls it took away are gone. */
  const focusNext = useRef<'undo' | 'controls' | null>(null);
  const chosenKey = kept ? keptDecisionKey(kept) : '';

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'undo') undoRef.current?.focus();
    if (target === 'controls') controlsRef.current?.focus();
  }, [chosenKey]);

  const choose = (choice: ForgeGapChoice | null): void => {
    focusNext.current = choice ? 'undo' : 'controls';
    decide(gap, choice);
  };

  const subject = [
    gap.field ? `${gap.objectApiName}.${gap.field}` : gap.objectApiName,
    gap.recordType ? t('forge.gaps.recordType', { name: gap.recordType }) : null,
    valueLabel(t, gap),
  ].filter((part): part is string => part !== null);

  const details = Object.entries(gap.detail ?? {});
  const allowed = allowedValues(gap);
  const recordTypes = targetRecordTypes(gap);
  const decidedText = chosen ? choiceLabel(t, gap, chosen) : '';

  return (
    <li
      data-testid={`gap-${gap.id}`}
      className="flex flex-col gap-1 rounded-sm border border-subtle bg-surface-2 p-2 text-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-text-primary">{t(`forge.gaps.kind.${gap.kind}`)}</span>
        {gap.rows > 0 && (
          <span data-testid="gap-rows" className="shrink-0 text-text-secondary">
            {t('forge.gaps.rows', { count: gap.rows })}
          </span>
        )}
      </div>
      <p data-testid="gap-subject" className="text-text-primary">
        {subject.join(' · ')}
      </p>
      {/* What the read says of the gap, under the names it gives: the tab
          names in its own words the entries it knows. */}
      {details.length > 0 && (
        <dl
          data-testid="gap-detail"
          className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-text-secondary"
        >
          {details.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt>{key in DETAIL_KEYS ? t(DETAIL_KEYS[key]) : key}</dt>
              <dd className="text-text-primary">{detailText(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <p data-testid="gap-source" className="text-text-secondary">
        {t(`forge.gaps.source.${gap.source}`)}
      </p>
      {chosen ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p data-testid="gap-decided" className="font-medium text-text-primary">
            {t('forge.gaps.decided', { decision: decidedText })}
          </p>
          <Button
            ref={undoRef}
            variant="ghost"
            size="sm"
            data-testid="gap-undo"
            aria-label={t('forge.gaps.undoLabel', { decision: decidedText })}
            onClick={() => choose(null)}
          >
            {t('forge.gaps.undo')}
          </Button>
        </div>
      ) : (
        <>
          {gap.defaultDecision && (
            <p data-testid="gap-default" className="text-text-secondary">
              {t('forge.gaps.byDefault', {
                decision: t(`forge.gaps.decision.${gap.defaultDecision}`),
              })}
            </p>
          )}
          {offered.length > 0 && (
            <div
              ref={controlsRef}
              role="group"
              tabIndex={-1}
              aria-label={t('forge.gaps.decisionsLabel')}
              data-testid="gap-decisions"
              className="flex flex-wrap items-end gap-2 outline-hidden"
            >
              {offered.map((kind) => (
                <DecisionControl
                  key={kind}
                  kind={kind}
                  gap={gap}
                  idPrefix={id}
                  allowed={allowed}
                  recordTypes={recordTypes}
                  defaultValue={defaultValue}
                  setDefaultValue={setDefaultValue}
                  choose={choose}
                />
              ))}
            </div>
          )}
        </>
      )}
    </li>
  );
};

/** Props of {@link DecisionControl}. */
interface DecisionControlProps {
  kind: ForgeGapDecisionKind;
  gap: ForgeGap;
  idPrefix: string;
  allowed: string[];
  recordTypes: string[];
  defaultValue: string;
  setDefaultValue: (value: string) => void;
  choose: (choice: ForgeGapChoice) => void;
}

/** The control of one decision: a button, or a list to pick from, taken in one step. */
const DecisionControl: React.FC<DecisionControlProps> = ({
  kind,
  gap,
  idPrefix,
  allowed,
  recordTypes,
  defaultValue,
  setDefaultValue,
  choose,
}) => {
  const { t } = useTranslation();
  const selectClass = cn(
    'rounded-sm px-2 py-1 text-xs',
    'bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input)',
  );
  switch (kind) {
    case 'map_value':
      return (
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-map`} className="text-text-secondary">
            {t('forge.gaps.mapValueLabel')}
          </label>
          <select
            id={`${idPrefix}-map`}
            data-testid="gap-map-value"
            value=""
            onChange={(e) => {
              if (e.target.value) choose({ kind: 'map_value', to: e.target.value });
            }}
            className={selectClass}
          >
            <option value="">{t('forge.gaps.mapValuePlaceholder')}</option>
            {allowed.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      );
    case 'map_record_type':
      return (
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idPrefix}-rt`} className="text-text-secondary">
            {t('forge.gaps.recordTypeLabel')}
          </label>
          <select
            id={`${idPrefix}-rt`}
            data-testid="gap-map-record-type"
            value=""
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') return;
              choose({ kind: 'map_record_type', to: value === DEFAULT_RECORD_TYPE ? null : value });
            }}
            className={selectClass}
          >
            <option value="">{t('forge.gaps.recordTypePlaceholder')}</option>
            <option value={DEFAULT_RECORD_TYPE}>{t('forge.gaps.recordTypeDefault')}</option>
            {recordTypes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      );
    case 'set_default':
      return (
        <form
          className="flex items-end gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (defaultValue.trim() !== '') choose({ kind: 'set_default', value: defaultValue });
          }}
        >
          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idPrefix}-default`} className="text-text-secondary">
              {t('forge.gaps.defaultLabel')}
            </label>
            <input
              id={`${idPrefix}-default`}
              data-testid="gap-default-value"
              type="text"
              maxLength={1000}
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              className={selectClass}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            data-testid="gap-set-default"
            disabled={defaultValue.trim() === ''}
          >
            {t('forge.gaps.defaultSet')}
          </Button>
        </form>
      );
    case 'leave_empty':
      return (
        <Button
          variant="secondary"
          size="sm"
          data-testid="gap-leave-empty"
          onClick={() => choose({ kind: 'leave_empty' })}
        >
          {t(aboutAValue(gap) ? 'forge.gaps.leaveEmptyValue' : 'forge.gaps.leaveEmptyField')}
        </Button>
      );
    case 'truncate':
      return (
        <Button
          variant="secondary"
          size="sm"
          data-testid="gap-truncate"
          onClick={() => choose({ kind: 'truncate' })}
        >
          {t('forge.gaps.truncate')}
        </Button>
      );
    case 'exclude_object':
      return (
        <Button
          variant="secondary"
          size="sm"
          data-testid="gap-exclude-object"
          onClick={() => choose({ kind: 'exclude_object' })}
        >
          {t('forge.gaps.excludeObject', { object: gap.objectApiName })}
        </Button>
      );
    case 'ignore':
      return (
        <Button
          variant="ghost"
          size="sm"
          data-testid="gap-ignore"
          onClick={() => choose({ kind: 'ignore' })}
        >
          {t('forge.gaps.ignore')}
        </Button>
      );
    case 'skip_rows':
      return null;
  }
};

/**
 * Review's Gaps tab: what the target holds against the rows the run is about
 * to write, as its metadata, a simulation and a rehearsal found it, grouped by
 * how grave it is and by object, each gap with the decisions it offers.
 *
 * A decision is written into the run's config as it is taken, and read back
 * from it: the run Execute, Retry and Clone directly send carries it, a
 * template saved from here or from the results keeps it, and one brought back
 * shows as taken. The decisions the config holds that answer no gap shown are
 * listed below the gaps, where they can be taken back: the run applies them.
 * An object left out is one of them: its gaps refuse nothing, and go.
 */
export const ReviewGapsTab: React.FC = () => {
  const { t, i18n } = useTranslation();
  const gaps = useForgeStore((s) => s.gaps);
  const gapReads = useForgeStore((s) => s.gapReads);
  const config = useForgeStore((s) => s.config);
  const graph = useForgeStore((s) => s.graph);
  const decideGap = useForgeStore((s) => s.decideGap);
  const undoDecision = useForgeStore((s) => s.undoDecision);

  const shown = useMemo(
    () => gapsToShow(gaps, objectsLeftOut(config, graph)),
    [gaps, config, graph],
  );
  const read = SOURCES.filter((source) => gapReads[source] !== undefined);
  const unread = SOURCES.flatMap((source) =>
    (gapReads[source] ?? []).map((part) => ({ source, ...part })),
  );
  /** A part a read could not read, in the words the line of Review's read gives it. */
  const partLabel = (part: string): string => {
    const key = `forge.review.gapsRead.part.${part}`;
    return i18n.exists(key) ? t(key) : part;
  };
  const answeringNoGap = useMemo(() => decisionsAnsweringNoGap(config, shown), [config, shown]);

  // Leaving an object out takes its gaps off the tab, the control that did it
  // with them: the focus goes to the list where it can be taken back.
  const keptTitleRef = useRef<HTMLHeadingElement>(null);
  const focusKept = useRef(false);
  const decide = useCallback(
    (gap: ForgeGap, choice: ForgeGapChoice | null) => {
      focusKept.current = choice?.kind === 'exclude_object';
      decideGap(gap, choice);
    },
    [decideGap],
  );
  useEffect(() => {
    if (!focusKept.current) return;
    focusKept.current = false;
    keptTitleRef.current?.focus();
  });

  return (
    <div data-testid="review-gaps-tab" className="flex flex-col gap-3 text-xs">
      {shown.length === 0 && read.length === 0 && (
        <p data-testid="gaps-not-read" className="text-text-secondary">
          {t('forge.gaps.notRead')}
        </p>
      )}
      {read.length > 0 && (
        <p data-testid="gaps-read" className="text-text-secondary">
          {t('forge.gaps.readBy', {
            sources: read.map((source) => t(`forge.gaps.readName.${source}`)).join(', '),
          })}
        </p>
      )}
      {shown.length === 0 && read.length > 0 && (
        <p data-testid="gaps-none" className="text-text-primary">
          {t('forge.gaps.none')}
        </p>
      )}
      {unread.length > 0 && (
        <ul data-testid="gaps-unread" className="flex flex-col gap-0.5 text-status-warning">
          {/* A part can be unread more than once: the fields of two objects. */}
          {unread.map(({ source, part, reason }, index) => (
            <li key={`${source}-${part}-${String(index)}`}>
              {t('forge.gaps.unread', {
                read: t(`forge.gaps.readName.${source}`),
                part: partLabel(part),
                reason,
              })}
            </li>
          ))}
        </ul>
      )}
      {SEVERITIES.map((severity) => {
        const ofSeverity = shown.filter((gap) => gap.severity === severity);
        if (ofSeverity.length === 0) return null;
        const objects = [...new Set(ofSeverity.map((gap) => gap.objectApiName))];
        return (
          <section
            key={severity}
            data-testid={`gaps-severity-${severity}`}
            aria-labelledby={`gaps-severity-${severity}-title`}
            className="flex flex-col gap-2"
          >
            <h3
              id={`gaps-severity-${severity}-title`}
              className={cn(
                'self-start rounded-sm px-1.5 py-0.5 font-semibold',
                SEVERITY_STYLES[severity],
              )}
            >
              {t(`forge.gaps.severity.${severity}`)} ({ofSeverity.length})
            </h3>
            {objects.map((object) => (
              <div
                key={object}
                data-testid={`gaps-object-${object}`}
                className="flex flex-col gap-1"
              >
                <h4 className="font-medium text-text-primary">{object}</h4>
                <ul className="flex flex-col gap-1">
                  {ofSeverity
                    .filter((gap) => gap.objectApiName === object)
                    .map((gap) => (
                      <GapItem key={gap.id} gap={gap} config={config} decide={decide} />
                    ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
      {answeringNoGap.length > 0 && (
        <section
          data-testid="gaps-kept-decisions"
          aria-labelledby="gaps-kept-title"
          className="flex flex-col gap-1 border-t border-subtle pt-2"
        >
          <h3
            ref={keptTitleRef}
            id="gaps-kept-title"
            tabIndex={-1}
            className="font-semibold text-text-primary outline-hidden"
          >
            {t('forge.gaps.kept.title')}
          </h3>
          <p className="text-text-secondary">{t('forge.gaps.kept.hint')}</p>
          <ul className="flex flex-col gap-1">
            {answeringNoGap.map((kept) => {
              const label = keptLabel(t, kept);
              return (
                <li
                  key={keptDecisionKey(kept)}
                  data-testid={`gaps-kept-${keptDecisionKey(kept)}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-text-primary">{label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="gaps-kept-undo"
                    aria-label={t('forge.gaps.undoLabel', { decision: label })}
                    onClick={() => undoDecision(kept)}
                  >
                    {t('forge.gaps.undo')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <ReviewSaveTemplate />
    </div>
  );
};
