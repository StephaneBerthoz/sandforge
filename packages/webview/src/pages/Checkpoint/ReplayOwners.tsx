import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckpointReplayOwners } from '@sandforge/shared';

/** Props for {@link ReplayOwners}. */
export interface ReplayOwnersProps {
  value: CheckpointReplayOwners;
  onChange: (owners: CheckpointReplayOwners) => void;
  /** The org the replay goes into, as the person knows it; empty before one is picked. */
  target: string;
  testId: string;
  disabled?: boolean;
}

/** The two answers, in the order they are offered: the default first. */
const OWNERS: ReadonlyArray<{ value: CheckpointReplayOwners; key: string; hint: string }> = [
  {
    value: 'same',
    key: 'checkpoint.replay.owners.same',
    hint: 'checkpoint.replay.owners.sameHint',
  },
  { value: 'me', key: 'checkpoint.replay.owners.me', hint: 'checkpoint.replay.owners.meHint' },
];

/**
 * Whom a replay gives its records to: their owner where the other org has
 * the same active user — by the same Id in a sandbox copied from the same
 * production, or by the same username without a sandbox's suffix —, else the
 * person who replays; or the person who replays, always. A record the other
 * org has no user for is never sent with an owner it would refuse: the
 * simulation counts each that goes to the person who replays, and why.
 */
export const ReplayOwners: React.FC<ReplayOwnersProps> = ({
  value,
  onChange,
  target,
  testId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const org = target !== '' ? target : t('checkpoint.replay.target.theOther');
  return (
    <fieldset className="flex flex-col gap-1" data-testid={testId} disabled={disabled}>
      <legend className="text-xs font-semibold text-text-primary">
        {t('checkpoint.replay.owners.legend')}
      </legend>
      {OWNERS.map((option) => (
        <label key={option.value} className="flex items-start gap-2 text-xs text-text-primary">
          <input
            type="radio"
            name={`${testId}-owners`}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            data-testid={`${testId}-${option.value}`}
          />
          <span>
            {t(option.key)}
            <span className="block text-text-secondary">{t(option.hint, { target: org })}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
};
