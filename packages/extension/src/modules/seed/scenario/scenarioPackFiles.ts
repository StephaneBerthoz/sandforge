/**
 * The scenario packs a seed can be written from: those SandForge ships, and
 * those kept in the user's workspace as `*.sandforge-scenario.json` files —
 * a pack drafted from the user's own text, or a shipped one edited, saved
 * once reviewed and seeded from there, panel and command line alike, with
 * no AI key.
 *
 * A file of that name that does not read as a pack is listed with why, not
 * left out: a pack edited by hand with one field too long would otherwise
 * vanish from the gallery with no word of the field.
 *
 * The pack of a run is found again by its id and its fingerprint, which the
 * run's companion file keeps: a test file is written from the pack as the run
 * wrote it, never from one edited since.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ScenarioPack, SeedScenarioPackEntry } from '@sandforge/shared';
import { BUILT_IN_SCENARIO_PACKS, scenarioPackSchema } from '@sandforge/shared';
import { scenarioPackFingerprint } from './scenarioRunSidecar';

/** What a pack's file is named by, after the pack's id. */
export const SCENARIO_PACK_FILE_SUFFIX = '.sandforge-scenario.json';

/**
 * How deep under a workspace folder pack files are looked for, and how many
 * at most: a pack sits at the root or in a folder of scenarios, and a
 * workspace of thousands of files is not walked to find one.
 */
export const SCENARIO_PACK_SEARCH = { depth: 3, files: 50 } as const;

/** Folders never walked: the tools' own, and dependencies. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'out', 'coverage']);

/** Most issues a file that does not read as a pack is listed with. */
const ISSUES_SAID = 10;

/** The file operations packs are listed, read and saved with. */
export interface ScenarioPackFiles {
  /** The names directly in a folder, folders marked; none when it is not there. */
  list: (dirPath: string) => Promise<Array<{ name: string; folder: boolean }>>;
  readFile: (filePath: string) => Promise<string>;
  /** Write a file that is not there: false, and nothing written, when one is. */
  writeNew: (filePath: string, content: string) => Promise<boolean>;
  /** Write a file over the one there, whole. */
  replace: (filePath: string, content: string) => Promise<void>;
}

/** The packs' file operations over Node's file system. */
export function nodeScenarioPackFiles(): ScenarioPackFiles {
  return {
    list: async (dirPath) => {
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, folder: entry.isDirectory() }));
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return [];
        throw err;
      }
    },
    readFile: (filePath) => readFile(filePath, 'utf8'),
    writeNew: async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      try {
        await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
    },
    replace: async (filePath, content) => {
      const written = `${filePath}.${process.pid}.tmp`;
      await writeFile(written, content, 'utf8');
      await rename(written, filePath);
    },
  };
}

/** A pack file's text read as a pack, or every issue of it, each where it is. */
export function readScenarioPackText(text: string): { pack: ScenarioPack } | { issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { issues: ['The file is not JSON'] };
  }
  const parsed = scenarioPackSchema.safeParse(raw);
  if (parsed.success) return { pack: parsed.data };
  return {
    issues: parsed.error.issues
      .slice(0, ISSUES_SAID)
      .map((issue) => `${issue.path.join('.') || 'the file'}: ${issue.message}`),
  };
}

/** The pack files under the workspace's folders, as far as the search goes, in name order. */
export async function findScenarioPackFiles(
  files: ScenarioPackFiles,
  folders: readonly string[],
): Promise<Array<{ path: string; relativePath: string }>> {
  const found: Array<{ path: string; relativePath: string }> = [];
  const walk = async (root: string, dir: string, depth: number): Promise<void> => {
    const entries = [...(await files.list(dir))].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= SCENARIO_PACK_SEARCH.files) return;
      const full = path.join(dir, entry.name);
      if (entry.folder) {
        if (depth < SCENARIO_PACK_SEARCH.depth && !skipped(entry.name)) {
          await walk(root, full, depth + 1);
        }
      } else if (entry.name.endsWith(SCENARIO_PACK_FILE_SUFFIX)) {
        found.push({
          path: full,
          relativePath: path.relative(root, full).split(path.sep).join('/'),
        });
      }
    }
  };
  for (const folder of folders) await walk(folder, folder, 0);
  return found;
}

/** Whether a folder is one the search does not walk. */
function skipped(name: string): boolean {
  return name.startsWith('.') || SKIPPED_FOLDERS.has(name);
}

/** The packs SandForge ships, then those of the workspace, each read or said why not. */
export async function listScenarioPacks(
  files: ScenarioPackFiles,
  folders: readonly string[],
): Promise<SeedScenarioPackEntry[]> {
  const entries: SeedScenarioPackEntry[] = BUILT_IN_SCENARIO_PACKS.map((pack) => ({
    source: 'built-in',
    pack,
  }));
  for (const file of await findScenarioPackFiles(files, folders)) {
    let text: string;
    try {
      text = await files.readFile(file.path);
    } catch {
      entries.push({ source: 'workspace', ...file, issues: ['The file could not be read'] });
      continue;
    }
    const read = readScenarioPackText(text);
    entries.push({ source: 'workspace', ...file, ...read });
  }
  return entries;
}

/** A pack as its file holds it: two spaces a level, a line break at the end. */
export function scenarioPackText(pack: ScenarioPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/** What saving a pack did. */
export type ScenarioPackSave =
  | { kind: 'saved'; path: string; relativePath: string }
  | { kind: 'exists'; path: string; relativePath: string }
  | { kind: 'no-workspace' };

/**
 * Save a pack at the root of the first workspace folder, named after its id,
 * never over a file there unless told to: a pack is reviewed as code, and one
 * edited by hand since is the user's.
 */
export async function saveScenarioPack(
  files: ScenarioPackFiles,
  folders: readonly string[],
  pack: ScenarioPack,
  overwrite = false,
): Promise<ScenarioPackSave> {
  const folder = folders[0];
  if (folder === undefined) return { kind: 'no-workspace' };
  const kept = scenarioPackSchema.parse(pack);
  const relativePath = `${kept.id}${SCENARIO_PACK_FILE_SUFFIX}`;
  const file = path.join(folder, relativePath);
  const text = scenarioPackText(kept);
  if (overwrite) await files.replace(file, text);
  else if (!(await files.writeNew(file, text))) return { kind: 'exists', path: file, relativePath };
  return { kind: 'saved', path: file, relativePath };
}

/**
 * The pack a run was seeded from, by its id and its fingerprint: a shipped
 * one, or one of the workspace's files. Undefined when none is that pack as
 * it was: edited since, or no longer there.
 */
export async function findScenarioPack(
  files: ScenarioPackFiles,
  folders: readonly string[],
  packId: string,
  fingerprint: string,
): Promise<ScenarioPack | undefined> {
  const same = (pack: ScenarioPack): boolean =>
    pack.id === packId && scenarioPackFingerprint(pack) === fingerprint;
  const shipped = BUILT_IN_SCENARIO_PACKS.find(same);
  if (shipped) return shipped;
  for (const entry of await listScenarioPacks(files, folders)) {
    if (entry.source === 'workspace' && 'pack' in entry && same(entry.pack)) return entry.pack;
  }
  return undefined;
}
