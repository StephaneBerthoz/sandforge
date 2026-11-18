import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecoveryPreparation, RecoveryPreparationId } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

/** What each thing to keep says, while it is to do and once it is kept. */
const LINE_KEY: Record<RecoveryPreparationId, { todo: string; done: string }> = {
  beforeRefreshCheckpoint: {
    todo: 'recovery.before.beforeRefreshCheckpoint.todo',
    done: 'recovery.before.beforeRefreshCheckpoint.done',
  },
  jobsInventory: {
    todo: 'recovery.before.jobsInventory.todo',
    done: 'recovery.before.jobsInventory.done',
  },
  testersList: {
    todo: 'recovery.before.testersList.todo',
    done: 'recovery.before.testersList.done',
  },
  automation: {
    todo: 'recovery.before.automation.todo',
    done: 'recovery.before.automation.done',
  },
};

/** The button of each thing to keep, which does it or opens where it is done. */
const ACTION_KEY: Record<RecoveryPreparationId, string> = {
  beforeRefreshCheckpoint: 'recovery.before.beforeRefreshCheckpoint.action',
  jobsInventory: 'recovery.before.jobsInventory.action',
  testersList: 'recovery.before.testersList.action',
  automation: 'recovery.before.automation.action',
};

/** Props of {@link RecoveryBeforeNext}. */
export interface RecoveryBeforeNextProps {
  items: readonly RecoveryPreparation[];
  alias: string;
  /** Do, or open where it is done, one thing to keep. */
  onAct: (id: RecoveryPreparationId) => void;
  /** The things whose button waits for an answer: the inventory being read. */
  busy?: ReadonlySet<RecoveryPreparationId>;
}

/**
 * Before the next refresh: what the next recovery starts from, kept now — a
 * checkpoint named Before refresh kept until deleted, the inventory of the
 * scheduled jobs, the list of the testers, and a pipeline that runs after
 * each refresh.
 */
export const RecoveryBeforeNext: React.FC<RecoveryBeforeNextProps> = ({
  items,
  alias,
  onAct,
  busy,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={titleId}
      data-testid="recovery-before-next"
    >
      <h2 id={titleId} className="text-sm font-semibold text-text-primary">
        {t('recovery.before.title')}
      </h2>
      <p className="text-xs text-text-secondary">{t('recovery.before.intro')}</p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-col items-start gap-2 rounded-md border border-subtle bg-surface-1 p-3"
            data-testid={`recovery-before-${item.id}`}
            data-status={item.status}
          >
            {/* The button under the sentence, as a step's: beside it, a
                panel 360 pixels wide left the sentence a word per line. */}
            <span className="flex items-start gap-2">
              <Badge variant={item.status === 'done' ? 'success' : 'default'} className="shrink-0">
                {t(item.status === 'done' ? 'recovery.status.done' : 'recovery.status.todo')}
              </Badge>
              <span className="min-w-0 text-xs text-text-primary">
                {t(LINE_KEY[item.id][item.status], { alias })}
              </span>
            </span>
            <Button
              size="sm"
              variant={item.status === 'done' ? 'ghost' : 'secondary'}
              loading={busy?.has(item.id) ?? false}
              onClick={() => onAct(item.id)}
              data-testid={`recovery-before-${item.id}-action`}
            >
              {t(ACTION_KEY[item.id])}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};
