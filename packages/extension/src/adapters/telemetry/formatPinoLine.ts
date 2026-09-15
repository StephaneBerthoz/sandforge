import { z } from 'zod';

/** Pino's numeric levels, by the name the output channel shows. */
const LEVEL_NAMES: Readonly<Record<number, string>> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** Fields pino adds to every record; the formatted line carries them elsewhere or not at all. */
const BOOKKEEPING_FIELDS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'name', 'v']);

/** The part of a pino JSON record the formatter relies on; everything else passes through. */
const PinoRecord = z
  .object({
    level: z.number(),
    time: z.number().finite().optional(),
    msg: z.string().optional(),
  })
  .passthrough();

/**
 * Turn one pino JSON chunk into an output channel line in the layout the
 * extension logger already uses: `[ISO time] [LEVEL] message {extra}`.
 *
 * Pino writes one JSON object per line, which made the SandForge channel a
 * wall of `{"level":30,"time":…,"pid":…}` next to readable logger lines.
 * Redaction has already been applied by pino when the chunk arrives, so the
 * extra fields are printed as they are. Anything that is not a pino record
 * (malformed, cut short, no numeric level) is returned unchanged, minus its
 * trailing newline, so nothing written to the channel is ever lost.
 *
 * A pure function rather than a pino transport: transports run in worker
 * threads, which a bundled extension cannot load reliably.
 */
export function formatPinoLine(chunk: string): string {
  const raw = chunk.replace(/\n$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const result = PinoRecord.safeParse(parsed);
  if (!result.success) {
    return raw;
  }
  const record = result.data;
  const level = LEVEL_NAMES[record.level] ?? `LEVEL ${record.level}`;
  const time = new Date(record.time ?? Date.now()).toISOString();
  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => !BOOKKEEPING_FIELDS.has(key)),
  );
  const extraText = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  return `[${time}] [${level}] ${record.msg ?? ''}${extraText}`;
}
