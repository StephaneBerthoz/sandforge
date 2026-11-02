import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AutopilotCannotFit,
  AutopilotFitEmptied,
  AutopilotFitMode,
  AutopilotFitObject,
  AutopilotFitReport,
  AutopilotPlanWriteGate,
  StorageRoomNotCounted,
} from '@sandforge/shared';
import { SEED_MAX_RECORDS_PER_OBJECT } from '@sandforge/shared';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { formatNumber, uiLocale } from '../../../utils/formatters';

/*
 * Fit to storage, on the review step: what the plan comes to against its
 * target before Run, the panel that asks for a fit, and what the fit kept.
 *
 * A plan of a client sandbox's accounts and contacts came to 64.5 MB for the
 * 22 MB it had left: the review said nothing of it, the run was refused at
 * Run with "narrow the selection", and nothing could be narrowed within a
 * table copied whole. Every figure here is the extension's: the page computes
 * none, and words what the fit measured.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const VERDICTS: readonly string[] = ['fits', 'near', 'exceeds', 'unread'];
const API_VERDICTS: readonly string[] = ['fits', 'near', 'exceeds'];

/**
 * Whether what a run's refusal carries as its `writeGate` is what the
 * extension says of a plan against its target (`AutopilotPlanWriteGate`),
 * every part the review reads and of its kind: an extension of another
 * version is left unshown rather than shown in part.
 */
export function isAutopilotPlanWriteGate(value: unknown): value is AutopilotPlanWriteGate {
  if (!isRecord(value)) return false;
  const { apiRequests } = value;
  return (
    isNumber(value.records) &&
    isNumber(value.estimateMB) &&
    typeof value.verdict === 'string' &&
    VERDICTS.includes(value.verdict) &&
    (value.verdict === 'unread'
      ? value.unread === undefined || typeof value.unread === 'string'
      : isNumber(value.remainingMB) && isNumber(value.maxMB)) &&
    (apiRequests === undefined ||
      (isRecord(apiRequests) &&
        isNumber(apiRequests.estimate) &&
        isNumber(apiRequests.remaining) &&
        isNumber(apiRequests.max) &&
        typeof apiRequests.verdict === 'string' &&
        API_VERDICTS.includes(apiRequests.verdict)))
  );
}

/** Megabytes as the extension says them: rounded up, two decimals under 10 MB. */
function megabytes(value: number): string {
  if (value <= 0) return '0';
  const factor = value < 10 ? 100 : 10;
  return formatNumber(Math.ceil(value * factor - 1e-9) / factor);
}

