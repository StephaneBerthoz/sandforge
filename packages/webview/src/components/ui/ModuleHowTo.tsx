import React, { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Lightbulb } from 'lucide-react';
import { cn } from '../../theme';
import { getPersistedItem, setPersistedItem } from '../../utils/webviewStorage';
import { MODULE_HOW_TO, howToHiddenKey, type HowToModule } from './moduleHowTo';

/** Props for HowToSteps and ModuleHowTo. */
export interface HowToProps {
  /** The module whose how-to is shown. */
  module: HowToModule;
}

/**
 * A module's how-to: its steps in order, then its tip.
 *
 * The one rendering of the text: the module's page shows it in ModuleHowTo,
 * the Help page in the module's section, and the docs page carries the same
 * English, written from en.json by scripts/sync-module-howto.mjs.
 */
export const HowToSteps: React.FC<HowToProps> = ({ module }) => {
  const { t } = useTranslation();
  const { steps, tip } = MODULE_HOW_TO[module];

  return (
    <div className="flex flex-col gap-2" data-testid={`how-to-steps-${module}`}>
      <ol className="list-decimal pl-5 space-y-1 text-xs text-text-primary">
        {steps.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
      <p className="flex items-start gap-1.5 text-xs text-text-secondary">
        <Lightbulb size={13} className="text-hue-amber shrink-0 mt-px" aria-hidden="true" />
        <span>
          <span className="font-semibold">{t('howTo.tipLabel')}</span> {t(tip)}
        </span>
      </p>
    </div>
  );
};

/**
 * "How to" at the top of a module's page: the shortest path from opening the
 * page to the module's result, open until it is hidden, and remembered hidden
 * for that module from then on.
 */
export const ModuleHowTo: React.FC<HowToProps> = ({ module }) => {
  const { t } = useTranslation();
  const panelId = useId();
  const [open, setOpen] = useState(() => getPersistedItem(howToHiddenKey(module)) !== 'true');

  const toggle = useCallback(() => {
    setOpen((was) => {
      setPersistedItem(howToHiddenKey(module), was ? 'true' : 'false');
      return !was;
    });
  }, [module]);

  return (
    <section
      className="rounded-md border border-subtle bg-surface-1"
      aria-label={t('howTo.title')}
      data-testid={`how-to-${module}`}
    >
      <button
        type="button"
        className="flex items-center justify-between w-full px-3 py-2 text-xs font-semibold text-text-primary text-left"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        data-testid={`how-to-${module}-toggle`}
      >
        <span>{t('howTo.title')}</span>
        <ChevronDown
          size={14}
          className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {/* The panel is hidden rather than left out, so that aria-controls
          always names a panel on the page: axe flagged PageTabs pointing at
          one it never drew. Its steps are left out, so that a label they
          quote is not found twice on the page. */}
      <div id={panelId} className="px-3 pb-3" hidden={!open}>
        {open && <HowToSteps module={module} />}
      </div>
    </section>
  );
};
