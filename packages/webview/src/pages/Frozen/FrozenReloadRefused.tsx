import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';

/** Props for {@link FrozenReloadRefused}. */
export interface FrozenReloadRefusedProps {
  /**
   * Why the extension refused the reload, in its words: the records a removal
   * of the loads it replaces would leave in the org, per object, and why.
   */
  message: string;
  /** The org the reload was asked of, as the user knows it. */
  org: string;
  /** Whether the card can take the load back: one it can remove from here. */
  canTakeBack: boolean;
  /** Open the removal of the load, the records changed since included, typed. */
  onTakeBack: () => void;
  /** Leave it there: nothing is written. */
  onCancel: () => void;
}

/**
 * A reload refused before anything was written, and the way out. A reload
 * replaces the loads before it: its purge deleted, without a word, the
 * records someone changed since a load, which a removal keeps. Refused while
 * a removal of those loads would leave records in the org, it says which and
 * why, and offers to take the load back first, the records changed since
 * included, through the removal's own typed confirmation — or to cancel.
 */
export const FrozenReloadRefused: React.FC<FrozenReloadRefusedProps> = ({
  message,
  org,
  canTakeBack,
  onTakeBack,
  onCancel,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="frozen-reload-refused"
      className="flex flex-col gap-2 rounded-sm border border-status-warning p-2"
    >
      {/* Said as it appears: the user clicked Reload, and nothing was written. */}
      <div role="alert" className="flex flex-col gap-1">
        <h3 id={headingId} className="text-xs font-semibold text-text-primary">
          {t('frozen.reloadRefused.title', { org })}
        </h3>
        <p
          className="text-[11px] text-text-primary whitespace-pre-wrap wrap-break-word"
          data-testid="frozen-reload-refused-why"
        >
          {message}
        </p>
      </div>
      <p className="text-[11px] text-text-secondary" data-testid="frozen-reload-refused-way-out">
        {canTakeBack
          ? t('frozen.reloadRefused.wayOut', { org })
          : t('frozen.reloadRefused.noWayOut')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {canTakeBack && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Trash2 size={11} />}
            onClick={onTakeBack}
            data-testid="frozen-reload-take-back"
            className="text-[11px]"
          >
            {t('frozen.reloadRefused.takeBack')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
          data-testid="frozen-reload-cancel"
          className="text-[11px]"
        >
          {t('common.cancel')}
        </Button>
      </div>
    </section>
  );
};
