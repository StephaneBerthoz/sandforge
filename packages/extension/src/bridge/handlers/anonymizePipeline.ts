import type { z } from 'zod';

import type { DataOpsAnonymizeResponse, GuardTier } from '@sandforge/shared';
import { pipelineWriteVerdict } from '@sandforge/shared';

import type { GivenAnswer } from '../../core/precheck/ProductionGuard.js';
import { dataOpsAnonymizePayloadSchema } from '../validatePayload.js';

/**
 * What a pipeline's Anonymize step is held to before it masks, beside what a
 * masking run of the DataOps page is held to (`DataOpsHandler.anonymizeForPipeline`).
 * A pipeline runs where nobody watches, on a trigger as often as from its
 * page, and a masked value is not given back:
 * - the org is one SandForge knows, and never a production org, whatever an
 *   Approval step before the step answered; a sandbox marked Staging needs
 *   that Approval (`pipelineWriteVerdict`);
 * - the step is never tried again: a second try masks again what the first
 *   one masked, another way;
 * - a condition comes with the one object whose rows it filters, as on the
 *   page;
 * - the template is one DataOps ships or the page saved;
 * - every field the template names on the objects it masks is one the org
 *   shows the user SandForge connects as, and the run masks something: the
 *   page's run ends partial on such a field after it wrote the others, a
 *   pipeline's is refused before it writes;
 * - a snapshot of what the run writes over is always taken, whole, before the
 *   first value is masked.
 */

/** A masking run as it is asked for, before anything is read of its org: what a run of the page is read as. */
export type MaskingAsked = z.output<typeof dataOpsAnonymizePayloadSchema>;

/** What a pipeline's Anonymize step asks for. */
export interface PipelineMaskingRequest {
  /** The org it masks, by its id in SandForge. */
  orgId: string;
  /** The template: one DataOps ships (`tpl-*`), or one the DataOps page saved. */
  templateId: string;
  /** The one object it masks; absent, every object the template's rules name. */
  object?: string;
  /** A SOQL condition, without its `WHERE`, the rows of `object` are held to. */
  where?: string;
  /** The retries the step is given: none, or the step is refused. */
  retries?: number;
  /** The pipeline the step is a step of, which Live Operations names. */
  pipeline: { name: string };
  /**
   * The answer of the Approval step before this one, or that nobody approved:
   * what Production Guard's question is answered with.
   */
  answer: GivenAnswer;
}

/** The result of a masking run, as the DataOps page is answered it. */
export type MaskingResult = DataOpsAnonymizeResponse['payload'];

/** How a pipeline's masking ended, once it ran. */
export interface PipelineMaskingOutcome {
  /** The id its operation went under, in Live Operations and in the audit trail. */
  operationId: string;
  /**
   * Its result, whole, as the page is answered: the rows masked, refused and
   * left by object, and the snapshot taken before the first write. A run a
   * cancel stopped says `cancelled`, with what it masked before the stop.
   */
  result: MaskingResult;
}

/** The codes a pipeline's masking is refused with before it writes, beside the page's. */
export const PIPELINE_MASKING_REFUSAL = {
  /** The org is not one SandForge knows. */
  orgUnknown: 'ORG_NOT_FOUND',
  /** A production org, or one SandForge cannot type: never masked by a pipeline. */
  production: 'PIPELINE_WRITE_REFUSED',
  /** A sandbox marked Staging, with no Approval step approved before the step. */
  needsApproval: 'PIPELINE_WRITE_NEEDS_APPROVAL',
  /** The step is given retries. */
  retries: 'PIPELINE_WRITE_NO_RETRIES',
  /** A condition with no object to filter. */
  filterNeedsObject: 'MASKING_FILTER_NEEDS_OBJECT',
  /** The object or the condition is not one the page's request takes. */
  invalid: 'INVALID_PAYLOAD',
  /** No template is shipped or saved under the id: the page's code. */
  templateMissing: 'TEMPLATE_NOT_FOUND',
  /** A field the template names is not one the org shows the user SandForge connects as. */
  fieldsUnseen: 'MASKING_FIELDS_UNSEEN',
  /** No rule of the template masks anything on the objects the run reads. */
  masksNothing: 'MASKING_MASKS_NOTHING',
} as const;

