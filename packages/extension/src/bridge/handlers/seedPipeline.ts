import type { z } from 'zod';

import type { GuardTier, SeedExecutionResult, SeedTemplate } from '@sandforge/shared';
import { PREBUILT_SEED_TEMPLATES, pipelineWriteVerdict } from '@sandforge/shared';

import type { GivenAnswer } from '../../core/precheck/ProductionGuard.js';
import { seedTemplatePayloadSchema } from '../validatePayload.js';

/**
 * What a pipeline's Seed step is held to before it writes, beside what a seed
 * of the Seed page is held to (`SeedOpsHandler.seedForPipeline`). A pipeline
 * runs where nobody watches, on a trigger as often as from its page:
 * - the org is one SandForge knows, and never a production org, whatever an
 *   Approval step before the step answered; a sandbox marked Staging needs
 *   that Approval (`pipelineWriteVerdict`);
 * - the template is one the Seed page saved, or one SandForge ships, read as
 *   a run from the page is read; one with an AI rule is refused, such a rule
 *   sending field names to Anthropic on each run with nobody there to see it;
 * - each question the page would put before the first write is answered by
 *   that Approval step, and refused without one.
 */

/** A seed as it is asked for, before anything is read of its org: what a run of the page is read as. */
export interface SeedAsked {
  orgId: string;
  template: z.output<typeof seedTemplatePayloadSchema>;
  /** The locale its people and places are drawn in; the org's own when absent. */
  locale?: string;
}

/** What a pipeline's Seed step asks for. */
export interface PipelineSeedRequest {
  /** The org it seeds, by its id in SandForge. */
  orgId: string;
  /** The template: one the Seed page saved, or one SandForge ships (`prebuilt-*`). */
  templateId: string;
  /** The pipeline the step is a step of, which the run's file names. */
  pipeline: { name: string };
  /**
   * The answer of the Approval step before this one, or that nobody approved:
   * what Production Guard's question, and each question the page would put
   * before the first write, is answered with.
   */
  answer: GivenAnswer;
}

/** How a pipeline's seed ended, once it ran. */
export interface PipelineSeedOutcome {
  /** The id its operation went under, in Live Operations and in the audit trail. */
  operationId: string;
  /** The id its creations are kept under: what its removal from Seed's Recent runs names. */
  runId: string;
  /**
   * Its result, whole. A run a cancel stopped says `cancelled`, with what it
   * wrote before the stop, which stays in the org until it is taken back.
   */
  result: SeedExecutionResult;
  /**
   * What the org runs as the records are created, in the command line's words
   * (`seedAutomationLines`): what the page's confirmation shows before Start,
   * and nobody saw.
   */
  automation: string[];
  /** What could not be read or counted, the seed going on: said in the log, as the page's are. */
  warnings: string[];
}

/** The codes a pipeline's seed is refused with before it writes, beside the page's. */
export const PIPELINE_SEED_REFUSAL = {
  /** The org is not one SandForge knows. */
  orgUnknown: 'ORG_NOT_FOUND',
  /** A production org, or one SandForge cannot type: never seeded by a pipeline. */
  production: 'PIPELINE_WRITE_REFUSED',
  /** A sandbox marked Staging, with no Approval step approved before the step. */
  needsApproval: 'PIPELINE_WRITE_NEEDS_APPROVAL',
  /** No template is saved or shipped under the id. */
  templateMissing: 'SEED_TEMPLATE_MISSING',
  /** The template saved under the id no longer reads as a run of the page is read. */
  templateInvalid: 'SEED_TEMPLATE_INVALID',
  /** The template has an AI rule. */
  templateUsesAi: 'SEED_TEMPLATE_USES_AI',
  /** A question the page would put before the first write, with no Approval step approved before. */
  unanswered: 'SEED_CONFIRMATION_UNAVAILABLE',
} as const;

