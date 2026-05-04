/** Input for the search operation */
export interface SearchInput {
  data: Array<Record<string, unknown>>;
  query: string;
  fields?: string[];
  caseSensitive?: boolean;
}

/** A single search match with context */
export interface SearchMatch {
  index: number;
  record: Record<string, unknown>;
  matchedFields: string[];
}

/** Result of searching through records */
export interface SearchResult {
  matches: SearchMatch[];
  totalSearched: number;
  durationMs: number;
}

/**
 * Search through an array of records for a query string,
 * optionally restricting to specific fields.
 */
export function searchRecords(input: SearchInput): SearchResult {
  const startTime = performance.now();
  const { data, query, fields, caseSensitive = false } = input;

  if (query === '') {
    return {
      matches: [],
      totalSearched: data.length,
      durationMs: performance.now() - startTime,
    };
  }

  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (let i = 0; i < data.length; i++) {
    const record = data[i];
    const matchedFields = findMatchingFields(record, normalizedQuery, fields, caseSensitive);

    if (matchedFields.length > 0) {
      matches.push({ index: i, record, matchedFields });
    }
  }

  return {
    matches,
    totalSearched: data.length,
    durationMs: performance.now() - startTime,
  };
}

function findMatchingFields(
  record: Record<string, unknown>,
  normalizedQuery: string,
  fields: string[] | undefined,
  caseSensitive: boolean,
): string[] {
  const fieldsToSearch = fields ?? Object.keys(record);
  const matched: string[] = [];

  for (const field of fieldsToSearch) {
    const value = record[field];
    if (value === null || value === undefined) continue;

    const stringValue = caseSensitive ? String(value) : String(value).toLowerCase();

    if (stringValue.includes(normalizedQuery)) {
      matched.push(field);
    }
  }

  return matched;
}
