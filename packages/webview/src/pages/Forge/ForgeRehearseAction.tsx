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
      return t('forgeRun.rehearsal.confirming', { count: progress.calls ?? 0 });
    }
    if (progress?.phase === 'rehearsing') {
      return t('forgeRun.rehearsal.rehearsing', {
        call: progress.call ?? 0,
        calls: progress.calls ?? 0,
      });
    }
    return progress?.objectApiName
      ? t('forgeRun.rehearsal.readingObject', { object: progress.objectApiName })
      : t('forgeRun.rehearsal.reading');
  }
  if (status === 'done' && result) {
    if (result.rows === 0) return t('forgeRun.rehearsal.nothing');
    // A row the target refused for a record it holds, which the run links
    // to: counted apart, never among the refused.
    const linked = result.linked ?? 0;
    const judged = t('forgeRun.rehearsal.done', {
      judged: result.judged,
      passed: result.passed,
      refused: result.judged - result.passed - linked,
      notJudged: result.notJudged,
      calls: result.calls,
    });
    const done = linked > 0 ? `${judged} ${t('forgeRun.rehearsal.linked', { linked })}` : judged;
    // The updates the run makes after its inserts, apart: only the command
    // line said those it could not rehearse, and the panel's line read as
    // the verdict on every write of the run.
    return result.updates > 0
      ? `${done} ${t('forgeRun.rehearsal.updates', {
          judged: result.updatesJudged,
          passed: result.updatesPassed,
          refused: result.updatesJudged - result.updatesPassed,
          notRehearsed: result.updatesNotRehearsed,
          updates: result.updates,
        })}`
      : done;
  }
  if (status === 'declined') return t('forgeRun.rehearsal.declined');
  if (status === 'error') return t('forgeRun.rehearsal.error', { error: error ?? '' });
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
    <div className="flex items-start gap-3">
      <p
        id="forge-rehearse-status"
        data-testid="forge-rehearse-status"
        role="status"
        aria-live="polite"
        className={`flex min-h-9 max-w-md items-center text-xs ${rehearsal.status === 'error' ? 'text-status-error' : 'text-text-secondary'}`}
      >
        {line}
      </p>
      {/* What it does and what it costs, said under it: it sat beside
          Simulate, the same outlined button, with its difference in a hover
          title and an sr-only line, though it creates rows in the target and
          costs API calls. */}
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          data-testid="rehearse-button"
          onClick={rehearsal.rehearse}
          disabled={!graph || !config || running}
          aria-busy={running}
          aria-describedby="forge-rehearse-hint forge-rehearse-status"
          title={t('forgeRun.rehearsal.hint')}
          className="px-4 py-2 text-sm font-semibold rounded-lg border border-forge text-hue-forge transition-colors hover:bg-forge/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('forgeRun.rehearsal.action')}
        </button>
        <p
          id="forge-rehearse-hint"
          data-testid="forge-rehearse-caption"
          className="max-w-[12rem] text-center text-[10px] text-text-secondary"
        >
          {t('forgeRun.rehearsal.caption')}
        </p>
      </div>
    </div>
  );
};
