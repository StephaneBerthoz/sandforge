import React from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Lightbulb } from 'lucide-react';
import type { ErrorHint } from '@sandforge/shared';
import { cn } from '../../theme';

/**
 * What the error catalogue makes of one error (`translateError`): what it
 * means, what to do next, and where to read more — Forge's guide row for its
 * code, or a search of Salesforce Help — tinted by how much it costs the run.
 * A code the catalogue does not know is shown by its link alone: the org's own
 * words are already above it, and repeating them said nothing.
 *
 * Shown under a banner's error, under each reason of a results page and under
 * each message of Forge's reports. The link is an anchor, as every external
 * address in the webview is: VS Code opens it in the browser.
 */
export const ErrorExplanation: React.FC<{ hint: ErrorHint; className?: string }> = ({
  hint,
  className,
}) => {
  const { t } = useTranslation();
  const vars = hint.vars ?? {};
  return (
    <div
      data-testid="error-hint"
      className={cn(
        'px-2 py-1 rounded-sm border text-text-primary',
        hint.severity === 'error' && 'border-status-error/30 bg-status-error/5',
        hint.severity === 'warning' && 'border-status-warning/30 bg-status-warning/5',
        hint.severity === 'info' && 'border-status-info/30 bg-status-info/5',
        className,
      )}
    >
      <div className="flex items-start gap-1.5">
        <Lightbulb size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-hue-yellow" />
        <div className="min-w-0">
          {hint.explanationKey && (
            <div className="text-text-primary">{t(hint.explanationKey, vars)}</div>
          )}
          {hint.actionKey && (
            <div className={cn('text-text-primary italic', hint.explanationKey && 'mt-1')}>
              → {t(hint.actionKey, vars)}
            </div>
          )}
          {/* In the text's own colour, told apart by its underline and its
              icon: the theme's link blue read 4.06:1 on the red tint of an
              error in Light 2026, short of the 4.5:1 a text needs. */}
          {hint.docUrl && (
            <a
              href={hint.docUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="error-hint-link"
              className={cn(
                'inline-flex items-center gap-1 text-text-primary underline',
                (hint.explanationKey || hint.actionKey) && 'mt-1',
              )}
            >
              {hint.docKind === 'guide'
                ? t('errors.guideLink', { code: hint.code })
                : t('errors.searchLink', { code: hint.code })}
              <ExternalLink size={10} aria-hidden="true" className="shrink-0" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
