import { describe, it, expect } from 'vitest';
import { answerParts } from './answerParts';

describe('answerParts', () => {
  it('sets a ``` block apart from the text around it, without its fences or language', () => {
    expect(
      answerParts(
        "Here's the SOQL:\n```sql\nSELECT Id, Name FROM Account\nWHERE Industry = 'Retail'\n```\nIt returns every retail account.",
      ),
    ).toEqual([
      { kind: 'text', text: "Here's the SOQL:" },
      { kind: 'code', code: "SELECT Id, Name FROM Account\nWHERE Industry = 'Retail'" },
      { kind: 'text', text: 'It returns every retail account.' },
    ]);
  });

  it('keeps an answer with no block as one text, line breaks and markup as written', () => {
    const answer = 'Two steps:\n\n1. Seed the **accounts**\n2. Then the contacts';
    expect(answerParts(answer)).toEqual([{ kind: 'text', text: answer }]);
  });

  it('reads two blocks in a row, and a block that opens the answer', () => {
    expect(answerParts('```\nSELECT Id FROM Lead\n```\n```apex\nSystem.debug(1);\n```')).toEqual([
      { kind: 'code', code: 'SELECT Id FROM Lead' },
      { kind: 'code', code: 'System.debug(1);' },
    ]);
  });

  it('runs a block the answer leaves open to the end, as one cut off by the token limit', () => {
    expect(answerParts('Query:\n```sql\nSELECT Id\nFROM Case')).toEqual([
      { kind: 'text', text: 'Query:' },
      { kind: 'code', code: 'SELECT Id\nFROM Case' },
    ]);
  });

  it('closes a block only on a fence as long as the one that opened it, with nothing after it', () => {
    expect(answerParts('````md\nA fence inside:\n```sql\nSELECT Id\n```\n````\nDone.')).toEqual([
      { kind: 'code', code: 'A fence inside:\n```sql\nSELECT Id\n```' },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('keeps the indentation of the code, and reads Windows line ends', () => {
    expect(answerParts('```\r\nif (a) {\r\n    b();\r\n}\r\n```')).toEqual([
      { kind: 'code', code: 'if (a) {\n    b();\n}' },
    ]);
  });

  it('leaves out an empty block and the blank lines around a block', () => {
    expect(answerParts('Nothing here:\n\n```\n\n```\n\nThe end.')).toEqual([
      { kind: 'text', text: 'Nothing here:' },
      { kind: 'text', text: 'The end.' },
    ]);
  });

  it('takes backticks inside a line for text, not for a fence', () => {
    const answer = 'Use `Id` here, and ```inline``` stays text.';
    expect(answerParts(answer)).toEqual([{ kind: 'text', text: answer }]);
    expect(answerParts('Run:\n```SELECT Id FROM Account```')).toEqual([
      { kind: 'text', text: 'Run:\n```SELECT Id FROM Account```' },
    ]);
  });
});
