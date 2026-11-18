import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RecoveryStep } from '@sandforge/shared';
import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { MARKABLE_STEPS, SKIPPABLE_STEPS } from './recoveryFacts';

/** The fill each status's badge wears: a refusal in red, what is left to do plain. */
const STATUS_VARIANT: Record<RecoveryStep['status'], BadgeVariant> = {
  todo: 'default',
  done: 'success',
  skipped: 'info',
  notApplicable: 'info',
  refused: 'error',
};

/** The words of each status, as the page names it. */
const STATUS_KEY: Record<RecoveryStep['status'], string> = {
  todo: 'recovery.status.todo',
  done: 'recovery.status.done',
  skipped: 'recovery.status.skipped',
  notApplicable: 'recovery.status.notApplicable',
  refused: 'recovery.status.refused',
};

/** The three marks a person keeps on a step: skipped, done by hand, or neither again. */
export type StepMark = 'skipped' | 'done' | 'cleared';

/** Props of {@link RecoveryStepRow}. */
export interface RecoveryStepRowProps {
  /** Its rank in the list, from 1. */
  number: number;
  step: RecoveryStep;
  /** The step's sentence: what it will do, what it did, or why it does not apply. */
  line: React.ReactNode;
  /** When its status was reached, written for the reader. */
  at?: string;
  /** What the step says beside its line: the facts of the refresh, a warning. */
  children?: React.ReactNode;
  /** The buttons of what the step runs or opens, on the row of Skip. */
  actions?: React.ReactNode;
  /** What the step's run or reading answered, below its buttons. */
  after?: React.ReactNode;
  /** Keep a mark on the step; absent while the page cannot keep one. */
  onMark?: (mark: StepMark) => void;
  /** A mark is being kept: the buttons wait for it. */
  marking?: boolean;
}

/**
 * One step of the recovery: its number, its title, its status and the code of
 * why, written as a sentence, then what it runs, on one row with Skip — or
 * Mark as done for the two a person checks by eye — and Undo on a mark kept,
 * then what it answered.
 */
export const RecoveryStepRow: React.FC<RecoveryStepRowProps> = ({
  number,
  step,
  line,
  at,
  children,
  actions,
  after,
  onMark,
  marking = false,
}) => {
  const { t } = useTranslation();
  const skippable = SKIPPABLE_STEPS.has(step.id);
  const markable = MARKABLE_STEPS.has(step.id);
  // A mark kept by hand can be taken back; a status deduced from what ran cannot.
  const kept = step.reason === 'skipped' || step.reason === 'markedDone';
  const open = step.status === 'todo' || step.status === 'refused';
  const markOffered = onMark !== undefined && (skippable || markable) && (open || kept);

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3"
      data-testid={`recovery-step-${step.id}`}
      data-status={step.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* One string, so a screen reader names the step by its number too. */}
        <h3 className="text-sm font-semibold text-text-primary">
          {`${number}. ${t(`recovery.step.${step.id}`)}`}
        </h3>
        <Badge
          variant={STATUS_VARIANT[step.status]}
          data-testid={`recovery-step-${step.id}-status`}
        >
          {t(STATUS_KEY[step.status])}
        </Badge>
        {at && <span className="text-xs text-text-secondary">{at}</span>}
      </div>
      <p className="text-xs text-text-primary" data-testid={`recovery-step-${step.id}-line`}>
        {line}
      </p>
      {children}
      {(actions || markOffered) && (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {markOffered && open && markable && (
            <Button
              size="sm"
              variant="secondary"
              disabled={marking}
              onClick={() => onMark?.('done')}
              data-testid={`recovery-step-${step.id}-mark-done`}
            >
              {t('recovery.markDone')}
            </Button>
          )}
          {markOffered && open && skippable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={marking}
              onClick={() => onMark?.('skipped')}
              data-testid={`recovery-step-${step.id}-skip`}
            >
              {t('recovery.skip')}
            </Button>
          )}
          {markOffered && kept && (
            <Button
              size="sm"
              variant="ghost"
              disabled={marking}
              onClick={() => onMark?.('cleared')}
              data-testid={`recovery-step-${step.id}-undo`}
            >
              {t('recovery.undo')}
            </Button>
          )}
        </div>
      )}
      {after}
    </li>
  );
};
