import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The two files a run sends its output to. */
export interface OutputFilePaths {
  stdout: string;
  stderr: string;
}

/** What a run wrote to its two files, and how it failed when it did. */
export interface OutputFiles {
  stdout: string;
  stderr: string;
  /** What the run threw, when it did: a command that exits non-zero still leaves its files. */
  failure?: unknown;
}

/**
 * Give `run` two files of a folder of its own in the user's temp folder, read
 * what it wrote to them, and remove the folder, whatever happens.
 *
 * The paths are made here and nowhere else: this reads no file it was handed,
 * so the modules a sign-in runs through, which open no file, can use it
 * without being able to read the key file a JWT sign-in names. The folder
 * goes even when the run fails: what `sf org list` writes there holds every
 * org of the CLI, with its token on a CLI older than 2.150.
 *
 * @throws When the folder cannot be made; a failure of `run` is returned.
 */
export async function readOutputFiles(
  run: (paths: OutputFilePaths) => Promise<void>,
): Promise<OutputFiles> {
  const folder = await mkdtemp(join(tmpdir(), 'sandforge-sf-'));
  try {
    const paths = { stdout: join(folder, 'stdout.json'), stderr: join(folder, 'stderr.txt') };
    let failure: unknown;
    try {
      await run(paths);
    } catch (err: unknown) {
      failure = err;
    }
    // A file the run never wrote, because its shell did not start, reads as nothing.
    const read = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '');
    return {
      stdout: await read(paths.stdout),
      stderr: await read(paths.stderr),
      ...(failure !== undefined ? { failure } : {}),
    };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
