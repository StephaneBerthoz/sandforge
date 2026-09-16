/**
 * Token usage of one AI call, or of a session so far.
 *
 * Every count is a non-negative integer. `cacheRead` and `cacheCreate` are 0
 * when the provider reports no prompt caching.
 */
export type AIUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
};
