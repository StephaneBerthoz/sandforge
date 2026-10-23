import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser } from 'lucide-react';
import type { FrozenRulesClearResponse } from '@sandforge/shared';

import { Button } from '../../components/ui/Button';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';

/** Props for {@link FrozenKeptWithoutARule}. */
export interface FrozenKeptWithoutARuleProps {
  /** The fields, as `Object.Field`, the extraction kept in clear text with no rule. */
  fields: readonly string[];
}

/**
 * What an extraction kept in clear text with no rule saying so, and the one
 * click that writes a `clear` rule for each into the rules file.
 *
 * A restricted or required picklist is kept by default: its values are the
 * schema's, and clearing them broke a real load that then asked for eighteen
 * declarations. Some still say something of a person — a gender identity, a
 * marital status the detector does not name — and the list reached the
 * manifest and the command line only: a panel user never saw what was kept.
 * Renders nothing when nothing was.
 */
export const FrozenKeptWithoutARule: React.FC<FrozenKeptWithoutARuleProps> = ({ fields }) => {
  const { t } = useTranslation();
  const hintId = useId();
  const clear = useBridgeMutation<FrozenRulesClearResponse['payload']>('frozen:rules:clear', {
    errorType: 'frozen:rules:clear:error',
  });
  if (fields.length === 0) return null;
  const written = clear.data;
  return (
    <div className="flex flex-col gap-1" data-testid="frozen-kept-without-rule">
      <p className="text-[11px] text-text-secondary" data-testid="frozen-kept-without-rule-list">
        {t('frozen.keptWithoutARule.note', { fields: fields.join(', ') })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Eraser className="w-3 h-3" />}
          loading={clear.loading}
          disabled={written !== null}
          aria-describedby={hintId}
          onClick={() => clear.mutate({ fields: [...fields] })}
          data-testid="frozen-kept-without-rule-clear"
        >
          {t('frozen.keptWithoutARule.clear')}
        </Button>
        <span id={hintId} className="text-[11px] text-text-secondary">
          {t('frozen.keptWithoutARule.clearHint')}
        </span>
      </div>
      {written && (
        <div role="status" className="flex flex-col gap-0.5 text-[11px]">
          {written.cleared.length > 0 && (
            <p className="text-status-success" data-testid="frozen-kept-without-rule-written">
              {t('frozen.keptWithoutARule.written', {
                path: written.rulesPath,
                version: written.rulesVersion,
                fields: written.cleared.join(', '),
              })}
            </p>
          )}
          {written.alreadyRuled.length > 0 && (
            <p className="text-text-secondary" data-testid="frozen-kept-without-rule-already">
              {t('frozen.keptWithoutARule.alreadyRuled', {
                fields: written.alreadyRuled.join(', '),
              })}
            </p>
          )}
        </div>
      )}
      {clear.error && (
        <p
          role="alert"
          className="text-[11px] text-status-error"
          data-testid="frozen-kept-without-rule-error"
        >
          {t('frozen.keptWithoutARule.failed', { reason: clear.error })}
        </p>
      )}
    </div>
  );
};
