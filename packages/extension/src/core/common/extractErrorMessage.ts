/**
 * Salesforce / jsforce error codes are `SCREAMING_SNAKE` (`INVALID_SESSION_ID`,
 * `ERROR_HTTP_503`) or, for the OAuth token endpoint, `lower_snake`
 * (`invalid_grant`). Requiring an underscore keeps ordinary error class names
 * (`Error`, `TypeError`, `AbortError`, `FetchError`) out of the match.
 */
const ERROR_CODE_PATTERN = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;

/** Maximum number of aggregated Salesforce errors rendered before summarizing. */
const MAX_AGGREGATED_ERRORS = 3;

/** Joins the lines of an aggregated `MULTIPLE_API_ERRORS` message. */
const AGGREGATED_ERROR_SEPARATOR = ' | ';

/**
 * Read the Salesforce error code jsforce hides on the error object.
 *
 * `HttpApiError` assigns the API's `errorCode` to both `errorCode` and `name`
 * and leaves `message` to the API's human text, so the code — the part that is
 * searchable and that our docs key on — never appears in the message.
 * The OAuth2 errors are anonymous `Error` subclasses that only carry the code
 * on `name`.
 */
function readErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { errorCode, name } = err as { errorCode?: unknown; name?: unknown };
  for (const candidate of [errorCode, name]) {
    if (typeof candidate === 'string' && ERROR_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Read back the error code {@link extractErrorMessage} puts in front of a
 * Salesforce message.
 *
 * Once an error has been rendered for the UI there is no code field left —
 * `operation:failed` carries a plain string. Anything keyed on the code (the
 * error knowledge base) therefore has to recover it from that string, and the
 * only shape worth trusting is the one this module produces: the code, alone
 * or followed by `": "` and the API's text. A segment that does not start that
 * way is treated as having no code rather than guessed at.
 *
 * An aggregated `MULTIPLE_API_ERRORS` line joins several such segments with
 * `" | "`, and each one is read: the first code is not always one the caller
 * can answer, and a message-only error renders with no code at all.
 *
 * @param message - A message produced by {@link extractErrorMessage}.
 * @param prefer - Picks, among the codes found, the first one it accepts.
 * @returns The preferred code, else the first code found, else `undefined`.
 */
export function extractErrorCode(
  message: string,
  prefer?: (code: string) => boolean,
): string | undefined {
  let first: string | undefined;
  for (const segment of message.split(AGGREGATED_ERROR_SEPARATOR)) {
    const separator = segment.indexOf(':');
    const candidate = (separator === -1 ? segment : segment.slice(0, separator)).trim();
    if (!ERROR_CODE_PATTERN.test(candidate)) continue;
    if (prefer?.(candidate)) return candidate;
    first ??= candidate;
  }
  return first;
}

/**
 * Render the individual API errors jsforce parks on `error.data`.
 *
 * When Salesforce answers with several errors at once, jsforce throws a single
 * `MULTIPLE_API_ERRORS` whose message is "Multiple errors returned. Check
 * `error.data` for the error details" — the real messages are only reachable
 * through that property, which no user-facing surface reads.
 *
 * @returns The joined error lines, or undefined when `data` holds no messages.
 */
function readAggregatedApiErrors(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { data } = err as { data?: unknown };
  if (!Array.isArray(data)) return undefined;

  const lines: string[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { message, errorCode } = entry as { message?: unknown; errorCode?: unknown };
    const text = typeof message === 'string' ? message.trim() : '';
    const code = typeof errorCode === 'string' && errorCode.length > 0 ? errorCode : '';
    const line =
      text.length === 0 ? code : code === '' || text.includes(code) ? text : `${code}: ${text}`;
    if (line.length > 0 && !lines.includes(line)) lines.push(line);
  }

  if (lines.length === 0) return undefined;
  if (lines.length <= MAX_AGGREGATED_ERRORS) return lines.join(AGGREGATED_ERROR_SEPARATOR);
  return `${lines.slice(0, MAX_AGGREGATED_ERRORS).join(AGGREGATED_ERROR_SEPARATOR)} (+${lines.length - MAX_AGGREGATED_ERRORS} more)`;
}

/**
 * Read the raw text of a thrown value: `message` for an `Error`, and also for
 * a plain Salesforce error object (`{ errorCode, message }`), which `String()`
 * would flatten to "[object Object]".
 */
function readRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const { message } = err as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/**
 * Extract a human-readable message from an unknown error value.
 *
 * Salesforce errors reach the UI through this helper, so it also recovers the
 * two parts jsforce keeps out of `message`: the API error code (on `name` /
 * `errorCode`) and the per-error details of a `MULTIPLE_API_ERRORS` batch (on
 * `data`). An error that carries no text at all degrades to its code rather
 * than to an empty notification.
 *
 * @param err - The caught error value (may be anything).
 * @returns A string message suitable for logging or user-facing display.
 */
export function extractErrorMessage(err: unknown): string {
  const aggregated = readAggregatedApiErrors(err);
  if (aggregated !== undefined) return aggregated;

  const raw = readRawMessage(err);
  const message = raw.trim();
  const code = readErrorCode(err);

  if (code === undefined) return message.length === 0 ? 'Unknown error' : raw;
  if (message.length === 0) return code;
  return message.includes(code) ? raw : `${code}: ${message}`;
}
