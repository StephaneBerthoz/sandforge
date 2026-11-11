import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from 'framer-motion';
import { ShieldAlert, X } from 'lucide-react';
import {
  FORGE_READ_CEILING_PER_OBJECT,
  type ForgeRunGateCode,
  type ForgeRunGateStop,
} from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';
import { useForgeStore } from '../../stores/useForgeStore';
import { clonesWholeOrg } from './forgeRunConfig';
import { useForgeRunGateStore } from './runGate';

/** The sentence each stop is said in. */
const STOP_KEYS: Record<ForgeRunGateCode, string> = {
  PRODUCTION_TARGET: 'forgeRun.gate.productionTarget',
  AUTOMATION_DECLINED: 'forgeRun.gate.automationDeclined',
  READ_DECLINED: 'forgeRun.gate.readDeclined',
  WRITE_DECLINED: 'forgeRun.gate.writeDeclined',
  STORAGE_EXCEEDED: 'forgeRun.gate.storageExceeded',
  CONFIRMATION_UNAVAILABLE: 'forgeRun.gate.confirmationUnavailable',
  API_BUDGET_EXCEEDED: 'forgeRun.gate.apiBudgetExceeded',
  READ_BOUND_EXCEEDED: 'forgeRun.gate.readBoundExceeded',
};

/**
 * A stop the user chose, at one of the run's questions, rather than one the
 * extension made. Neither a refusal for the API budget nor one for an object
 * read whole past its bound is among them: nobody was asked anything.
 */
const CANCELLED: ReadonlySet<ForgeRunGateCode> = new Set([
  'AUTOMATION_DECLINED',
  'READ_DECLINED',
  'WRITE_DECLINED',
]);

/**
 * The sentence `stop` is said in, where its code has more than one: storage
 * refused for the files a run copies, or for the records of a clone of the
 * whole org — which has no records per object to lower — and an API budget
 * refused for the allowance and the org it names. A refusal that names
 * neither, as one before the extension said them did, keeps the code's.
 */
function stopKey(stop: ForgeRunGateStop, wholeOrg: boolean): string {
  if (stop.code === 'STORAGE_EXCEEDED') {
    if (stop.storage?.kind === 'files') return 'forgeRun.gate.storageExceededFiles';
    if (wholeOrg) return 'forgeRun.gate.storageExceededAll';
  }
  if (stop.code === 'API_BUDGET_EXCEEDED' && stop.api) {
    if (stop.api.kind === 'bulkBatches') return 'forgeRun.gate.bulkBatchesExceeded';
    return stop.api.org === 'source'
      ? 'forgeRun.gate.apiRequestsExceededSource'
      : 'forgeRun.gate.apiRequestsExceededTarget';
  }
  return STOP_KEYS[stop.code];
}

/**
 * Why the last run stopped at its gate, said where the page goes back to —
 * Review, or the results a retry was started from: refused — a production
 * target, rows the target has no storage left for — or cancelled at a
 * question. Nothing was written either way. Shown until the next run starts
 * or it is dismissed.
 *
 * Brought into view and handed the keyboard once per stop: Review is long,
 * and the user who clicked Execute at its foot saw the page come back with
 * nothing changed where they looked, the notice above the fold. The scroll is
 * smooth unless the system asks for reduced motion — the stylesheet's rule
 * for it does not stop a smooth scroll asked for in code — and the focus is
 * taken only when it is free: nowhere, or within the page, as the phase
 * group the page hands it to on each phase. A control elsewhere keeps it.
 */
export const ForgeRunGateNotice: React.FC = () => {
  const { t } = useTranslation();
  const stop = useForgeRunGateStore((s) => s.stop);
  const clear = useForgeRunGateStore((s) => s.clear);
  const revealed = useForgeRunGateStore((s) => s.revealed);
  const markRevealed = useForgeRunGateStore((s) => s.markRevealed);
  /** The run refused was a clone of the whole org: the page keeps its config until the next. */
  const wholeOrg = useForgeStore((s) => clonesWholeOrg(s.config));
  const noticeRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  /*
   * A frame later rather than in the effect: the page hands the phase drawn
   * the focus in its own effect, which runs after this one when both change
   * together, and would take it back. Marked revealed within the frame, so a
   * mount StrictMode undoes at once, its frame cancelled, marks nothing.
   */
  useEffect(() => {
    if (!stop || revealed) return undefined;
    const id = requestAnimationFrame(() => {
      const el = noticeRef.current;
      if (!el) return;
      el.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      const focused = document.activeElement;
      if (focused === null || focused === document.body || focused.contains(el)) {
        el.focus({ preventScroll: true });
      }
      markRevealed();
    });
    return () => cancelAnimationFrame(id);
  }, [stop, revealed, reduceMotion, markRevealed]);

  if (!stop) return null;
  const cancelled = CANCELLED.has(stop.code);
  return (
    <div
      ref={noticeRef}
      // Focusable from code only, never a stop of the Tab key.
      tabIndex={-1}
      role={cancelled ? 'status' : 'alert'}
      data-testid="forge-run-gate-notice"
      data-code={stop.code}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-text-primary focus:outline-hidden ${
        cancelled ? 'border-subtle bg-surface-1' : 'border-status-warning/40 bg-status-warning/10'
      }`}
    >
      <ShieldAlert
        size={14}
        aria-hidden="true"
        className={`mt-0.5 shrink-0 ${cancelled ? 'text-text-secondary' : 'text-status-warning'}`}
      />
      <p data-testid="forge-run-gate-reason" className="flex-1">
        {t(stopKey(stop, wholeOrg), {
          // Of the storage refused, in MB; of the API budget, requests or batches.
          estimate: (stop.api?.estimate ?? stop.storage?.estimateMB ?? 0).toLocaleString(
            uiLocale(),
          ),
          remaining: (stop.api?.remaining ?? stop.storage?.remainingMB ?? 0).toLocaleString(
            uiLocale(),
          ),
          // The number the run held, which the settings may have raised.
          ceiling: (stop.ceiling ?? FORGE_READ_CEILING_PER_OBJECT).toLocaleString(uiLocale()),
          // A clone of the whole org refused for an object it reads whole:
          // the bound it held, and each object past it.
          bound: (stop.readBound?.bound ?? FORGE_READ_CEILING_PER_OBJECT).toLocaleString(
            uiLocale(),
          ),
          objects: (stop.readBound?.objects ?? []).map((o) => o.objectApiName).join(', '),
        })}
      </p>
      <button
        type="button"
        data-testid="forge-run-gate-dismiss"
        onClick={clear}
        aria-label={t('common.dismiss')}
        className="shrink-0 rounded p-0.5 text-text-secondary hover:text-text-primary"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
};
