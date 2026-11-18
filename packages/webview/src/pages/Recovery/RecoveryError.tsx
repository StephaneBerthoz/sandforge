import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RecoveryErrorCode } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { recoveryErrorCodeOf } from './useRecoveryBridge';

/** The words of each code of `recovery:error`: the extension's English goes to its log. */
const ERROR_KEY: Record<RecoveryErrorCode, string> = {
  INVALID_PAYLOAD: 'recovery.error.INVALID_PAYLOAD',
  ORG_NOT_FOUND: 'recovery.error.ORG_NOT_FOUND',
  NOT_CONNECTED: 'recovery.error.NOT_CONNECTED',
  NOT_A_DEVELOPMENT_ORG: 'recovery.error.NOT_A_DEVELOPMENT_ORG',
  ORG_CHANGED: 'recovery.error.ORG_CHANGED',
  CANCELLED: 'recovery.error.CANCELLED',
  FAILED: 'recovery.error.FAILED',
};

/** Props of {@link RecoveryError}. */
export interface RecoveryErrorProps {
  /** What the request said of its failure: a timeout's words, or the extension's. */
  error: string;
  /** The code the extension's error carried, when it carried one. */
  errorCode: string | null;
  alias: string;
  /** Words of a code that say more where the request is known: an apply refused, simulate again. */
  codeKeys?: Partial<Record<RecoveryErrorCode, string>>;
  /** Ask again; absent where asking again changes nothing. */
  onRetry?: () => void;
  testId: string;
}

/**
 * A request of the page refused or failed, in the page's language: by its
 * code when the extension gave one of the domain's, never by the English it
 * logs. A timeout, or a request the bridge dropped, has no code: its words
 * come from the bridge, already in the page's language.
 */
export const RecoveryError: React.FC<RecoveryErrorProps> = ({
  error,
  errorCode,
  alias,
  codeKeys,
  onRetry,
  testId,
}) => {
  const { t } = useTranslation();
  const code = recoveryErrorCodeOf(errorCode);
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-sm border border-(--sf-error) px-3 py-2 text-xs text-status-error"
      data-testid={testId}
      data-code={code ?? undefined}
    >
      <span className="flex-1 min-w-0 wrap-break-word">
        {code ? t(codeKeys?.[code] ?? ERROR_KEY[code], { alias }) : error}
      </span>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} data-testid={`${testId}-retry`}>
          {t('recovery.retry')}
        </Button>
      )}
    </div>
  );
};
