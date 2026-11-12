/**
 * A script for `wholeOutput.test.ts`: a run that asked who the session is of
 * a target that never answers, then ended. It writes when it ended to stdout,
 * then goes as `sandforge-sync` and `sandforge-seed` go once `main` returns,
 * with `process.exit()` — unless its first argument is `left`, which leaves it
 * to whatever is still pending.
 */
import { keepRunUser } from '../../src/modules/sync/runUser.js';

const [mode] = process.argv.slice(2);
keepRunUser({ runUser: () => undefined }, () => new Promise(() => undefined), 'silent target');
process.stdout.write(String(Date.now()));
if (mode !== 'left') process.exit(process.exitCode ?? 0);
