/**
 * Bounds of a DataOps data-quality scan that both ends of the bridge read: the
 * page shapes its request with them, and the extension refuses a request past
 * them.
 */

/**
 * Objects one scan reads. Each costs a describe and at least four aggregate
 * queries, object after object, so ten keep a scan to seconds rather than
 * minutes, and its result to a page a person reads.
 */
export const QUALITY_SCAN_MAX_OBJECTS = 10;

/** The staleness threshold a scan starts from: a year without an edit. */
export const QUALITY_SCAN_DEFAULT_STALE_DAYS = 365;

/** The longest staleness threshold a scan accepts: ten years. */
export const QUALITY_SCAN_MAX_STALE_DAYS = 3650;
