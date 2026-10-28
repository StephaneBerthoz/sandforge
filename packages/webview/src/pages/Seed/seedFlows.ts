import { lazy } from 'react';

/*
 * The ways to seed past the Seed page's gallery, each a chunk of its own,
 * fetched the first time it opens: the wizard, a template's confirmation and
 * run, the CSV import (with its parser) and the clone of another org. The
 * Seed page was 1.19 MB of script to parse before it showed its gallery,
 * against 0.86 MB for Help, every one of these flows included.
 */

/** The Seed wizard ("Generate data"). */
export const SeedGenerateFlow = lazy(() =>
  import('./SeedGenerateFlow').then((module) => ({ default: module.SeedGenerateFlow })),
);

/** A template's confirmation, its run and its results. */
export const QuickSeedFlow = lazy(() =>
  import('./QuickSeedFlow').then((module) => ({ default: module.QuickSeedFlow })),
);

/** The CSV import. */
export const CsvUploadWizard = lazy(() =>
  import('./CsvUpload/CsvUploadWizard').then((module) => ({ default: module.CsvUploadWizard })),
);

/** The clone of another org's records. */
export const CloneWizard = lazy(() =>
  import('./Clone/CloneWizard').then((module) => ({ default: module.CloneWizard })),
);

/**
 * A scenario pack's review, its seed and its agent's test file: with the
 * pack's schema, which checks an edit, parsed when a scenario opens.
 */
export const ScenarioFlow = lazy(() =>
  import('./Scenario/ScenarioFlow').then((module) => ({ default: module.ScenarioFlow })),
);

/** A scenario pack drafted from the user's own text, with AI on. */
export const ScenarioDraft = lazy(() =>
  import('./Scenario/ScenarioDraft').then((module) => ({ default: module.ScenarioDraft })),
);

/**
 * The seeds kept, under the gallery: fetched beside the list it asks the
 * extension for, which it waits for anyway, with the date formatting it
 * alone needs on the page.
 */
export const SeedRunHistory = lazy(() =>
  import('./SeedRunHistory').then((module) => ({ default: module.SeedRunHistory })),
);
