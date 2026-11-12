import { homedir, userInfo } from 'node:os';

/**
 * Variables VS Code keeps out of a terminal it opens, by the rules of its own
 * `sanitizeProcessEnvironment` (src/vs/base/common/processes.ts): they belong
 * to its processes, not to the programs a user runs. The extension host
 * carries them, `ELECTRON_RUN_AS_NODE=1` among them (set for every extension
 * by extensionHostProcess.ts), and an `sf` started with the host's
 * environment inherited them all.
 *
 * On a Windows laptop `sf org list --json` printed 40 KB in a terminal of the
 * window and nothing when the extension ran it. Without these, what VS Code
 * adds for itself no longer tells the two apart; what else does (PATH, the
 * folder sf runs from) is what the diagnostics below report.
 */
const HOST_ONLY_VARIABLES = [
  /^ELECTRON_.+$/,
  /^VSCODE_(?!(PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)).+$/,
  /^SNAP(|_.*)$/,
  /^GDK_PIXBUF_.+$/,
];

/**
 * Variables that change how `sf` reaches Salesforce or how its Node starts:
 * a proxy, a certificate, Node's own options. VS Code removes `NODE_OPTIONS`
 * from the extension host (`removeDangerousEnvVariables`) and leaves it to a
 * terminal. Their presence is reported, never their value.
 */
const WATCHED_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
];

/** Whether `name` is a variable of VS Code's own processes, which a terminal does not get. */
export function isHostOnlyVariable(name: string): boolean {
  return HOST_ONLY_VARIABLES.some((pattern) => pattern.test(name));
}

/**
 * The environment every `sf` run of the extension starts with: the host's,
 * less what a terminal of the window would not have, with colours off so a
 * `--json` document holds no escape codes.
 *
 * @param hostEnv - The extension host's environment.
 */
export function sfChildEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (!isHostOnlyVariable(name)) env[name] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

/**
 * Which of the variables that matter to `sf` the host holds, by name only:
 * the watched ones, every `SF_` and `SFDX_` one, and those kept from `sf`.
 *
 * @param hostEnv - The extension host's environment.
 */
export function describeSfVariables(hostEnv: NodeJS.ProcessEnv = process.env): string {
  const names = Object.keys(hostEnv).filter((name) => (hostEnv[name] ?? '') !== '');
  const watched = WATCHED_VARIABLES.filter((wanted) =>
    names.some((name) => name.toUpperCase() === wanted),
  );
  const cli = names.filter((name) => /^(SF|SFDX)_/i.test(name)).sort();
  const kept = names.filter((name) => isHostOnlyVariable(name));
  const electron = kept.filter((name) => name.startsWith('ELECTRON_')).sort();
  const others = kept.length - electron.length;
  const keptSaid =
    kept.length === 0
      ? 'none'
      : [...electron, ...(others > 0 ? [`${others} VSCODE_ or other VS Code variables`] : [])].join(
          ', ',
        );
  return (
    `set: ${watched.length > 0 ? watched.join(', ') : 'none of ' + WATCHED_VARIABLES.join(', ')}; ` +
    `SF_/SFDX_: ${cli.length > 0 ? cli.join(', ') : 'none'}; ` +
    `not passed to sf, as a terminal does not get them: ${keptSaid}`
  );
}

/** The name the user signed in to the machine with, or '' when it cannot be read. */
function currentUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? '';
  }
}

/** `value` with every character a regular expression would act on escaped. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` fit to be shown or pasted into a public issue: the home folder as
 * `~`, the machine's user name as `<user>` where it is a folder of a path, an
 * email-shaped username as `<username>` and an access token as `<token>`.
 *
 * @param home - The home folder to hide.
 * @param user - The user name to hide.
 */
export function withoutPersonalDetails(
  text: string,
  home: string = homedir(),
  user: string = currentUserName(),
): string {
  let out = text;
  // A home folder of one or two characters would replace far more than itself.
  if (home.length > 3) {
    out = out.replace(new RegExp(escapeForPattern(home), 'gi'), '~');
  }
  if (user.length >= 2) {
    out = out.replace(
      new RegExp(`(?<=[\\\\/])${escapeForPattern(user)}(?=[\\\\/]|$)`, 'gim'),
      '<user>',
    );
  }
  return out
    .replace(/00D\w{12,15}![\w.]+/g, '<token>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<username>');
}

/** The first line of `text` that holds anything, trimmed, or undefined. */
export function firstLineOf(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** What `where` (Windows) or `which -a` found for `sf` and for `node`, each in search order. */
export interface SfLocation {
  sf: string[];
  node: string[];
  /**
   * The `sf` the shell runs: the first one found, and on Windows the first
   * whose extension is one cmd.exe runs (PATHEXT). npm puts an extensionless
   * shell script next to `sf.cmd`, which `where` lists first and cmd.exe skips.
   */
  runs?: string;
  /** Why the search could not run, when it could not. */
  failure?: string;
}

/** The first of `paths` the shell would start, as {@link SfLocation.runs} says. */
function runByTheShell(paths: string[], env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'win32') return paths[0];
  const pathExt = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATHEXT')?.[1];
  const extensions = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.length > 0);
  return paths.find((path) => {
    const dot = path.lastIndexOf('.');
    return (
      dot > Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) &&
      extensions.includes(path.slice(dot).toLowerCase())
    );
  });
}

/** Error from exec, which carries what the command printed before it failed. */
interface ExecFailure extends Error {
  stdout?: unknown;
}

/**
 * Where the shell of an `sf` run finds `sf`, and `node`, in the environment
 * and the folder the extension starts `sf` from: `where sf node` on Windows,
 * which looks in the current folder before PATH as cmd.exe does, and
 * `which -a sf node` elsewhere. npm's `sf.cmd` runs the `node` next to it,
 * or the first one cmd.exe finds, so both are said.
 *
 * Never throws; every path is returned without personal details.
 */
export async function locateSf(timeoutMs = 10_000): Promise<SfLocation> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const command = process.platform === 'win32' ? 'where sf node' : 'which -a sf node';
  const env = sfChildEnv();
  let printed: string;
  let failure: string | undefined;
  try {
    const result = await promisify(exec)(command, { timeout: timeoutMs, windowsHide: true, env });
    printed = String(result.stdout);
  } catch (err: unknown) {
    // Both commands exit 1 when one of the names is not found, after
    // printing the paths of the other.
    const execErr = err as ExecFailure;
    printed = String(execErr.stdout ?? '');
    if (printed.trim() === '') failure = withoutPersonalDetails(execErr.message ?? String(err));
  }
  const lines = printed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => withoutPersonalDetails(line));
  const named = (name: string): string[] =>
    lines.filter((line) => new RegExp(`(^|[\\\\/])${name}(\\.[A-Za-z0-9]+)?$`, 'i').test(line));
  const sf = named('sf');
  const runs = runByTheShell(sf, env);
  return {
    sf,
    node: named('node'),
    ...(runs !== undefined ? { runs } : {}),
    ...(failure ? { failure } : {}),
  };
}
