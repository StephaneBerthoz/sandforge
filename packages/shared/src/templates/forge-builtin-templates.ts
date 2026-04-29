import type { ForgeTemplate } from '../types/forge.types.js';

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