/** A share, as a percentage rounded down to a tenth: never more than was kept. */
function percent(share: number): string {
  return new Intl.NumberFormat(uiLocale(), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(Math.floor(share * 1000) / 1000);
}

/** What a part of the target's automation the room leaves out is, as the panel names it. */
const NOT_COUNTED_KEYS: Readonly<Record<StorageRoomNotCounted['kind'], string>> = {
  trigger: 'autopilot.fit.notCountedTrigger',
  notRead: 'autopilot.fit.notCountedNotRead',
  share: 'autopilot.fit.notCountedShare',
};

/** Why a lookup a fit leaves empty is empty, as the panel says it. */
const EMPTIED_KEYS: Readonly<Record<AutopilotFitEmptied['why'], string>> = {
  selfReference: 'autopilot.fit.emptiedSelf',
  owed: 'autopilot.fit.emptiedOwed',
  onParent: 'autopilot.fit.emptiedOnParent',
};

/** Props for {@link AutopilotPlanStorage}. */
export interface AutopilotPlanStorageProps {
  writeGate: AutopilotPlanWriteGate;
  /** The target, as the panel names it. */
  org: string;
  testId: string;
}

/**
 * What the plan comes to against what its target has left, before Run: the
 * data storage its records take and, when they run short, the day's API
 * requests its writes take; refused past either, asked about near it.
 */
export const AutopilotPlanStorage: React.FC<AutopilotPlanStorageProps> = ({
  writeGate,
  org,
  testId,
}) => {
  const { t } = useTranslation();
  const estimate = megabytes(writeGate.estimateMB);
  const figures = {
    estimate,
    org,
    remaining: formatNumber(writeGate.remainingMB ?? 0),
    max: formatNumber(writeGate.maxMB ?? 0),
  };
  let storage: string;
  switch (writeGate.verdict) {
    case 'exceeds':
      storage = t('autopilot.fit.storageExceeds', figures);
      break;
    case 'near':
      storage = t('autopilot.fit.storageNear', figures);
      break;
    case 'fits':
      storage = t('autopilot.fit.storageFits', figures);
      break;
    default:
      storage = t('autopilot.fit.storageUnread', {
        estimate,
        org,
        reason: writeGate.unread ?? '',
      });
  }
  const api = writeGate.apiRequests;
  const requests =
    api && api.verdict !== 'fits'
      ? t(
          api.verdict === 'exceeds'
            ? 'autopilot.fit.requestsExceeds'
            : 'autopilot.fit.requestsNear',
          {
            estimate: formatNumber(api.estimate),
            remaining: formatNumber(api.remaining),
            max: formatNumber(api.max),
            org,
          },
        )
      : undefined;
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid={testId}>
      <p
        className={writeGate.verdict === 'exceeds' ? 'text-status-error' : 'text-text-primary'}
        data-testid={`${testId}-storage`}
      >
        {storage}
      </p>
      {requests && (
        <p
          className={api?.verdict === 'exceeds' ? 'text-status-error' : 'text-text-primary'}
          data-testid={`${testId}-requests`}
        >
          {requests}
        </p>
      )}
    </div>
  );
};

/** The words of a fit that proposed nothing: the plan fits as it is, or why nothing fits. */
export function fitNotAppliedWords(
  report: Pick<AutopilotFitReport, 'records' | 'estimateMB' | 'cannotFit'>,
  org: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const { cannotFit } = report;
  if (cannotFit === undefined) {
    return t('autopilot.fit.whole', {
      org,
      records: formatNumber(report.records),
      estimate: megabytes(report.estimateMB),
    });
  }
  return cannotFitWords(cannotFit, org, t);
}

/** Why nothing fits, from the figures the fit measured. */
function cannotFitWords(
  cannotFit: AutopilotCannotFit,
  org: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (cannotFit.why) {
    case 'sourceChanged':
      return t('autopilot.fit.cannotSourceChanged');
    case 'rounds':
      return t('autopilot.fit.cannotRounds');
    case 'capNotSelected':
      return t('autopilot.fit.cannotCapNotSelected', { object: cannotFit.object });
    default: {
      const { over } = cannotFit;
      const least = cannotFit.why === 'least';
      if (over.bound === 'storage') {
        return t(least ? 'autopilot.fit.cannotLeastStorage' : 'autopilot.fit.cannotCapsStorage', {
          takes: megabytes(over.takesMB),
          fits: megabytes(over.fitsMB),
          org,
        });
      }
      if (over.bound === 'apiRequests') {
        return t(least ? 'autopilot.fit.cannotLeastRequests' : 'autopilot.fit.cannotCapsRequests', {
          requests: formatNumber(over.requests),
          allowed: formatNumber(over.allowed),
          org,
        });
      }
      return t(least ? 'autopilot.fit.cannotLeastRecords' : 'autopilot.fit.cannotCapsRecords', {
        records: formatNumber(over.records),
        allowed: formatNumber(over.allowed),
      });
    }
  }
}

/** What each cut of an object came to, as the panel lists it. */
function CutDetails({ object }: { object: AutopilotFitObject }): React.ReactElement | null {
  const { t } = useTranslation();
  const lines = [
    ...object.cutWithParent.map(({ field, parent, count: cut }) => ({
      key: `${field}>${parent}`,
      text: t('autopilot.fit.cutWithParent', { records: formatNumber(cut), parent, field }),
    })),
    ...(object.cutSpread > 0
      ? [
          {
            key: 'spread',
            text: t('autopilot.fit.cutSpread', { records: formatNumber(object.cutSpread) }),
          },
        ]
      : []),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-text-secondary">
      {lines.map((line) => (
        <li key={line.key}>{line.text}</li>
      ))}
    </ul>
  );
}

