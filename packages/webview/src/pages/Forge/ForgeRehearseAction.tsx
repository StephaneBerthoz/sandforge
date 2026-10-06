import React from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import { useForgeRehearsal, type ForgeRehearsalState } from './useForgeRehearsal';

/** The line under the action: where the rehearsal stands, or what it came to. */
function statusLine(
  t: ReturnType<typeof useTranslation>['t'],
  { status, progress, result, error }: ForgeRehearsalState,
): string | null {
  if (status === 'running') {
    if (progress?.phase === 'confirming') {
      return t('forge.rehearsal.confirming', { count: progress.calls ?? 0 });
    }
    if (progress?.phase === 'rehearsing') {
      return t('forge.rehearsal.rehearsing', {
        call: progress.call ?? 0,
        calls: progress.calls ?? 0,
      });
    }
    return progress?.objectApiName
      ? t('forge.rehearsal.readingObject', { object: progress.objectApiName })
      : t('forge.rehearsal.reading');
  }
  if (status === 'done' && result) {
    return result.rows === 0
      ? t('forge.rehearsal.nothing')
      : t('forge.rehearsal.done', {
          judged: result.judged,
          passed: result.passed,
          refused: result.judged - result.passed,
          notJudged: result.notJudged,
          calls: result.calls,
        });
  }
  if (status === 'declined') return t('forge.rehearsal.declined');
  if (status === 'error') return t('forge.rehearsal.error', { error: error ?? '' });
  return null;
}

/**
 * Review's Rehearse action, beside Simulate: the run as Execute would send it,
 * a sample of its rows created in the target and every write rolled back,
 * for the platform's own verdict on each. The cost is put to the user in VS
 * Code before the first call; the line under the button says where the
 * rehearsal stands, then what it found, and the refusals join the gaps.
 */
export const ForgeRehearseAction: React.FC = () => {
  const { t } = useTranslation();
  const graph = useForgeStore((s) => s.graph);
  const config = useForgeStore((s) => s.config);
  const rehearsal = useForgeRehearsal();
  const running = rehearsal.status === 'running';
  const line = statusLine(t, rehearsal);
  return (
    <div className="flex items-center gap-3">
      <p
        id="forge-rehearse-status"
        data-testid="forge-rehearse-status"
        role="status"
        aria-live="polite"
        className={`max-w-md text-xs ${rehearsal.status === 'error' ? 'text-status-error' : 'text-text-secondary'}`}
      >
        {line}
      </p>
      <button
        type="button"
        data-testid="rehearse-button"
        onClick={rehearsal.rehearse}
        disabled={!graph || !config || running}
        aria-busy={running}
        aria-describedby="forge-rehearse-hint forge-rehearse-status"
        title={t('forge.rehearsal.hint')}
        className="px-4 py-2 text-sm font-semibold rounded-lg border border-forge text-hue-forge transition-colors hover:bg-forge/10 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('forge.rehearsal.action')}
      </button>
      <span id="forge-rehearse-hint" className="sr-only">
        {t('forge.rehearsal.hint')}
      </span>
    </div>
  );
};
