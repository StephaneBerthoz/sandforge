import React from 'react';
import { useTranslation } from 'react-i18next';
import { Square } from 'lucide-react';
import { Button } from '../../components/ui/Button';

/** RunStopControl component props. */
export interface RunStopControlProps {
  /** Send the cancel of the run (`useOperationCancel`). */
  onStop: () => void;
  /** Whether the cancel was sent and not refused: the run stops before its next call. */
  requested: boolean;
  /** The test id of the button; the stopping line takes it with `-stopping`. */
  testId: string;
}

/**
 * The Stop of a DataOps run the page started — a backup, a restore, a
 * masking run — which goes out on `execution:abort`, as Live Operations'
 * Cancel does. The tab had none: a masking run started on the wrong template
 * overwrote every record of its object, and only closing VS Code stopped it.
 * Once sent, the button stays off and says what happens to what the run did.
 */
export const RunStopControl: React.FC<RunStopControlProps> = ({ onStop, requested, testId }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="danger"
        size="sm"
        icon={<Square className="w-3 h-3" />}
        disabled={requested}
        focusableWhenDisabled
        onClick={onStop}
        data-testid={testId}
      >
        {t('common.cancelRun')}
      </Button>
      {requested && (
        <p
          role="status"
          className="text-[11px] text-text-secondary"
          data-testid={`${testId}-stopping`}
        >
          {t('common.runStopping')}
        </p>
      )}
    </div>
  );
};
