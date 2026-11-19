import { lazy } from 'react';
import { withEnglish } from '../../i18n/englishNamespaces';

/*
 * The parts of Forge's input step a run does not start from, each a chunk of
 * its own fetched once the step has painted, or once its tab opens: the past
 * runs, with the removal of a run's records, and the Template and AI tabs. The
 * step opens on its Record ID tab, and Forge was the one page past 900 kB of
 * script to parse before it painted.
 *
 * Each brings with its chunk the English it renders beyond the page's. The
 * words of the past runs' removal and of the AI draft came with the page,
 * 45 kB of the 994 kB Forge parsed before it painted, for panels drawn after
 * it; src/PanelRouter.english.test.ts reads each list against the keys the
 * panel spells. The Template tab renders none beyond the page's.
 *
 * Each is drawn from what the form holds and asks the extension nothing it
 * does not ask for itself once drawn: the past runs and the templates are read
 * by the form, the AI draft by its hook.
 */

/** The past runs, refilled into the form or removed from the target. */
export const ForgeHistoryPanel = lazy(() =>
  withEnglish(
    () => import('./ForgeHistoryPanel'),
    ['automationMute', 'orgAutomation', 'runRemoval'],
  )().then((module) => ({ default: module.ForgeHistoryPanel })),
);

/** The Template tab: the saved and built-in templates. */
export const ForgeTemplatePanel = lazy(() =>
  import('./ForgeTemplatePanel').then((module) => ({ default: module.ForgeTemplatePanel })),
);

/** The AI tab: a run drafted from a sentence. */
export const ForgeAIPanel = lazy(() =>
  withEnglish(() => import('./ForgeAIPanel'), ['ai'])().then((module) => ({
    default: module.ForgeAIPanel,
  })),
);
