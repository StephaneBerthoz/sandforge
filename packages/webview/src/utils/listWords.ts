/**
 * Words joined as the interface language lists them — "a", "a and b",
 * "a, b and c" — with the language's own separators (`common.list.separator`
 * and `common.list.and`): a Japanese list is joined with 「、」, not ", and".
 *
 * @param t - Translates a key in the interface language.
 */
export function listWords(items: readonly string[], t: (key: string) => string): string {
  if (items.length <= 1) return items.join('');
  const separator = t('common.list.separator');
  const and = t('common.list.and');
  return `${items.slice(0, -1).join(separator)}${and}${items[items.length - 1]}`;
}
