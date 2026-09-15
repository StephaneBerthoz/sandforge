import { describe, it, expect } from 'vitest';

import { formatPinoLine } from './formatPinoLine.js';
import { TelemetryAdapter } from './TelemetryAdapter.js';

const TIME = Date.UTC(2026, 8, 15, 10, 30, 0, 123);

function pinoChunk(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ pid: 4242, hostname: 'host', name: 'sandforge', ...fields })}\n`;
}

describe('formatPinoLine', () => {
  it('renders time, level and message in the output channel layout', () => {
    expect(
      formatPinoLine(pinoChunk({ level: 30, time: TIME, msg: 'secret migration complete' })),
    ).toBe('[2026-09-15T10:30:00.123Z] [INFO] secret migration complete');
  });

  it('maps every pino level to its name', () => {
    const names = [10, 20, 30, 40, 50, 60].map(
      (level) => formatPinoLine(pinoChunk({ level, time: TIME, msg: 'm' })).split(' ')[1],
    );
    expect(names).toEqual(['[TRACE]', '[DEBUG]', '[INFO]', '[WARN]', '[ERROR]', '[FATAL]']);
  });

  it('keeps an unknown numeric level visible instead of guessing a name', () => {
    expect(formatPinoLine(pinoChunk({ level: 35, time: TIME, msg: 'm' }))).toBe(
      '[2026-09-15T10:30:00.123Z] [LEVEL 35] m',
    );
  });

  it('appends the extra fields as JSON, without pino bookkeeping', () => {
    const line = formatPinoLine(
      pinoChunk({ level: 30, time: TIME, msg: 'done', event: 'secret_migration', count: 2 }),
    );
    expect(line).toBe(
      '[2026-09-15T10:30:00.123Z] [INFO] done {"event":"secret_migration","count":2}',
    );
    expect(line).not.toContain('hostname');
    expect(line).not.toContain('4242');
  });

  it('falls back to the raw line when the chunk is not a pino record', () => {
    expect(formatPinoLine('not json at all\n')).toBe('not json at all');
    expect(formatPinoLine('[1,2,3]\n')).toBe('[1,2,3]');
    expect(formatPinoLine('{"msg":"no level"}\n')).toBe('{"msg":"no level"}');
    expect(formatPinoLine('{"level":30,"msg":"cut sho')).toBe('{"level":30,"msg":"cut sho');
  });

  it('keeps the redaction pino applied before the line reaches the channel', () => {
    const lines: string[] = [];
    const adapter = new TelemetryAdapter({
      pinoDestination: {
        write: (chunk: string) => {
          lines.push(formatPinoLine(chunk));
          return true;
        },
      },
    });

    adapter.getLogger().info({ config: { accessToken: 'tok-live-123' } }, 'connected');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] connected /);
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]).not.toContain('tok-live-123');
  });
});
