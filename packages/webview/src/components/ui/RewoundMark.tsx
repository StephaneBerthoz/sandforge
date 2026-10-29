import React from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import type { RewoundMark as RewoundMarkOf } from '@sandforge/shared';
import { cn } from '../../theme';
import { formatStoredDate } from '../../utils/formatters';

/** Props for {@link RewoundMark}. */
export interface RewoundMarkProps {
  /** The mark of the run, as `useRewoundMarks` gives it. */
  mark: RewoundMarkOf;
  /**
   * The undo came after the run's removal, which had found its records gone
   * (`backAfterRemoval`): the undo brought them back, and the line says so
   * rather than that the rewind was undone.
   */
  undoneAfterRemoval?: boolean;
  testId: string;
  className?: string;
}

/** The main line of a mark, by how the rewind took the run back. */
const MAIN_KEYS: Record<RewoundMarkOf['kind'], string> = {
  rewound: 'runResults.rewound.mark',
  partly: 'runResults.rewound.markPartly',
  stopped: 'runResults.rewound.stopped',
};

/**
 * On a run's line of the Seed, Sync or Forge history: a rewind took it back,
 * when, to which checkpoint, whole or in part, and what became of it since —
 * the rewind left records, an undo brought them back, objects the
 * checkpoint did not hold kept theirs. Before, a run a rewind had deleted
 * the records of still read as removable, and its removal then found them
 * gone with no word of why.
 *
 * Told by dates: a run close to the checkpoint or to the rewind reads as
 * rewound in part, and the run's removal preview counts what is left of it.
 *
 * An undo after the run's removal brought back what that removal had found
 * gone: the line said nothing was left while the records were back in the
 * org. It says they came back, and the history offers to remove them again.
 */
export const RewoundMark: React.FC<RewoundMarkProps> = ({
  mark,
  undoneAfterRemoval = false,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const dated = (iso: string): string =>
    formatStoredDate(iso, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown');
  const parts = [
    t(MAIN_KEYS[mark.kind], { date: dated(mark.at), name: mark.checkpointName }),
    ...(mark.leftSome ? [t('runResults.rewound.leftSome')] : []),
    ...(mark.undoneAt !== undefined
      ? [
          t(
            undoneAfterRemoval
              ? 'runResults.rewound.undoneAfterRemoval'
              : 'runResults.rewound.undone',
            { date: dated(mark.undoneAt) },
          ),
        ]
      : []),
    ...(mark.outside.length > 0
      ? [t('runResults.rewound.outside', { objects: mark.outside.join(', ') })]
      : []),
  ];
  return (
    <p
      data-testid={testId}
      data-kind={mark.kind}
      className={cn('flex items-start gap-1 text-[11px] text-text-secondary', className)}
    >
      <History size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{parts.join(' · ')}</span>
    </p>
  );
};

/**
 * The mark, said in a word where a line has no room for it: the Sync
 * history's table, whose row opens onto the run's detail, which says it
 * whole. Written in the cell's own colour, not as a pill: the theme's badge
 * colours read at 3.7:1 on Quiet Light, and the secondary text at 3.7:1 on
 * the row a click selects.
 */
export const RewoundBadge: React.FC<{ mark: RewoundMarkOf; testId: string }> = ({
  mark,
  testId,
}) => {
  const { t } = useTranslation();
  return (
    <span
      data-testid={testId}
      data-kind={mark.kind}
      className="inline-flex shrink-0 items-center gap-0.5 font-medium"
    >
      <History size={10} aria-hidden="true" />
      {t('runResults.rewound.badge')}
    </span>
  );
};
