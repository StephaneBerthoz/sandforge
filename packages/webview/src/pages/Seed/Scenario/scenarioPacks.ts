import type { ScenarioPack, SeedScenarioPackEntry } from '@sandforge/shared';

/**
 * The packs SandForge ships, by id, and the catalogue keys of their name and
 * description: the gallery says them in the interface's language, and their
 * content — articles, cases, utterances — stays in English, an agent's
 * default language, which a pack drafted from the user's text need not be.
 */
const BUILT_IN_KEYS: Readonly<Record<string, { name: string; description: string }>> = {
  'retail-orders': {
    name: 'seed.scenario.packs.retailOrders.name',
    description: 'seed.scenario.packs.retailOrders.description',
  },
  'broadband-support': {
    name: 'seed.scenario.packs.broadbandSupport.name',
    description: 'seed.scenario.packs.broadbandSupport.description',
  },
  'saas-support': {
    name: 'seed.scenario.packs.saasSupport.name',
    description: 'seed.scenario.packs.saasSupport.description',
  },
};

/** The catalogue keys of a shipped pack's name and description; undefined for any other pack. */
export function builtInPackKeys(packId: string): { name: string; description: string } | undefined {
  return BUILT_IN_KEYS[packId];
}

/** Where a pack under review comes from: what decides whether it can be seeded as it is. */
export type ScenarioSource =
  | { kind: 'built-in' }
  | { kind: 'workspace'; path: string; relativePath: string }
  | { kind: 'draft' };

/** A pack picked in the gallery, or drafted, and where it comes from. */
export interface ScenarioPicked {
  pack: ScenarioPack;
  source: ScenarioSource;
}

/** Where a pack of the gallery's listing comes from, as its review says it. */
export function sourceOf(
  entry: Extract<SeedScenarioPackEntry, { pack: ScenarioPack }>,
): ScenarioSource {
  return entry.source === 'built-in'
    ? { kind: 'built-in' }
    : { kind: 'workspace', path: entry.path, relativePath: entry.relativePath };
}

/** Two packs that say the same: compared as their files would write them. */
export function samePack(a: ScenarioPack, b: ScenarioPack): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
