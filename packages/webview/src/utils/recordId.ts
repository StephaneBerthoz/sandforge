/**
 * Extract a Salesforce record id from a plain id or a Salesforce URL.
 *
 * A module of its own, with no import: Home reads the id its hero field holds
 * before it opens Forge, and took it from Forge's helpers, whose module builds
 * zod schemas as it loads. Home parsed zod and those helpers, 126 kB, for one
 * regular expression.
 *
 * @param input - What the user typed or pasted.
 * @returns The 15- or 18-character id, or null when there is none.
 */
export function extractRecordId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$|\?)/);
  return match?.[1] ?? null;
}
