import type { ForgeGraph, ForgeTemplate } from '../types/forge.types.js';

/**
 * Pre-configured starter templates surfaced in the Forge wizard's template
 * tab. Devs pick one, supply a root record ID + source/target orgs, and
 * skip straight to discovery — no manual depth/anonymize/skip-empty config.
 *
 * Each template targets a recurring scenario observed across CRM/Service/
 * Sales orgs. Custom templates saved by the user (`useForgeStore.addTemplate`)
 * are listed alongside these builtins.
 */
export const BUILTIN_FORGE_TEMPLATES: readonly ForgeTemplate[] = Object.freeze([
  {
    id: 'builtin:account-360',
    name: 'Account 360',
    description:
      'Clone an Account with its Contacts, Opportunities, and Cases. Best for CRM developers exploring a full customer view.',
    config: {
      inputMode: 'record',
      depth: 'custom',
      customDepth: 4,
      anonymizePII: true,
      skipEmpty: true,
      batchSize: 'auto',
    },
    objectCount: 0,
    recordCount: 0,
    createdAt: '2026-04-29T00:00:00.000Z',
    lastUsedAt: '2026-04-29T00:00:00.000Z',
  },
  {
    id: 'builtin:case-workflow',
    name: 'Case Workflow',
    description:
      'Clone a Case with its Account, Contact, EmailMessages, CaseHistory, and CaseComments. Best for Service Cloud developers debugging support flows.',
    config: {
      inputMode: 'record',
      depth: 'custom',
      customDepth: 5,
      anonymizePII: true,
      skipEmpty: true,
      batchSize: 'auto',
    },
    objectCount: 0,
    recordCount: 0,
    createdAt: '2026-04-29T00:00:00.000Z',
    lastUsedAt: '2026-04-29T00:00:00.000Z',
  },
  {
    id: 'builtin:lead-to-opp',
    name: 'Lead → Opportunity',
    description:
      'Clone a Lead with its Campaign, converted Account/Contact, and resulting Opportunity. Best for Sales Cloud developers testing lead-to-opp transitions.',
    config: {
      inputMode: 'record',
      depth: 'custom',
      customDepth: 4,
      anonymizePII: true,
      skipEmpty: true,
      batchSize: 'auto',
    },
    objectCount: 0,
    recordCount: 0,
    createdAt: '2026-04-29T00:00:00.000Z',
    lastUsedAt: '2026-04-29T00:00:00.000Z',
  },
]);

/** Quick lookup helper used by the wizard to identify builtin IDs. */
export function isBuiltinForgeTemplate(id: string): boolean {
  return id.startsWith('builtin:');
}

/**
 * Object lists per builtin template — used by the wizard to build a
 * synthetic ForgeGraph and skip the BFS discovery (~30s on big orgs)
 * when the user picks a starter template. Order matters: parents first
 * so the topo wave plan is roughly correct without recomputing edges.
 */
export const BUILTIN_TEMPLATE_OBJECTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'builtin:account-360': ['Account', 'Contact', 'Opportunity', 'Case'],
  'builtin:case-workflow': [
    'Account',
    'Contact',
    'Case',
    'EmailMessage',
    'CaseComment',
    'Attachment',
  ],
  'builtin:lead-to-opp': ['Campaign', 'Lead', 'Account', 'Contact', 'Opportunity'],
});

/** Object list for a builtin template, or empty array if unknown. */
export function getBuiltinTemplateObjects(id: string): readonly string[] {
  return BUILTIN_TEMPLATE_OBJECTS[id] ?? [];
}

/**
 * Build a synthetic ForgeGraph from a list of object API names. Used by
 * the wizard's "Quick start" path to bypass BFS discovery when a starter
 * template is selected — the user can review/execute immediately and the
 * (real) record counts arrive later via the executor's per-node query.
 *
 * Nodes are created in input order, with `level = index`. Edges are left
 * empty — ForgePlanGenerator's Kahn's-algorithm fallback handles cycle-
 * less graphs correctly. `included = true` everywhere so the user can
 * untoggle in the Review tab.
 */
export function buildSyntheticForgeGraph(objects: readonly string[]): ForgeGraph {
  return {
    nodes: objects.map((name, idx) => ({
      objectApiName: name,
      recordCount: 0,
      fieldCount: 0,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: idx,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto',
    })),
    edges: [],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}
