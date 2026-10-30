/**
 * The keys of each module's how-to, in the order its steps are taken: the
 * module's page shows them in ModuleHowTo, its Help section in HowToSteps, and
 * scripts/sync-module-howto.mjs writes their English into its docs page.
 * moduleHowTo.test.ts holds this list to the `howTo` section of every locale.
 */
export const MODULE_HOW_TO = {
  forge: {
    steps: ['howTo.forge.step1', 'howTo.forge.step2', 'howTo.forge.step3', 'howTo.forge.step4'],
    tip: 'howTo.forge.tip',
  },
  seed: {
    steps: ['howTo.seed.step1', 'howTo.seed.step2', 'howTo.seed.step3', 'howTo.seed.step4'],
    tip: 'howTo.seed.tip',
  },
  checkpoint: {
    steps: [
      'howTo.checkpoint.step1',
      'howTo.checkpoint.step2',
      'howTo.checkpoint.step3',
      'howTo.checkpoint.step4',
      'howTo.checkpoint.step5',
    ],
    tip: 'howTo.checkpoint.tip',
  },
  sync: {
    steps: ['howTo.sync.step1', 'howTo.sync.step2', 'howTo.sync.step3', 'howTo.sync.step4'],
    tip: 'howTo.sync.tip',
  },
  autopilot: {
    steps: [
      'howTo.autopilot.step1',
      'howTo.autopilot.step2',
      'howTo.autopilot.step3',
      'howTo.autopilot.step4',
    ],
    tip: 'howTo.autopilot.tip',
  },
  frozen: {
    steps: [
      'howTo.frozen.step1',
      'howTo.frozen.step2',
      'howTo.frozen.step3',
      'howTo.frozen.step4',
      'howTo.frozen.step5',
    ],
    tip: 'howTo.frozen.tip',
  },
  compare: {
    steps: [
      'howTo.compare.step1',
      'howTo.compare.step2',
      'howTo.compare.step3',
      'howTo.compare.step4',
      'howTo.compare.step5',
    ],
    tip: 'howTo.compare.tip',
  },
  dataops: {
    steps: [
      'howTo.dataops.step1',
      'howTo.dataops.step2',
      'howTo.dataops.step3',
      'howTo.dataops.step4',
    ],
    tip: 'howTo.dataops.tip',
  },
  monitor: {
    steps: [
      'howTo.monitor.step1',
      'howTo.monitor.step2',
      'howTo.monitor.step3',
      'howTo.monitor.step4',
      'howTo.monitor.step5',
    ],
    tip: 'howTo.monitor.tip',
  },
  automation: {
    steps: [
      'howTo.automation.step1',
      'howTo.automation.step2',
      'howTo.automation.step3',
      'howTo.automation.step4',
      'howTo.automation.step5',
    ],
    tip: 'howTo.automation.tip',
  },
  migration: {
    steps: [
      'howTo.migration.step1',
      'howTo.migration.step2',
      'howTo.migration.step3',
      'howTo.migration.step4',
      'howTo.migration.step5',
    ],
    tip: 'howTo.migration.tip',
  },
  reports: {
    steps: [
      'howTo.reports.step1',
      'howTo.reports.step2',
      'howTo.reports.step3',
      'howTo.reports.step4',
      'howTo.reports.step5',
    ],
    tip: 'howTo.reports.tip',
  },
  grappe: {
    steps: ['howTo.grappe.step1', 'howTo.grappe.step2', 'howTo.grappe.step3', 'howTo.grappe.step4'],
    tip: 'howTo.grappe.tip',
  },
  ai: {
    steps: ['howTo.ai.step1', 'howTo.ai.step2', 'howTo.ai.step3', 'howTo.ai.step4'],
    tip: 'howTo.ai.tip',
  },
} as const satisfies Record<string, { steps: readonly string[]; tip: string }>;

/** A module that has a how-to. */
export type HowToModule = keyof typeof MODULE_HOW_TO;

/** Webview state key under which a module's how-to is remembered hidden. */
export function howToHiddenKey(module: HowToModule): string {
  return `sandforge-howto-hidden-${module}`;
}

/** Whether `id` names a module that has a how-to. */
export function hasHowTo(id: string): id is HowToModule {
  return Object.prototype.hasOwnProperty.call(MODULE_HOW_TO, id);
}

/** Every key of `module`'s how-to: its steps, then its tip. */
export function howToKeys(module: HowToModule): readonly string[] {
  const { steps, tip } = MODULE_HOW_TO[module];
  return [...steps, tip];
}
