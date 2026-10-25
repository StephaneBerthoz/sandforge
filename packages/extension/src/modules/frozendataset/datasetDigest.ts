/**
 * The digest of a frozen dataset: what an environment pins a dataset by, and
 * what tells it the dataset it was given is not the one it planned with.
 *
 * It is taken over what a load reads — the manifest, every `data/*.json`, the
 * record types, the person accounts' contacts and the platform's records —
 * and over nothing else: a file a load never reads changes nothing it writes.
 * Each file is named by its path inside the dataset, with `/` whatever the
 * platform, and the names are sorted by their code units, never by a locale:
 * a folder moved, copied or unpacked on another machine keeps its digest.
 *
 * The manifest is read without the verdict a verification writes back into it
 * (`controls.dryRunLoad`), and as JSON with its keys sorted: every load's
 * verification rewrites it, and a dataset loaded twice is still the dataset
 * it was.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PLATFORM_RECORDS_FILE_NAME } from './FrozenDatasetWriter.js';

/** The manifest, which every dataset has. */
const MANIFEST_FILE = 'manifest.json';

/** The files beside the data files a load reads when they are there. */
const OPTIONAL_FILES = [
  'record-types.json',
  'personcontact-sidecar.json',
  PLATFORM_RECORDS_FILE_NAME,
];

/** The folder of the data files, one per object. */
const DATA_DIR = 'data';

/** The shape the digest is given in, which an environment's file pins. */
const DIGEST_PREFIX = 'sha256:';

/**
 * The digest of the frozen dataset in `dir`: `sha256:` and 64 hexadecimal
 * digits. It changes when the content of any file a load reads changes, when
 * such a file comes or goes, and when an object's data file does; not when
 * the dataset is moved or copied, nor when a verification writes its verdict
 * into the manifest.
 *
 * @throws When `dir` holds no manifest: no dataset was frozen there.
 */
export async function frozenDatasetDigest(dir: string): Promise<string> {
  const manifest = await readIfThere(path.join(dir, MANIFEST_FILE));
  if (manifest === undefined) {
    throw new Error(`No frozen dataset at ${dir}: it holds no ${MANIFEST_FILE}.`);
  }
  const files: Array<{ name: string; content: Buffer }> = [
    { name: MANIFEST_FILE, content: manifestWithoutItsVerdict(manifest) },
  ];
  for (const name of OPTIONAL_FILES) {
    const content = await readIfThere(path.join(dir, name));
    if (content !== undefined) files.push({ name, content });
  }
  for (const name of await dataFileNames(path.join(dir, DATA_DIR))) {
    const content = await readIfThere(path.join(dir, DATA_DIR, name));
    if (content !== undefined) files.push({ name: `${DATA_DIR}/${name}`, content });
  }

  const digest = createHash('sha256');
  for (const { name, content } of files.sort((a, b) => byCodeUnits(a.name, b.name))) {
    // Each file's own hash, after its name: no file's bytes can run into the
    // next one's name.
    digest.update(`${name}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return `${DIGEST_PREFIX}${digest.digest('hex')}`;
}

/** The names of the data files, as the load lists them: those ending in `.json`. */
async function dataFileNames(dataDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dataDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((name) => name.endsWith('.json'));
}

/** A file's bytes, or undefined when there is no such file. */
async function readIfThere(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * The manifest as the digest reads it: its JSON with its keys sorted and the
 * verdict a verification writes back left out. Bytes that are not JSON are
 * read as they are.
 */
function manifestWithoutItsVerdict(content: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    return content;
  }
  if (isRecord(parsed) && isRecord(parsed.controls)) {
    const controls: Record<string, unknown> = { ...parsed.controls };
    delete controls.dryRunLoad;
    parsed = { ...parsed, controls };
  }
  return Buffer.from(sortedJson(parsed), 'utf8');
}

/** JSON with every object's keys sorted by their code units. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort(byCodeUnits);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Two strings in the order of their UTF-16 code units: the same on every machine. */
function byCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
