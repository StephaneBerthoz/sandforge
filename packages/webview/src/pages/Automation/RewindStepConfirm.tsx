import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  OrgCheckpoint,
  PipelineRewindGrantResponse,
  PipelineStep,
  SalesforceOrg,
} from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { RewindPreview } from '../Checkpoint/RewindPreview';
import { formatNumber } from '../../utils/formatters';

/** Props of {@link RewindStepConfirm}. */
export interface RewindStepConfirmProps {
  /** The Rewind step, as saved. */
  step: PipelineStep;
  /** The org it rewinds. */
  org: SalesforceOrg;
  /** The checkpoint it rewinds the org to. */
  checkpoint: OrgCheckpoint;
  /** Back to the pipeline. */
  onClose: () => void;
  /** Keep the confirmation, with the org's alias as typed. */
  onConfirm: (typed: string) => void;
  /** Whether a confirmation is on its way to the extension. */
  pending?: boolean;
  /** The extension's answer to it, once it came. */
  answer?: PipelineRewindGrantResponse['payload'] | null;
}

/**
 * The confirmation of a Rewind step, typed once below its preview: what the
 * rewind would do to the org now, read as the Checkpoints page reads it —
 * and Rewind not offered, nothing written — then the org's alias, its
 * username when it has none, typed as the Checkpoints page asks it. The
 * extension compares what was typed with the org it knows and keeps the
 * confirmation for the step as saved; from then on the step rewinds the org
 * whenever the pipeline runs, a schedule too, within its bounds.
 */
export const RewindStepConfirm: React.FC<RewindStepConfirmProps> = ({
  step,
  org,
  checkpoint,
  onClose,
  onConfirm,
  pending = false,
  answer,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const [typing, setTyping] = useState(false);
  const alias = org.alias || org.username;
  const maxRecords = typeof step.config['maxRecords'] === 'number' ? step.config['maxRecords'] : 0;
  const words = {
    step: step.name,
    org: alias,
    name: checkpoint.name,
    max: formatNumber(maxRecords),
  };
  const refused = answer && !answer.granted && answer.stepId === step.id ? answer : undefined;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby={headingId}
      data-testid="rewind-step-confirm"
    >
      <h2 id={headingId} className="text-sm font-semibold text-text-primary break-words">
        {t('automation.rewindConfirmHeading', words)}
      </h2>
      <p className="text-xs text-text-secondary" data-testid="rewind-step-confirm-lead">
        {t('automation.rewindConfirmLead', words)}
      </p>
      <RewindPreview org={org} checkpoint={checkpoint} onClose={onClose} />
      {refused && (
        <p role="alert" className="text-xs text-status-error" data-testid="rewind-grant-refused">
          {t(`automation.rewindGrantRefused.${refused.code}`)}
        </p>
      )}
      <div>
        <Button
          variant="danger"
          disabled={pending}
          onClick={() => setTyping(true)}
          data-testid="rewind-step-confirm-type"
        >
          {t('automation.rewindConfirmType')}
        </Button>
      </div>
      <DangerConfirm
        open={typing}
        onClose={() => setTyping(false)}
        onConfirm={() => {
          setTyping(false);
          onConfirm(alias);
        }}
        title={t('automation.rewindConfirmTitle', words)}
        description={t('automation.rewindConfirmDescription', words)}
        confirmText={alias}
      />
    </section>
  );
};
