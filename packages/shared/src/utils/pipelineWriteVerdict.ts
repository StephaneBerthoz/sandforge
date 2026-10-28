import type { GuardTier } from './org-kind.js';

/**
 * What a pipeline step that writes into an org is allowed by the org's tier,
 * whatever it writes and however many records:
 * - `refused` for a production org, and for one SandForge cannot tell is not
 *   one (`guardTierOf` reads it as production): no answer lets a pipeline
 *   generate test records in it. Production Guard asks before every write
 *   there, and an Approval step approved before the run would answer that
 *   question for a run nobody watches;
 * - `needsApproval` for a sandbox marked Staging: Production Guard asks there
 *   past a volume only, and a full copy holding real data is no org a
 *   pipeline writes into unasked, so an Approval step comes before the step
 *   whatever the count;
 * - `allowed` for a sandbox, a scratch org or a Developer Edition org.
 *
 * The extension, as the step runs, and the Automation page, before Run, read
 * the same verdict.
 */
export type PipelineWriteVerdict = 'refused' | 'needsApproval' | 'allowed';

/**
 * The verdict of {@link PipelineWriteVerdict} for an org of `tier`. A tier the
 * guard does not know is refused, as production is.
 * @param tier - The org's tier, as `guardTierOf` reads it
 */
export function pipelineWriteVerdict(tier: GuardTier): PipelineWriteVerdict {
  if (tier === 'development' || tier === 'scratch') return 'allowed';
  if (tier === 'staging') return 'needsApproval';
  return 'refused';
}