/** A refusal of a pipeline's masking: its message, and its code for whoever keys off the kind of refusal. */
export function pipelineMaskingRefusal(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Why a pipeline may not mask an org of `tier`, or undefined when it may:
 * a production org whatever the answer, a sandbox marked Staging without an
 * approval.
 * @param tier - The org's tier, as `guardTierOf` reads it
 * @param answer - The Approval step's answer, or that nobody approved
 * @param org - The org, as the user knows it
 */
export function pipelineMaskingTierRefusal(
  tier: GuardTier,
  answer: GivenAnswer,
  org: string,
): (Error & { code: string }) | undefined {
  const verdict = pipelineWriteVerdict(tier);
  if (verdict === 'refused') {
    return pipelineMaskingRefusal(
      PIPELINE_MASKING_REFUSAL.production,
      `${org} is a production org, or one SandForge cannot tell is not: a pipeline never masks ` +
        'one, whatever an Approval step answers. Mask a sandbox, a scratch org or a Developer ' +
        'Edition org. Nothing was masked.',
    );
  }
  if (verdict === 'needsApproval' && !answer.approved) {
    return pipelineMaskingRefusal(
      PIPELINE_MASKING_REFUSAL.needsApproval,
      `${org} is a sandbox marked Staging, which a pipeline masks only once an Approval step ` +
        'before the masking has approved the run, and none did: put an Approval step before it. ' +
        'Nothing was masked.',
    );
  }
  return undefined;
}

/**
 * The masking run a pipeline's step asks for, read as a run of the DataOps
 * page is read, with a snapshot always: refused, before the org is read, for
 * retries, a condition with no object, an object or a condition the page's
 * request would not take, or a template neither shipped nor saved.
 * @param exists - Whether a template is shipped or saved under an id
 */
export function pipelineMaskingAsked(
  request: Pick<PipelineMaskingRequest, 'orgId' | 'templateId' | 'object' | 'where' | 'retries'>,
  exists: (templateId: string) => boolean,
): { asked: MaskingAsked } | { refusal: Error & { code: string } } {
  if (request.retries !== undefined && request.retries > 0) {
    return {
      refusal: pipelineMaskingRefusal(
        PIPELINE_MASKING_REFUSAL.retries,
        'A masking step is never tried again: a second try masks again what the first one ' +
          'masked — an address it hashed is hashed once more, and no longer gives the same ' +
          'pseudonym on Contact and on Lead. Set its retries to 0. Nothing was masked.',
      ),
    };
  }
  const where = request.where?.trim();
  if (where && request.object === undefined) {
    return {
      refusal: pipelineMaskingRefusal(
        PIPELINE_MASKING_REFUSAL.filterNeedsObject,
        'A masking condition filters the rows of one object: name the object it holds, or ' +
          'remove the condition. Nothing was masked.',
      ),
    };
  }
  const parsed = dataOpsAnonymizePayloadSchema.safeParse({
    orgId: request.orgId,
    templateId: request.templateId,
    ...(request.object !== undefined ? { objects: [request.object] } : {}),
    ...(where ? { where } : {}),
    // What the run writes over is kept before its first write, whole, or
    // nothing is masked: a pipeline's run is undone by nothing else.
    snapshot: true,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      refusal: pipelineMaskingRefusal(
        PIPELINE_MASKING_REFUSAL.invalid,
        `The masking step is not one the DataOps page would run (${issue.path.join('.')}: ` +
          `${issue.message}). Nothing was masked.`,
      ),
    };
  }
  if (!exists(parsed.data.templateId)) {
    return {
      refusal: pipelineMaskingRefusal(
        PIPELINE_MASKING_REFUSAL.templateMissing,
        `No masking template is shipped or saved under ${parsed.data.templateId}: it was ` +
          'deleted on the DataOps page. Choose another. Nothing was masked.',
      ),
    };
  }
  return { asked: parsed.data };
}
