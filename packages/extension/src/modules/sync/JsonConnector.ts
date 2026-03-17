/**
 * Reads and writes JSON data for sync operations.
 * Handles both arrays of records and single-record JSON objects.
 * Validates structure and provides clear error messages.
 */
export class JsonConnector {
  /**
   * Parse JSON content into an array of records.
   * Accepts both a JSON array of objects and a single object (wrapped as array).
   * Throws if the content is not valid JSON or not in the expected format.
   */
  read(jsonContent: string): Record<string, unknown>[] {
    const trimmed = jsonContent.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const parsed: unknown = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      return validateArray(parsed);
    }

    if (isRecord(parsed)) {
      return [parsed];
    }

    throw new Error('JSON content must be an array of objects or a single object');
  }

  /**
   * Serialize an array of records into a formatted JSON string.
   * Uses 2-space indentation for readability.
   */
  write(records: Record<string, unknown>[]): string {
    return JSON.stringify(records, null, 2);
  }
}

/**
 * Validate that every element in the array is a record object.
 */
function validateArray(arr: unknown[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!isRecord(item)) {
      throw new Error(`Element at index ${i} is not an object`);
    }
    records.push(item);
  }

  return records;
}

/**
 * Type guard to check if a value is a non-null plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
