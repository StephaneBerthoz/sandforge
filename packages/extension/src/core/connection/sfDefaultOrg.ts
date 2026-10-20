import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where {@link readSfDefaultOrg} looks, passed in so a test can point it at a temporary folder. */
export interface SfDefaultOrgSources {
  /** The workspace folders, first first: the project the CLI would run in. */
  folders: readonly string[];
  /** The user's home directory, which holds the CLI's global configuration. */
  homeDir: string;
  /** The extension host's environment, read for `SF_TARGET_ORG`. */
  env: Readonly<Record<string, string | undefined>>;
}

/** A value one configuration file gives, with the time the file was last written. */
interface FileValue {
  value: string;
  writtenAt: number;
}

/** Folders climbed from a workspace folder before giving up on finding its project. */
const MAX_PROJECT_DEPTH = 32;

/**
 * The org the Salesforce CLI targets by default for this workspace: its alias
 * or username as `sf config get target-org` reports it, or undefined.
 *
 * Read from the CLI's own files rather than by running it. Running
 * `sf config get target-org` at every activation started a Node process of a
 * second or more in every VS Code window, with no org registered as much as
 * with ten, and never saw the project's default either: the process ran in the
 * extension host's directory, not the workspace's, so the CLI looked for a
 * project there, found none, and answered with the global default only.
 *
 * The order is the CLI's (@salesforce/core's ConfigAggregator): the
 * `SF_TARGET_ORG` variable, then the project's configuration, then the user's.
 * A project is the folder holding `sfdx-project.json`, found by climbing from
 * the first workspace folder that sits in one. At each level the CLI keeps two
 * files, `.sf/config.json` (`target-org`) and `.sfdx/sfdx-config.json`
 * (`defaultusername`, the older name), and the one written last wins.
 *
 * Never throws: a missing or unreadable file is a level with no default.
 */
export async function readSfDefaultOrg(sources: SfDefaultOrgSources): Promise<string | undefined> {
  const fromEnv = sources.env.SF_TARGET_ORG?.trim() || sources.env.SFDX_DEFAULTUSERNAME?.trim();
  if (fromEnv) return fromEnv;

  for (const folder of sources.folders) {
    const project = await projectRoot(folder);
    if (project === undefined) continue;
    const local = await defaultAt(project);
    if (local) return local;
    break;
  }
  return defaultAt(sources.homeDir);
}

/** The folder at or above `folder` that holds `sfdx-project.json`, if any. */
async function projectRoot(folder: string): Promise<string | undefined> {
  let current = folder;
  for (let depth = 0; depth < MAX_PROJECT_DEPTH; depth++) {
    if (await isFile(join(current, 'sfdx-project.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** The default org the two configuration files under `root` give, the last written winning. */
async function defaultAt(root: string): Promise<string | undefined> {
  const [current, older] = await Promise.all([
    valueOf(join(root, '.sf', 'config.json'), 'target-org'),
    valueOf(join(root, '.sfdx', 'sfdx-config.json'), 'defaultusername'),
  ]);
  if (current && older) return older.writtenAt > current.writtenAt ? older.value : current.value;
  return (current ?? older)?.value;
}

/** The string `key` holds in the JSON file at `path`, with the file's write time. */
async function valueOf(path: string, key: string): Promise<FileValue | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    return { value: value.trim(), writtenAt: info.mtimeMs };
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