/** Props for {@link AutopilotFitReportView}. */
export interface AutopilotFitReportViewProps {
  report: AutopilotFitReport;
  /** The target, as the panel names it. */
  org: string;
  /** Whether the run is set to mute the target's automation. */
  muted: boolean;
  onUndo: () => void;
  undoing: boolean;
  /** Whether Undo is to wait: a run or a plan is under way. */
  disabled?: boolean;
  testId: string;
}

/**
 * What a fit kept: the share and what held it, with its terms; the room kept
 * for what the target's flows still running create, or that their automation
 * could not be read, and what the room leaves out; each selected object's
 * records in the source and kept, and why the rest was cut; the parents the
 * kept records name; the lookups left empty; what the plan comes to. Undo
 * fit goes back to the plan it was fitted from.
 */
export const AutopilotFitReportView = React.forwardRef<
  HTMLHeadingElement,
  AutopilotFitReportViewProps
>(({ report, org, muted, onUndo, undoing, disabled = false, testId }, headingRef) => {
  const { t } = useTranslation();
  const headingId = useId();
  const { budget } = report;
  const fits = megabytes(budget.budgetMB + budget.automationMB);

  let bound: string;
  switch (report.heldBy) {
    case 'within':
      bound = t('autopilot.fit.boundWithin', {
        fits: megabytes(budget.withinMB ?? budget.budgetMB + budget.automationMB),
      });
      break;
    case 'apiRequests':
      bound = t('autopilot.fit.boundRequests', { org });
      break;
    case 'maxTotal':
      bound = t('autopilot.fit.boundMaxTotal', { max: formatNumber(report.maxTotal ?? 0) });
      break;
    case 'caps':
      bound = t('autopilot.fit.boundCaps', { fits });
      break;
    default:
      bound = t('autopilot.fit.boundStorage', {
        fits,
        near: percent(budget.share),
        remaining: formatNumber(budget.remainingMB),
        max: formatNumber(budget.maxMB),
        rounding: formatNumber(budget.roundingMB),
        org,
      });
  }

  let room: string;
  if (report.automationUnread !== undefined) {
    room = t('autopilot.fit.roomUnread', { org, reason: report.automationUnread });
  } else if (budget.automationMB > 0) {
    room = t('autopilot.fit.roomKept', { room: megabytes(budget.automationMB), org });
  } else {
    room = t(report.countedMuted ? 'autopilot.fit.roomNoneMuted' : 'autopilot.fit.roomNone', {
      org,
    });
  }

  const notCounted = budget.notCounted ?? [];
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 text-xs text-text-primary"
      data-testid={testId}
    >
      <h4 id={headingId} ref={headingRef} tabIndex={-1} className="text-xs font-semibold">
        {t('autopilot.fit.reportTitle', { org })}
      </h4>
      {report.share !== undefined && (
        <p data-testid={`${testId}-share`}>
          {t('autopilot.fit.share', { share: percent(report.share) })}
        </p>
      )}
      <p data-testid={`${testId}-bound`}>{bound}</p>
      <p data-testid={`${testId}-room`}>{room}</p>
      {/* The room was counted for the run as it was set then: unticked since,
          what the mute would have kept quiet writes outside what was kept. */}
      {(report.countedMuted === true) !== muted && (
        <p className="text-status-warning" data-testid={`${testId}-mute-changed`}>
          {t('autopilot.fit.muteChanged', { org })}
        </p>
      )}
      {notCounted.length > 0 && (
        <ul className="flex flex-col gap-0.5" data-testid={`${testId}-not-counted`}>
          {notCounted.map((entry) => (
            <li key={`${entry.objectApiName}-${entry.kind}-${entry.name}`}>
              {t(NOT_COUNTED_KEYS[entry.kind], {
                name:
                  entry.kind === 'notRead' ? t('common.quoted', { name: entry.name }) : entry.name,
                object: entry.objectApiName,
              })}
            </li>
          ))}
        </ul>
      )}

      <div className="max-h-64 overflow-auto">
        <table className="w-full border-collapse text-xs" data-testid={`${testId}-objects`}>
          <caption className="sr-only">{t('autopilot.fit.caption')}</caption>
          <thead>
            <tr>
              <th scope="col" className="px-1 pb-1 text-left font-medium text-text-secondary">
                {t('common.object')}
              </th>
              <th scope="col" className="px-1 pb-1 text-right font-medium text-text-secondary">
                {t('autopilot.fit.inSource')}
              </th>
              <th scope="col" className="px-1 pb-1 text-right font-medium text-text-secondary">
                {t('autopilot.fit.kept')}
              </th>
              <th scope="col" className="px-1 pb-1 text-left font-medium text-text-secondary">
                {t('autopilot.fit.cut')}
              </th>
            </tr>
          </thead>
          <tbody>
            {report.objects.map((object) => (
              <tr
                key={object.objectApiName}
                className="border-t border-(--sf-border) align-top"
                data-testid={`${testId}-object-${object.objectApiName}`}
              >
                <th scope="row" className="px-1 py-1 text-left font-normal">
                  {object.objectApiName}
                </th>
                <td className="px-1 py-1 text-right tabular-nums">
                  {formatNumber(object.inSource)}
                </td>
                <td className="px-1 py-1 text-right font-semibold tabular-nums">
                  {formatNumber(object.kept)}
                </td>
                <td className="px-1 py-1">
                  <CutDetails object={object} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.parents.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span>{t('autopilot.fit.parents')}</span>
          <ul className="flex flex-col gap-0.5 pl-3" data-testid={`${testId}-parents`}>
            {report.parents.map((parent) => (
              <li key={parent.objectApiName}>
                {parent.objectApiName}: {formatNumber(parent.records)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.emptied.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span>{t('autopilot.fit.emptiedTitle')}</span>
          <ul className="flex flex-col gap-0.5 pl-3" data-testid={`${testId}-emptied`}>
            {report.emptied.map((entry) => (
              <li key={`${entry.objectApiName}.${entry.field}-${entry.why}`}>
                {t(EMPTIED_KEYS[entry.why], {
                  object: entry.objectApiName,
                  field: entry.field,
                  records: formatNumber(entry.count),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p data-testid={`${testId}-total`}>
        {t(budget.automationMB > 0 ? 'autopilot.fit.totalWithRoom' : 'autopilot.fit.total', {
          records: formatNumber(report.records),
          estimate: megabytes(report.estimateMB),
          room: megabytes(budget.automationMB),
          requests: formatNumber(report.requestsRead),
        })}
      </p>
      <p className="text-text-secondary" data-testid={`${testId}-counted`}>
        {t('autopilot.fit.counted', { org })}
      </p>
      <p className="text-text-secondary" data-testid={`${testId}-gate-again`}>
        {t('autopilot.fit.gateAgain', { org })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onUndo}
          loading={undoing}
          disabled={undoing || disabled}
          data-testid={`${testId}-undo`}
        >
          {t('autopilot.fit.undo')}
        </Button>
      </div>
    </section>
  );
});
AutopilotFitReportView.displayName = 'AutopilotFitReportView';

/** What a cap field holds: empty, or a whole number of records within the bounds a fit takes. */
function capOf(value: string): number | 'empty' | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number(trimmed);
  return n >= 1 && n <= SEED_MAX_RECORDS_PER_OBJECT ? n : 'invalid';
}

/** The most MB a fit may be asked to stay within. */
const MOST_MB = 1_000_000;

/** Props for {@link AutopilotFitForm}. */
interface AutopilotFitFormProps {
  id: string;
  org: string;
  selectedObjects: readonly string[];
  fitting: boolean;
  /** What the last fit came to when it fitted nothing; null otherwise. */
  notApplied: AutopilotFitReport | null;
  onFit: (mode: AutopilotFitMode) => void;
  onClose: () => void;
  testId: string;
}

/** The panel that asks for a fit: by share or by caps per object, within so many MB. */
function AutopilotFitForm({
  id,
  org,
  selectedObjects,
  fitting,
  notApplied,
  onFit,
  onClose,
  testId,
}: AutopilotFitFormProps): React.ReactElement {
  const { t } = useTranslation();
  const headingId = useId();
  const withinId = useId();
  const withinHintId = useId();
  const [by, setBy] = useState<'share' | 'caps'>('share');
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [thenShare, setThenShare] = useState(false);
  const [within, setWithin] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const submit = (): void => {
    const withinMB = within.trim() === '' ? undefined : Number(within.trim().replace(',', '.'));
    if (
      withinMB !== undefined &&
      !(Number.isFinite(withinMB) && withinMB > 0 && withinMB <= MOST_MB)
    ) {
      setInvalid(t('autopilot.fit.invalidWithin'));
      return;
    }
    const bound = withinMB !== undefined ? { withinMB } : {};
    if (by === 'share') {
      setInvalid(null);
      onFit({ share: true, ...bound });
      return;
    }
    const asked: Record<string, number> = {};
    for (const name of selectedObjects) {
      const cap = capOf(caps[name] ?? '');
      if (cap === 'invalid') {
        setInvalid(t('autopilot.fit.invalidCap', { object: name }));
        return;
      }
      if (cap !== 'empty') asked[name] = cap;
    }
    if (Object.keys(asked).length === 0) {
      setInvalid(t('autopilot.fit.noCap'));
      return;
    }
    setInvalid(null);
    onFit({ caps: asked, ...(thenShare ? { share: true as const } : {}), ...bound });
  };

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-sm border border-(--sf-border) bg-surface-1 p-2 text-xs text-text-primary"
      data-testid={testId}
    >
      <h4 id={headingId} ref={heading} tabIndex={-1} className="text-xs font-semibold">
        {t('autopilot.fit.formTitle', { org })}
      </h4>
      <p className="text-text-secondary">{t('autopilot.fit.intro')}</p>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium">{t('autopilot.fit.modeLegend')}</legend>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`${id}-by`}
            checked={by === 'share'}
            onChange={() => setBy('share')}
            className="mt-0.5 accent-(--sf-accent)"
            data-testid={`${testId}-share`}
          />
          {t('autopilot.fit.modeShare')}
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={`${id}-by`}
            checked={by === 'caps'}
            onChange={() => setBy('caps')}
            className="mt-0.5 accent-(--sf-accent)"
            data-testid={`${testId}-caps`}
          />
          {t('autopilot.fit.modeCaps')}
        </label>
      </fieldset>
      {by === 'caps' && (
        <div className="flex flex-col gap-1 pl-5" data-testid={`${testId}-cap-fields`}>
          {selectedObjects.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-40 truncate" aria-hidden="true">
                {name}
              </span>
              <Input
                type="text"
                inputMode="numeric"
                aria-label={t('autopilot.fit.capLabel', { object: name })}
                value={caps[name] ?? ''}
                onChange={(e) => setCaps((before) => ({ ...before, [name]: e.target.value }))}
                className="w-28"
                data-testid={`${testId}-cap-${name}`}
              />
            </div>
          ))}
          <p className="text-text-secondary">{t('autopilot.fit.capsHint')}</p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={thenShare}
              onChange={(e) => setThenShare(e.target.checked)}
              className="mt-0.5 accent-(--sf-accent)"
              data-testid={`${testId}-then-share`}
            />
            {t('autopilot.fit.capsThenShare')}
          </label>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={withinId} className="font-medium">
          {t('autopilot.fit.withinLabel')}
        </label>
        <Input
          id={withinId}
          type="text"
          inputMode="decimal"
          value={within}
          onChange={(e) => setWithin(e.target.value)}
          aria-describedby={withinHintId}
          className="w-28"
          data-testid={`${testId}-within`}
        />
        <p id={withinHintId} className="text-text-secondary">
          {t('autopilot.fit.withinHint', { org })}
        </p>
      </div>
      {invalid && (
        <p role="alert" className="text-status-error" data-testid={`${testId}-invalid`}>
          {invalid}
        </p>
      )}
      {fitting && (
        <p role="status" className="text-text-secondary" data-testid={`${testId}-fitting`}>
          {t('autopilot.fit.fitting')}
        </p>
      )}
      {notApplied && !fitting && (
        <p role="status" data-testid={`${testId}-not-applied`}>
          {fitNotAppliedWords(notApplied, org, t)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          loading={fitting}
          disabled={fitting}
          data-testid={`${testId}-submit`}
        >
          {t('autopilot.fit.fit')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onClose}
          disabled={fitting}
          data-testid={`${testId}-close`}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Props for {@link AutopilotFitSection}. */
export interface AutopilotFitSectionProps {
  /** The target, as the panel names it. */
  org: string;
  selectedObjects: readonly string[];
  /** What the plan comes to against the target, as its `/limits` said it. */
  writeGate?: AutopilotPlanWriteGate | null;
  /** What the fit of the plan under review kept, when it was fitted. */
  fitted?: AutopilotFitReport;
  /** What the last fit came to when it fitted nothing; null otherwise. */
  notApplied?: AutopilotFitReport | null;
  /** Whether the run is set to mute the target's automation. */
  muted: boolean;
  fitting: boolean;
  undoing: boolean;
  /** Why the last fit or undo was refused, in the interface language. */
  error?: string | null;
  /** Whether nothing may be asked now: a run or a plan is under way. */
  disabled?: boolean;
  onFit: (mode: AutopilotFitMode) => void;
  onUndo: () => void;
  /** The panel opened: what the last fit answered is no longer said. */
  onOpen?: () => void;
  testId?: string;
}

/**
 * The review's data storage: what the plan comes to against its target, and
 * "Fit to storage…", which opens the panel; once fitted, what the fit kept and
 * Undo fit. A fit is asked, shown and taken by a gesture: nothing is fitted
 * unasked, and Run holds the plan fitted to its gate again.
 */
export const AutopilotFitSection: React.FC<AutopilotFitSectionProps> = ({
  org,
  selectedObjects,
  writeGate,
  fitted,
  notApplied = null,
  muted,
  fitting,
  undoing,
  error,
  disabled = false,
  onFit,
  onUndo,
  onOpen,
  testId = 'step4-fit',
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const report = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  // A fit taken closes the panel, whose button had the keyboard: what it
  // kept takes it.
  const fittedBefore = useRef(fitted);
  useEffect(() => {
    const before = fittedBefore.current;
    fittedBefore.current = fitted;
    if (fitted !== undefined && fitted !== before) {
      setOpen(false);
      report.current?.focus();
    }
    // Undo fit leaves with the report: the keyboard goes to what fits again.
    if (fitted === undefined && before !== undefined) opener.current?.focus();
  }, [fitted]);

  if (!writeGate && !fitted) return null;
  const canFit = writeGate?.verdict !== 'unread';
  const pressing =
    writeGate?.verdict === 'exceeds' || writeGate?.apiRequests?.verdict === 'exceeds';

  const close = (): void => {
    setOpen(false);
    // The button the panel replaced comes back where the keyboard was.
    requestAnimationFrame(() => opener.current?.focus());
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 p-3 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)"
      data-testid={testId}
    >
      <h3 id={headingId} className="text-sm font-medium text-text-primary">
        {t('autopilot.fit.storageTitle')}
      </h3>
      {writeGate && (
        <AutopilotPlanStorage writeGate={writeGate} org={org} testId={`${testId}-plan`} />
      )}
      {fitted && (
        <AutopilotFitReportView
          ref={report}
          report={fitted}
          org={org}
          muted={muted}
          onUndo={onUndo}
          undoing={undoing}
          disabled={disabled || fitting}
          testId={`${testId}-report`}
        />
      )}
      {open ? (
        <AutopilotFitForm
          id={panelId}
          org={org}
          selectedObjects={selectedObjects}
          fitting={fitting}
          notApplied={notApplied}
          onFit={onFit}
          onClose={close}
          testId={`${testId}-panel`}
        />
      ) : (
        canFit && (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={opener}
              variant={pressing && !fitted ? 'primary' : 'secondary'}
              size="sm"
              disabled={disabled || undoing}
              onClick={() => {
                onOpen?.();
                setOpen(true);
              }}
              data-testid={`${testId}-open`}
            >
              {fitted ? t('autopilot.fit.refit') : t('autopilot.fit.open')}
            </Button>
          </div>
        )
      )}
      {error && (
        <p role="alert" className="text-xs text-status-error" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
    </section>
  );
};

/** Props for {@link AutopilotFitResultLine}. */
export interface AutopilotFitResultLineProps {
  report: AutopilotFitReport;
  /** The target, as the panel names it. */
  org: string;
  /** Records read that came to name one the fit cut, held back with it; absent when none. */
  cutSinceFit?: number;
  testId: string;
}

/**
 * What a run's result says of the fit its plan came from: the records of the
 * selected objects it set out to copy of those the source holds, and the
 * share; and the records held back since the fit, read naming one it cut.
 */
export const AutopilotFitResultLine: React.FC<AutopilotFitResultLineProps> = ({
  report,
  org,
  cutSinceFit,
  testId,
}) => {
  const { t } = useTranslation();
  const before = report.objects.reduce((sum, object) => sum + object.inSource, 0);
  const after = report.objects.reduce((sum, object) => sum + object.kept, 0);
  const figures = { org, after: formatNumber(after), before: formatNumber(before) };
  return (
    <div className="flex flex-col gap-0.5 text-xs text-text-primary" data-testid={testId}>
      <p>
        {report.share !== undefined
          ? t('autopilot.fit.fitted', { ...figures, share: percent(report.share) })
          : t('autopilot.fit.fittedCaps', figures)}
      </p>
      {(cutSinceFit ?? 0) > 0 && (
        <p data-testid={`${testId}-cut-since`}>
          {t('autopilot.fit.cutSinceFit', { records: formatNumber(cutSinceFit ?? 0) })}
        </p>
      )}
    </div>
  );
};

/** Props for {@link AutopilotNodeFit}. */
export interface AutopilotNodeFitProps {
  objectApiName: string;
  /** The fit of the plan the run ran, when it was fitted. */
  report?: AutopilotFitReport;
  /** Of the node, the records held back since the fit; absent when none. */
  cutSinceFit?: number;
}

/**
 * What a node says of the fit: a selected object, what it kept of the source
 * and why the rest was cut; a parent, that its records are those the kept
 * ones name; either, the records held back since the fit.
 */
export const AutopilotNodeFit: React.FC<AutopilotNodeFitProps> = ({
  objectApiName,
  report,
  cutSinceFit,
}) => {
  const { t } = useTranslation();
  const object = report?.objects.find((o) => o.objectApiName === objectApiName);
  const parent = report?.parents.find((p) => p.objectApiName === objectApiName);
  const since = cutSinceFit ?? 0;
  if (!object && !parent && since === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid="node-fit">
      <span className="text-text-secondary">{t('autopilot.fit.nodeTitle')}</span>
      {object && (
        <>
          <span className="font-medium text-text-primary" data-testid="node-fit-kept">
            {t('autopilot.fit.nodeKept', {
              kept: formatNumber(object.kept),
              inSource: formatNumber(object.inSource),
            })}
          </span>
          <CutDetails object={object} />
        </>
      )}
      {!object && parent && (
        <span className="text-text-primary" data-testid="node-fit-parent">
          {t('autopilot.fit.nodeParent', { records: formatNumber(parent.records) })}
        </span>
      )}
      {since > 0 && (
        <span className="text-text-primary" data-testid="node-fit-cut-since">
          {t('autopilot.fit.cutSinceFit', { records: formatNumber(since) })}
        </span>
      )}
    </div>
  );
};
