/**
 * The describes a Forge cycle shares: one per org and object serves
 * discovery, the metadata diff and gap reader of Review, the executor (source
 * fields, target creatability, target fields for drift) and the drift check.
 * Each of them used to send its own: a run described every object three to
 * four times per org.
 *
 * Kept by count and by size. Discovery alone describes up to four times its
 * node cap of the source — two hundred objects at the default fifty — and
 * Review and Execute then describe the included nodes of both orgs. Held to a
 * hundred entries, the cache dropped the root and its first wave, the likely
 * included nodes, before discovery was over, and every two-org run past fifty
 * included objects described them again. A thousand entries hold a cycle of
 * the largest discovery; the byte cap, measured by a structural estimator that
 * walks each field descriptor (see `SchemaCache.estimateSize`), is what bounds
 * the memory.
 *
 * Entries go once their five minutes are up (`releaseExpired`): read again
 * only on the next run, they used to stay on the extension host's heap for the
 * life of the window. A Review left open past them describes again.
 */

import { SchemaCache } from '../../core/metadata/SchemaCache.js';

/** Most describes the cache holds, across both orgs of a run. */
export const FORGE_DESCRIBE_CACHE_ENTRIES = 1_000;

/** Most bytes, by the cache's estimate, the describes take. */
export const FORGE_DESCRIBE_CACHE_BYTES = 200 * 1024 * 1024;

/** How long a describe is kept: a discovery, its Review and its run. */
export const FORGE_DESCRIBE_TTL_MS = 5 * 60_000;

/** The cache a Forge composition keeps its describes in, keyed `${orgId}::${objectApiName}`. */
export function forgeDescribeCache<T>(): SchemaCache<T> {
  return new SchemaCache<T>({
    defaultTtl: FORGE_DESCRIBE_TTL_MS,
    maxSize: FORGE_DESCRIBE_CACHE_ENTRIES,
    maxSizeBytes: FORGE_DESCRIBE_CACHE_BYTES,
    releaseExpired: true,
  });
}
