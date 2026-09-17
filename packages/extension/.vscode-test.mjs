import { defineConfig } from '@vscode/test-cli';

/**
 * The smoke suite runs in a real VS Code, downloaded on first use.
 *
 * `--disable-extensions` keeps other extensions out of the run, so a failure
 * is this extension's. The workspace is empty on purpose: SandForge activates
 * on its own views and commands, not on a folder's contents.
 */
export default defineConfig({
  files: 'out-smoke/test/smoke/**/*.smoke.test.js',
  version: 'stable',
  launchArgs: ['--disable-extensions', '--disable-gpu'],
  mocha: { ui: 'tdd', timeout: 60_000 },
});
