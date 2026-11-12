import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from 'framer-motion';
import { ShieldAlert, X } from 'lucide-react';
import {
  FORGE_READ_CEILING_PER_OBJECT,
  type ForgeRunGateCode,
  type ForgeRunGateStop,
} from '@sandforge/shared';
import { checkpointRefusalWords } from '../../utils/runCheckpoint';
import { RewindBeforeRun } from '../../components/ui/RewindBeforeRun';
import { useForgeStore } from '../../stores/useForgeStore';
import { uiLocale } from '../../utils/formatters';
import { useForgeRunGateStore } from './runGate';

/**
 * The sentence each stop is said in, unless the run's checkpoint first has
 * one of its own ({@link sentenceOf}).
 */
const STOP_KEYS: Record<ForgeRunGateCode, string> = {
  PRODUCTION_TARGET: 'forgeRun.gate.productionTarget',
  AUTOMATION_DECLINED: 'forgeRun.gate.automationDeclined',
  READ_DECLINED: 'forgeRun.gate.readDeclined',
  WRITE_DECLINED: 'forgeRun.gate.writeDeclined',
  STORAGE_EXCEEDED: 'forgeRun.gate.storageExceeded',
  CONFIRMATION_UNAVAILABLE: 'forgeRun.gate.confirmationUnavailable',
  CHECKPOINT_REFUSED: 'forgeRun.gate.checkpointRefused',
  API_BUDGET_EXCEEDED: 'forgeRun.gate.apiBudgetExceeded',
};

/** A stop the user chose, at one of the run's questions, rather than one the extension made. */
const CANCELLED: ReadonlySet<ForgeRunGateCode> = new Set([
  'AUTOMATION_DECLINED',
  'READ_DECLINED',
  'WRITE_DECLINED',
]);

/**
 * The sentence a stop is said in: a checkpoint refused by what refused it,
 * and the day's API requests with the checkpoint among them only when the run
 * was to take one.
 */
function sentenceOf(stop: ForgeRunGateStop, checkpointAsked: boolean): string {
  if (stop.code === 'CHECKPOINT_REFUSED' && stop.reason !== undefined) {
    return 'forgeRun.gate.checkpointRefusedFor';
  }
  if (stop.code === 'API_BUDGET_EXCEEDED' && checkpointAsked) {
    return 'forgeRun.gate.apiBudgetExceededWithCheckpoint';
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
 * Brought into view and handed the keyboard once per stop. The page comes
 * back as far down as the execution screen was: followed down while the run
 * read and asked its questions, or, once that screen's step had loaded, kept
 * as far down as Review was when Execute was pressed at its foot. In a panel
 * too narrow for Review's run column, the notice at the head of the rows was
 * then above the fold, nothing changed where the user looked, and the
 * keyboard on the step around it. The scroll is smooth unless the system
 * asks for reduced motion — the stylesheet's rule for it does not stop a
 * smooth scroll asked for in code — and the focus is taken only when it is
 * free: nowhere, or within the page, as the phase group the page hands it to
 * on each phase. A control elsewhere keeps it.
 */
export const ForgeRunGateNotice: React.FC = () => {
  const { t } = useTranslation();
  const stop = useForgeRunGateStore((s) => s.stop);
  const checkpointAsked = useForgeRunGateStore((s) => s.checkpointAsked);
  const checkpoint = useForgeRunGateStore((s) => s.checkpoint);
  const clear = useForgeRunGateStore((s) => s.clear);
  const revealed = useForgeRunGateStore((s) => s.revealed);
  const markRevealed = useForgeRunGateStore((s) => s.markRevealed);
  const targetOrgId = useForgeStore((s) => s.config?.targetOrgId);
  const noticeRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  /*
   * A frame later rather than in the effect: the page hands the phase drawn
   * the focus in its own effect (`useFocusOnChange`), and a parent's effect
   * runs after its children's. Review drawn in the commit that changes the
   * phase would see the focus taken back; the transition between phases
   * draws it a commit later, which the frame does not count on. Marked
   * revealed within the frame, so a mount StrictMode undoes at once, its
   * frame cancelled, marks nothing.
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
      <div className="flex flex-1 flex-col gap-1">
        <p data-testid="forge-run-gate-reason">
          {t(sentenceOf(stop, checkpointAsked), {
            estimate: stop.storage?.estimateMB ?? 0,
            remaining: stop.storage?.remainingMB ?? 0,
            // The number the run held, which the settings may have raised.
            ceiling: (stop.ceiling ?? FORGE_READ_CEILING_PER_OBJECT).toLocaleString(uiLocale()),
            reason: checkpointRefusalWords(stop.reason, t),
          })}
        </p>
        <RewindBeforeRun
          checkpoint={checkpoint}
          orgId={targetOrgId}
          beside="run"
          compact
          testId="forge-run-gate-checkpoint"
        />
      </div>
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
