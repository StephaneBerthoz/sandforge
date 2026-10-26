import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ANSWER_EXCERPT_CHARS,
  StepAnswerError,
  canonicalJson,
  pathText,
  readAnswer,
  reasonLineOf,
  refusalAt,
  sha256,
  valueOf,
} from './common.js';

/*
 * What every kind of resource shares: where a refusal stands, the canonical
 * text a fingerprint is of, the values a line takes, and the reading of a
 * script's answer, which never takes what it cannot read for a default.
 */

describe('what every kind shares', () => {
  it('names a place of the file as a line says it, and the resource a refusal is of', () => {
    expect(pathText([])).toBe('the file');
    expect(pathText(['resources', 'accounts', 'objects', 0, 'count'])).toBe(
      'resources.accounts.objects[0].count',
    );
    expect(refusalAt(['resources', 'cloned', 'record'], 'no row')).toEqual({
      path: ['resources', 'cloned', 'record'],
      resource: 'cloned',
      message: 'no row',
    });
    expect(refusalAt(['orgs', 'uat'], 'unset')).not.toHaveProperty('resource');
  });

  it('writes the same canonical text of two documents that say the same in another order', () => {
    const a = canonicalJson({ b: [2, { d: 1, c: undefined }], a: 1 });

    expect(a).toBe('{"a":1,"b":[2,{"d":1}]}');
    expect(canonicalJson({ a: 1, b: [2, { d: 1 }] })).toBe(a);
    expect(sha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(a)).not.toBe(sha256(canonicalJson({ a: 1, b: [{ d: 1 }, 2] })));
  });

  it('puts no value on a line that the script would read as a flag', () => {
    expect(valueOf('--where', "Name = 'a-b'")).toBe("Name = 'a-b'");
    expect(() => valueOf('--where', '-1 < Amount')).toThrow(
      '--where cannot be "-1 < Amount": a value that starts with "-" reads as a flag.',
    );
    expect(() => valueOf('--target', '')).toThrow('--target cannot be ""');
  });

  it('reads an answer with its schema, or names the script and quotes the first of what it printed', () => {
    const schema = z.object({ tool: z.literal('sandforge-clone') });

    expect(
      readAnswer('sandforge-clone', 'a summary', schema, '{"tool":"sandforge-clone"}'),
    ).toEqual({
      tool: 'sandforge-clone',
    });
    expect(() => readAnswer('sandforge-clone', 'a summary', schema, '')).toThrow(
      'sandforge-clone did not answer a summary (not JSON): it printed nothing on stdout',
    );
    const long = `refused ${'x'.repeat(ANSWER_EXCERPT_CHARS)}`;
    try {
      readAnswer('sandforge-clone', 'a summary', schema, long);
      expect.unreachable('a line that is no JSON was read');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(StepAnswerError);
      expect((err as StepAnswerError).excerpt).toHaveLength(ANSWER_EXCERPT_CHARS);
    }
    expect(() =>
      readAnswer('sandforge-clone', 'a summary', schema, '{"tool":"sandforge-seed"}'),
    ).toThrow(/sandforge-clone did not answer a summary \(tool: /);
  });
});

describe('why a script stopped, as it said it on stderr', () => {
  it('is the last line it said, trimmed, past the closing words that say nothing of why', () => {
    expect(
      reasonLineOf(
        'reading the source…\r\n  12 rows\nThe run would write 6 records, more than --max-total 5. Nothing was written.\n',
      ),
    ).toBe('The run would write 6 records, more than --max-total 5. Nothing was written.');
    expect(reasonLineOf('The store /x is not a folder.\nNothing written.\n\n')).toBe(
      'The store /x is not a folder.',
    );
    expect(reasonLineOf('Refused: no parent left.\nNothing was deleted.')).toBe(
      'Refused: no parent left.',
    );
  });

  it('is nothing when it said nothing there', () => {
    expect(reasonLineOf('')).toBeUndefined();
    expect(reasonLineOf('\n  \nNothing was written.\n')).toBeUndefined();
  });
});
