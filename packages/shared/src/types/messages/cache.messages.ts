import type { BaseMessage } from './base.messages.js';

/** Request to invalidate all caches (e.g. on org switch). */
export interface CacheInvalidateAllRequest extends BaseMessage {
  type: 'cache:invalidate-all';
}

/** Response confirming all caches were invalidated. */
export interface CacheInvalidateAllResponse extends BaseMessage {
  type: 'cache:invalidate-all:response';
  payload: { success: boolean };
}

/** Request cache diagnostic stats. */
export interface CacheGetStatsRequest extends BaseMessage {
  type: 'cache:get-stats';
}

/** Response containing cache stats. */
export interface CacheStatsResponse extends BaseMessage {
  type: 'cache:stats-response';
  payload: {
    stats: Array<{ name: string; size: number }>;
  };
}
