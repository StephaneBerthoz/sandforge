/**
 * How many describe calls a Forge pass keeps in flight against one org.
 *
 * Past six concurrent describes a run goes over jsforce's default
 * five-connection pool and the org's per-IP cap, and the surplus comes back as
 * connection errors instead of answers. Discovery and the pre-flight createable
 * check share the ceiling so that raising it is one decision, not two.
 */
export const CONCURRENT_DESCRIBE_LIMIT = 6;
