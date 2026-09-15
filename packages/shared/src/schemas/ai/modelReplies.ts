import { z } from 'zod';

/**
 * Shapes of the JSON the extension asks a model for, and the one way to read a
 * reply into them.
 *
 * A model reply is text. Asked for JSON, a model often wraps it in a markdown
 * fence or writes a sentence around it, and each reader used to parse it its
 * own way: the pipeline reader parsed the raw text, so a fenced draft read as
 * no JSON at all and came back with no step. The defaults these schemas fill
 * in are the ones the readers applied field by field.
 */

/** The first fenced block of a reply, with or without a `json` tag. */
const FENCED_BLOCK = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;

/**
 * Parse a model reply as JSON and read it with `schema`.
 *
 * The JSON is the first fenced block when the reply has one, the whole trimmed
 * reply otherwise.
 *
 * @throws Error when the reply is not JSON, or its JSON does not fit `schema`.
 *   The message quotes neither the reply nor its values: a reply can repeat org
 *   data back.
 */
export function parseModelJson<S extends z.ZodTypeAny>(schema: S, reply: string): z.output<S> {
  const trimmed = reply.trim();
  const fenced = FENCED_BLOCK.exec(trimmed);
  const text = fenced ? fenced[1].trim() : trimmed;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The AI reply is not valid JSON.');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error('The AI reply is JSON, but not in the expected format.');
  }
  return result.data as z.output<S>;
}

/** An array read item by item: the items that fit `item` are kept, the rest dropped. */
function keepFitting<T extends z.ZodTypeAny>(
  item: T,
): z.ZodEffects<z.ZodArray<z.ZodUnknown>, Array<z.output<T>>> {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((entry): Array<z.output<T>> => {
      const parsed = item.safeParse(entry);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
}

/** A JSON object, and nothing else: not an array, not null. */
const JsonObjectSchema = z.record(z.unknown());

/** One step of a pipeline draft. A step with no name or no type cannot be placed on the canvas. */
const PipelineDraftStepSchema = z.object({
  name: z.string(),
  type: z.string(),
  config: JsonObjectSchema.catch({}),
  description: z.string().catch(''),
});

/** A pipeline draft. Steps that do not fit are dropped; a draft left with none is the caller's to refuse. */
export const PipelineDraftReplySchema = z.object({
  name: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  steps: keepFitting(PipelineDraftStepSchema).catch([]),
  schedule: z.string().optional().catch(undefined),
  triggers: keepFitting(z.string()).optional().catch(undefined),
});

/** Improvement suggestions for a pipeline: the strings of an array. */
export const PipelineSuggestionsReplySchema = keepFitting(z.string());

/** A natural-language-to-SOQL draft. */
export const NL2SOQLReplySchema = z.object({
  soql: z.string().catch(''),
  explanation: z.string().catch(''),
  confidence: z.number().catch(0),
  alternatives: keepFitting(z.string()).optional().catch(undefined),
});

/**
 * A custom Seed persona. Each data pattern stays unread here: whether Seed can
 * generate it depends on generator params the extension checks.
 */
export const PersonaReplySchema = z.object({
  name: z.string().catch('Custom Persona'),
  description: z.string().catch(''),
  industry: z.string().catch('General'),
  locale: z.string().catch('en-US'),
  dataPatterns: JsonObjectSchema.catch({}),
});

/**
 * Generated records. An array keeps its objects, a single object is one
 * record, and any other JSON value carries no record.
 */
export const DataRowsReplySchema = z.union([
  keepFitting(JsonObjectSchema),
  JsonObjectSchema.transform((row) => [row]),
  z.unknown().transform((): Array<Record<string, unknown>> => []),
]);
