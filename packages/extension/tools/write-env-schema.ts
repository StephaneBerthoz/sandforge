/**
 * Write the JSON Schema of `sandforge.yaml` the extension ships, which the
 * editor checks the file with as it is typed.
 *
 * VS Code reads no YAML schema itself. Red Hat's YAML extension does: it
 * reads the `yamlValidation` contribution of every installed extension's
 * manifest, resolves a `url` that starts with `./` against that extension's
 * folder, and checks each file a `fileMatch` pattern matches against the
 * schema there. SandForge's manifest names the file this script writes.
 *
 * The schema is generated, never written by hand: `z.toJSONSchema` of
 * `envFileSchema`, the zod schema `sandforge-env validate` reads the file
 * with, as a file is written (`io: 'input'`, so a key the schema fills in is
 * not asked of it). It holds the shape -- every key, its type and its values,
 * and the keys a strict object refuses -- and none of what the zod schema
 * checks in code beyond it: `validate` checks the file whole.
 *
 * Draft 7 rather than zod's default, 2020-12: the YAML language server checks
 * a 2020-12 schema only since its 1.20.0, and before its 1.19.1 checked every
 * schema as draft 7, whatever it declared. For this schema both dialects say
 * the same, which the sibling test holds.
 *
 * The output is formatted by Prettier with the repository's config, so the
 * file it writes passes `format:check` as written.
 *
 *   pnpm exec tsx packages/extension/tools/write-env-schema.ts           # write the file
 *   pnpm exec tsx packages/extension/tools/write-env-schema.ts --check   # exit 1 if it is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as z from 'zod';

import { envFileSchema } from '@sandforge/shared';

/** The schema file, relative to the extension's folder: the manifest's `url` names it. */
export const ENV_SCHEMA_PATH = 'resources/schemas/sandforge.schema.json';

/** The schema file on disk. */
export const ENV_SCHEMA_FILE = join(__dirname, '..', ...ENV_SCHEMA_PATH.split('/'));

/** The command that writes the file again, as a stale check names it. */
export const WRITE_COMMAND = 'pnpm exec tsx packages/extension/tools/write-env-schema.ts';

/** The JSON Schema of the file as it is written, in the dialect asked. */
export function envFileJsonSchema(
  target: 'draft-7' | 'draft-2020-12' = 'draft-7',
): Record<string, unknown> {
  return z.toJSONSchema(envFileSchema, { io: 'input', target }) as Record<string, unknown>;
}

/** The text of the schema file, as this script writes it. */
export async function envSchemaText(): Promise<string> {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(ENV_SCHEMA_FILE)) ?? {};
  return prettier.format(JSON.stringify(envFileJsonSchema()), { ...config, parser: 'json' });
}

/** Whether the file at `file` holds the schema as this script would write it. */
export async function isEnvSchemaCurrent(file: string = ENV_SCHEMA_FILE): Promise<boolean> {
  let shipped: string;
  try {
    shipped = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return shipped === (await envSchemaText());
}

/** Write the schema to `file`, its folder made if missing. */
export async function writeEnvSchema(file: string = ENV_SCHEMA_FILE): Promise<void> {
  const text = await envSchemaText();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** The script: write the file, or with `--check` say whether it is stale. */
export async function main(
  argv: readonly string[],
  file: string = ENV_SCHEMA_FILE,
): Promise<number> {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument: ${unknown.join(' ')}; only --check is read\n`);
    return 2;
  }
  if (argv.includes('--check')) {
    if (await isEnvSchemaCurrent(file)) {
      process.stdout.write(`${file} holds the schema of envFileSchema\n`);
      return 0;
    }
    process.stderr.write(
      `${file} is stale: it is not what envFileSchema gives. Run ${WRITE_COMMAND}\n`,
    );
    return 1;
  }
  await writeEnvSchema(file);
  process.stdout.write(`wrote ${file}\n`);
  return 0;
}

// Only when run as a script: the sibling test imports the module.
if (/write-env-schema\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