/** A refusal of a pipeline's seed: its message, and its code for whoever keys off the kind of refusal. */
export function pipelineSeedRefusal(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Why a pipeline may not seed an org of `tier`, or undefined when it may:
 * a production org whatever the answer, a sandbox marked Staging without an
 * approval.
 * @param tier - The org's tier, as `guardTierOf` reads it
 * @param answer - The Approval step's answer, or that nobody approved
 * @param org - The org, as the user knows it
 */
export function pipelineSeedTierRefusal(
  tier: GuardTier,
  answer: GivenAnswer,
  org: string,
): (Error & { code: string }) | undefined {
  const verdict = pipelineWriteVerdict(tier);
  if (verdict === 'refused') {
    return pipelineSeedRefusal(
      PIPELINE_SEED_REFUSAL.production,
      `${org} is a production org, or one SandForge cannot tell is not: a pipeline never seeds ` +
        'one, whatever an Approval step answers. Seed a sandbox, a scratch org or a Developer ' +
        'Edition org. Nothing was written.',
    );
  }
  if (verdict === 'needsApproval' && !answer.approved) {
    return pipelineSeedRefusal(
      PIPELINE_SEED_REFUSAL.needsApproval,
      `${org} is a sandbox marked Staging, which a pipeline seeds only once an Approval step ` +
        'before the seed has approved the run, and none did: put an Approval step before it. ' +
        'Nothing was written.',
    );
  }
  return undefined;
}

/**
 * The fields of a template an AI rule fills, each as `Object.Field`: a seed
 * sends them to the AI on each run.
 */
export function aiRuleFields(template: {
  objects: ReadonlyArray<{
    objectApiName: string;
    fieldRules: ReadonlyArray<{ fieldApiName: string; ruleType: string }>;
  }>;
}): string[] {
  return template.objects.flatMap((object) =>
    object.fieldRules
      .filter((rule) => rule.ruleType === 'ai_generate')
      .map((rule) => `${object.objectApiName}.${rule.fieldApiName}`),
  );
}

/**
 * The seed a pipeline's step asks for, read as a run of the Seed page is
 * read: the template the page saved under `templateId`, else the one
 * SandForge ships under it, held to the schema a request of the page passes.
 * A template the page deleted, one an older release saved that no longer
 * reads, or one with an AI rule is refused, before the org is read.
 * @param saved - The template the Seed page saved under an id, when it saved one
 */
export function pipelineSeedAsked(
  orgId: string,
  templateId: string,
  saved: (id: string) => SeedTemplate | undefined,
): { asked: SeedAsked } | { refusal: Error & { code: string } } {
  const stored: unknown =
    saved(templateId) ?? PREBUILT_SEED_TEMPLATES.find((template) => template.id === templateId);
  if (stored === undefined || stored === null) {
    return {
      refusal: pipelineSeedRefusal(
        PIPELINE_SEED_REFUSAL.templateMissing,
        `No Seed template is saved under ${templateId}, and SandForge ships none: it was ` +
          'deleted on the Seed page. Choose another. Nothing was written.',
      ),
    };
  }
  const named = (stored as { name?: unknown }).name;
  const name = typeof named === 'string' && named !== '' ? named : templateId;
  const parsed = seedTemplatePayloadSchema.safeParse(stored);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      refusal: pipelineSeedRefusal(
        PIPELINE_SEED_REFUSAL.templateInvalid,
        `The Seed template "${name}" no longer validates (${issue.path.join('.')}: ` +
          `${issue.message}): open it on the Seed page and save it again. Nothing was written.`,
      ),
    };
  }
  const ai = aiRuleFields(parsed.data);
  if (ai.length > 0) {
    return {
      refusal: pipelineSeedRefusal(
        PIPELINE_SEED_REFUSAL.templateUsesAi,
        `The Seed template "${name}" fills ${ai.join(', ')} with AI rules: a pipeline runs where ` +
          'nobody watches, and an AI rule sends field names to Anthropic on each run. Give ' +
          `${ai.length === 1 ? 'it a Faker rule' : 'them Faker rules'} on the Seed page. Nothing ` +
          'was written.',
      ),
    };
  }
  return { asked: { orgId, template: parsed.data } };
}
