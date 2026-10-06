import React from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Lightbulb } from 'lucide-react';
import { cn } from '../../theme';
import type { TranslatedError } from './forgeErrorTranslator';

/**
 * What the translator makes of one error: what it means, and what to do about
 * it, tinted by how much it costs the clone — and, when the Forge guide's table
 * of common errors has a row for its code, the way to that row.
 *
 * Shown under each message of the results' reports, and under the error that
 * stopped a run, on the execution screen and on the results of what it wrote.
 * The link is an anchor, as every external address in the webview is: VS Code
 * opens it in the browser.
 */
export const ForgeErrorHint: React.FC<{ hint: TranslatedError; className?: string }> = ({
  hint,
  className,
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid="forge-error-translation"
      className={cn(
        'px-2 py-1 rounded-sm border text-text-primary',
        hint.severity === 'error' && 'border-status-error/30 bg-status-error/5',
        hint.severity === 'warning' && 'border-status-warning/30 bg-status-warning/5',
        hint.severity === 'info' && 'border-status-info/30 bg-status-info/5',
        className,
      )}
    >
      <div className="flex items-start gap-1.5">
        <Lightbulb size={12} className="mt-0.5 shrink-0 text-hue-yellow" />
        <div>
          <div className="text-text-primary">{t(hint.explanationKey, hint.vars ?? {})}</div>
          <div className="text-text-primary mt-1 italic">
            → {t(hint.actionKey, hint.vars ?? {})}
          </div>
          {/* In the text's own colour, told apart by its underline and its
              icon: the theme's link blue read 4.06:1 on the red tint of an
              error in Light 2026, short of the 4.5:1 a text needs. */}
          {hint.docUrl && (
            <a
              href={hint.docUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="forge-error-guide-link"
              className="mt-1 inline-flex items-center gap-1 text-text-primary underline"
            >
              {t('forge.error.guideLink', { code: hint.code })}
              <ExternalLink size={10} aria-hidden="true" className="shrink-0" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
