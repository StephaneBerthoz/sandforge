/**
 * General-purpose string manipulation utilities.
 *
 * Provides case conversion, truncation, masking, pluralization,
 * and simple ID generation.
 */

/** Truncates a string to maxLength, appending ellipsis if truncated. */
export function truncate(str: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (str.length <= maxLength) return str;
  if (maxLength === 1) return '\u2026';
  return str.slice(0, maxLength - 1) + '\u2026';
}

/** Converts a string to PascalCase. */
export function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_: string, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_: string, c: string) => c.toUpperCase());
}

/** Converts a string to camelCase. */
export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Converts a string to snake_case. */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .replace(/[-\s]+/g, '_')
    .replace(/^_/, '')
    .toLowerCase();
}

/** Pluralizes a simple English word based on the given count. */
export function pluralize(word: string, count: number): string {
  if (count === 1) return word;

  if (
    word.endsWith('s') ||
    word.endsWith('x') ||
    word.endsWith('z') ||
    word.endsWith('ch') ||
    word.endsWith('sh')
  ) {
    return word + 'es';
  }

  if (word.endsWith('y') && !['a', 'e', 'i', 'o', 'u'].includes(word.charAt(word.length - 2))) {
    return word.slice(0, -1) + 'ies';
  }

  return word + 's';
}

/** Masks a string for display (e.g. email, token), showing only the first N characters. */
export function maskString(str: string, visibleChars: number = 4): string {
  if (str.length <= visibleChars) return '*'.repeat(str.length);
  return str.slice(0, visibleChars) + '*'.repeat(str.length - visibleChars);
}

/** Generates a unique ID combining a base36 timestamp and 8 hex chars from crypto.randomUUID. */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${timestamp}-${random}`;
}
