import { z } from 'zod';
import { AIUsageSchema } from './callResult.js';

/**
 * Token budget snapshot: one counter for the window session, shared by every
 * AI feature. Rebuilding the AI stack keeps it; a window reload starts anew.
 *
 * `state` discriminator:
 *   - 'ok'        — percent < 80
 *   - 'warn'      — 80 <= percent < 100 (the host shows a notice at the first crossing)
 *   - 'exceeded'  — percent >= 100 (AI calls are refused; the host says so once)
 *
 * `percent` is clamped to <= 200 in the schema.
 */
export const TokenBudgetStateSchema = z
  .object({
    sessionId: z.string().min(1),
    used: AIUsageSchema,
    budget: z.number().int().positive(),
    percent: z.number().min(0).max(200),
    state: z.enum(['ok', 'warn', 'exceeded']),
  })
  .strict();
export type TokenBudgetState = z.infer<typeof TokenBudgetStateSchema>;
