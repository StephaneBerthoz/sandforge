/** A run of an answer: text shown as written, or the code of a ``` block. */
export type AnswerPart = { kind: 'text'; text: string } | { kind: 'code'; code: string };

/** A line that opens or closes a ``` block: up to three spaces, then three backticks or more. */
const FENCE = /^ {0,3}(`{3,})(.*)$/;

/**
 * An answer cut into its text and its ``` blocks, in order.
 *
 * The page printed the model's Markdown as it came: a SOQL query arrived
 * between two literal "```sql" lines and could not be copied without them.
 * Only the blocks are set apart — read line by line, as Markdown reads them,
 * so nothing is ever parsed into HTML — and their language and fences are
 * left out of the code. A block the answer leaves open, cut off by the token
 * limit, runs to its end. The line breaks around a block go with it, and a
 * part with nothing in it is left out.
 */
export function answerParts(content: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  let fence = '';

  const flushText = (): void => {
    const joined = text.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined.trim()) parts.push({ kind: 'text', text: joined });
    text = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const match = FENCE.exec(line);
    if (code === null) {
      // "```SELECT Id```" on a line of its own is code inline, in text, as
      // Markdown reads it: what follows an opening fence holds no backtick.
      if (match && !match[2].includes('`')) {
        flushText();
        code = [];
        fence = match[1];
      } else {
        text.push(line);
      }
      continue;
    }
    // A block closes on a fence at least as long as the one that opened it,
    // with nothing after it.
    if (match && match[1].length >= fence.length && match[2].trim() === '') {
      if (code.join('\n').trim()) parts.push({ kind: 'code', code: code.join('\n') });
      code = null;
    } else {
      code.push(line);
    }
  }
  if (code !== null && code.join('\n').trim()) parts.push({ kind: 'code', code: code.join('\n') });
  flushText();
  return parts;
}
