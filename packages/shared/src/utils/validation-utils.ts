/**
 * Validation utility functions.
 *
 * Provides Zod-based safe parsing, type guards for common value shapes,
 * and format validators for emails, URLs, and cron expressions.
 */

import { z } from 'zod';

/** Result type for successful Zod parsing. */
interface ParseSuccess<T> {
  success: true;
  data: T;
}

/** Result type for failed Zod parsing. */
interface ParseFailure {
  success: false;
  errors: string[];
}

/** Safely parses data with a Zod schema, returning a discriminated result. */
export function safeParse<T>(
  schema: z.ZodType<T>,
  data: unknown,
): ParseSuccess<T> | ParseFailure {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  return { success: false, errors };
}

/** Validates that a value is a non-empty string (after trimming). */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates that a value is a positive integer. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Validates an email address format. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Validates a URL format by attempting to construct a URL object. */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Validates a basic 5-field cron expression. */
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return (
    (parts.length >= 5 && parts.length <= 7) &&
    parts.every((p) => /^[\dA-Za-z*,\-/?LW#]+$/.test(p))
  );
}
