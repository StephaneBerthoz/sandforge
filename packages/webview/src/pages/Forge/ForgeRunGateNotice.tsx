import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, X } from 'lucide-react';
import { FORGE_READ_CEILING_PER_OBJECT, type ForgeRunGateCode } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';
import { useForgeRunGateStore } from './runGate';

/** The sentence each stop is said in. */
const STOP_KEYS: Record<ForgeRunGateCode, string> = {
  PRODUCTION_TARGET: 'forge.gate.productionTarget',
  AUTOMATION_DECLINED: 'forge.gate.automationDeclined',
  READ_DECLINED: 'forge.gate.readDeclined',
  WRITE_DECLINED: 'forge.gate.writeDeclined',
  STORAGE_EXCEEDED: 'forge.gate.storageExceeded',
  CONFIRMATION_UNAVAILABLE: 'forge.gate.confirmationUnavailable',
};

/** A stop the user chose, at one of the run's questions, rather than one the extension made. */
const CANCELLED: ReadonlySet<ForgeRunGateCode> = new Set([
  'AUTOMATION_DECLINED',
  'READ_DECLINED',
  'WRITE_DECLINED',
]);

/**
 * Why the last run stopped at its gate, said where the page goes back to —
 * Review, or the results a retry was started from: refused — a production
 * target, rows the target has no storage left for — or cancelled at a
 * question. Nothing was written either way. Shown until the next run starts
 * or it is dismissed.
 */
export const ForgeRunGateNotice: React.FC = () => {
  const { t } = useTranslation();
  const stop = useForgeRunGateStore((s) => s.stop);
  const clear = useForgeRunGateStore((s) => s.clear);
  if (!stop) return null;
  const cancelled = CANCELLED.has(stop.code);
  return (
    <div
      role={cancelled ? 'status' : 'alert'}
      data-testid="forge-run-gate-notice"
      data-code={stop.code}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-text-primary ${
        cancelled ? 'border-subtle bg-surface-1' : 'border-status-warning/40 bg-status-warning/10'
      }`}
    >
      <ShieldAlert
        size={14}
        aria-hidden="true"
        className={`mt-0.5 shrink-0 ${cancelled ? 'text-text-secondary' : 'text-status-warning'}`}
      />
      <p data-testid="forge-run-gate-reason" className="flex-1">
        {t(STOP_KEYS[stop.code], {
          estimate: stop.storage?.estimateMB ?? 0,
          remaining: stop.storage?.remainingMB ?? 0,
          ceiling: FORGE_READ_CEILING_PER_OBJECT.toLocaleString(uiLocale()),
        })}
      </p>
      <button
        type="button"
        data-testid="forge-run-gate-dismiss"
        onClick={clear}
        aria-label={t('common.dismiss')}
        className="shrink-0 rounded p-0.5 text-text-secondary hover:text-text-primary"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
};
