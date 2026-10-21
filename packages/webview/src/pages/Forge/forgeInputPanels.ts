import { lazy } from 'react';

/*
 * The parts of Forge's input step a run does not start from, each a chunk of
 * its own fetched once the step has painted, or once its tab opens: the past
 * runs, with the removal of a run's records, and the Template and AI tabs. The
 * step opens on its Record ID tab, and Forge was the one page past 900 kB of
 * script to parse before it painted.
 *
 * Each is drawn from what the form holds and asks the extension nothing it
 * does not ask for itself once drawn: the past runs and the templates are read
 * by the form, the AI draft by its hook.
 */

/** The past runs, refilled into the form or removed from the target. */
export const ForgeHistoryPanel = lazy(() =>
  import('./ForgeHistoryPanel').then((module) => ({ default: module.ForgeHistoryPanel })),
);

/** The Template tab: the saved and built-in templates. */
export const ForgeTemplatePanel = lazy(() =>
  import('./ForgeTemplatePanel').then((module) => ({ default: module.ForgeTemplatePanel })),
);

/** The AI tab: a run drafted from a sentence. */
export const ForgeAIPanel = lazy(() =>
  import('./ForgeAIPanel').then((module) => ({ default: module.ForgeAIPanel })),
);
