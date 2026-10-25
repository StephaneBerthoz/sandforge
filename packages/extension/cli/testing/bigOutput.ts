/**
 * A script for `wholeOutput.test.ts`: writes the number of bytes it is given
 * to stdout, then ends at once as every script does, with `process.exit()` —
 * through `holdOutputWhole` unless its first argument is `loose`.
 */
import { holdOutputWhole } from '../wholeOutput.js';

const [mode, size] = process.argv.slice(2);
if (mode !== 'loose') holdOutputWhole();
process.stdout.write('x'.repeat(Number(size)));
process.exit(0);
