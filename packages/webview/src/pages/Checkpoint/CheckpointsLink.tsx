import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/Button';

/** Props for {@link CheckpointsLink}. */
export interface CheckpointsLinkProps {
  /** Go back to the list of the org's checkpoints. */
  onClick: () => void;
  /** A run under way keeps the view: the link stays focusable, and says nothing to a click. */
  disabled?: boolean;
  testId: string;
}

/**
 * The way back to the list, in the same words and at the same place over a
 * take, the preview of a rewind and a replay: "← Checkpoints". Each had its
 * own, Cancel under the take, Back under the preview and "Back to the
 * checkpoints" beside the replay's heading, and the eye looked for it anew
 * on every view.
 */
export const CheckpointsLink: React.FC<CheckpointsLinkProps> = ({
  onClick,
  disabled = false,
  testId,
}) => {
  const { t } = useTranslation();
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowLeft className="h-3 w-3" aria-hidden="true" />}
        onClick={onClick}
        disabled={disabled}
        focusableWhenDisabled
        data-testid={testId}
      >
        {t('nav.checkpoint')}
      </Button>
    </div>
  );
};
