/**
 * Prompt-injection defense — escape & wrap arbitrary user data so that an
 * adversarial payload (e.g. record content containing
 * `</user-data><instructions>…</instructions>`) cannot break out of the
 * Anthropic XML tag boundary that Claude is trained to respect.
 *
 * Anthropic's XML-tag mitigation only holds when the data payload truly
 * cannot include a literal `</tag>`. Naive interpolation
 * defeats the boundary; HTML entity escape restores it. Belt-and-suspenders:
 * the system prompt also instructs Claude to treat `<user-data>` content as
 * data only (see the untrusted-data clause in systemPrompts/index.ts).
 *
 * Pure module — no SDK or VS Code dependencies.
 */

/** Pattern for the NUL byte — written via hex escape so the source file
 *  itself stays plain ASCII (no embedded NUL).
 *
 * Intentional control-char match: NUL bytes are stripped defensively from
 * untrusted data before it crosses the <user-data> prompt boundary
 * (prompt-injection defense).
 */
// eslint-disable-next-line no-control-regex
const NUL_PATTERN = /\x00/g;

/**
 * HTML-style entity escape. Maps `&` first (so subsequent `&lt;` / `&gt;`
 * don't get re-escaped), then `<` and `>`. NUL bytes stripped defensively.
 *
 * NOTE: NOT idempotent — re-escaping is intentional. Callers should NOT call
 * this twice on the same string.
 */
export function escapeUserData(s: string): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(NUL_PATTERN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wrap a value as a `<user-data label="…">…</user-data>` block. Both the
 * label AND the value are escaped (defense in depth — labels MAY come from
 * untrusted sources in future flows). Labels are truncated to 80 chars.
 */
export function wrapAsUserData(label: string, value: string): string {
  const safeLabel = escapeUserData(label).slice(0, 80);
  const safeValue = escapeUserData(value);
  return `<user-data label="${safeLabel}">${safeValue}</user-data>`;
}

/**
 * Convenience for structured contexts. Equivalent to
 * `escapeUserData(JSON.stringify(obj))`. The handler typically does
 * `wrapAsUserData(label, JSON.stringify(obj))` (the inner escape happens
 * inside `wrapAsUserData`); use this only when escaping outside the
 * wrapper.
 */
export function stringifyAndEscape(obj: unknown): string {
  return escapeUserData(JSON.stringify(obj));
}
