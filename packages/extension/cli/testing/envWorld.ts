/**
 * An org in memory for the tests of an environment's steps, and a runner that
 * runs `sandforge-seed`'s own `main` in this process against it: what the
 * seed writes lands in the memory org, and its preview and its removal read
 * and delete there, so an apply, a plan and a destroy are held to what the
 * script itself prints, exits with and keeps — never to a stand-in of it.
 *
 * A test file that uses it mocks, as the seed's own tests do, `../sfSession.js`
 * (`loadOrg`, `makeConn`), `../sandforge-clone.js` (`targetAutomationReader`)
 * and `../../src/modules/forge/ForgeRunRemoval.js` (`removalOrg`); the world
 * points each at itself.
 *
 * The seed's writes go through REST, a record at a time as its batches send
 * them, each added to the memory org dated by the org's clock to the second.
 * A relation drawing existing parents reads them from the memory org.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { EnvState, ForgeTargetAutomation } from '@sandforge/shared';
import { removalSubjectOf } from '../env/envApply.js';
import type { EnvFileResolved } from '../env/envFile.js';
import { liveResources, type EnvDryRun, type EnvRunPreview } from '../env/envPlan.js';
import type { EnvStore } from '../env/envState.js';
import {
  readSeedDryRun,
  readSeedPreview,
  seedDryRunLine,
  seedPreviewLine,
} from '../env/envSteps.js';
import { removalOrg } from '../../src/modules/forge/ForgeRunRemoval.js';
import {
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  orgStamp,
  type MemoryChild,
} from '../../src/test/memoryRemovalOrg.js';
import { targetAutomationReader } from '../sandforge-clone.js';
import { main as seedMain } from '../sandforge-seed.js';
import type { CommandRun, CommandRunner } from '../scriptRunner.js';
import { loadOrg, makeConn } from '../sfSession.js';

/** A field of a describe, as the seed reads one. */
interface WorldField {
  name: string;
  type: string;
  createable: boolean;
  nillable: boolean;
  length?: number;
  referenceTo?: string[];
}

/** The objects the world's org describes, and the fields each takes. */
const OBJECTS: Readonly<Record<string, readonly WorldField[]>> = {
  Account: [
    { name: 'Id', type: 'id', createable: false, nillable: false, length: 18 },
    { name: 'Name', type: 'string', createable: true, nillable: false, length: 80 },
  ],
  Contact: [
    { name: 'Id', type: 'id', createable: false, nillable: false, length: 18 },
    { name: 'LastName', type: 'string', createable: true, nillable: false, length: 80 },
    {
      name: 'AccountId',
      type: 'reference',
      createable: true,
      nillable: true,
      length: 18,
      referenceTo: ['Account'],
    },
  ],
  Asset: [
    { name: 'Id', type: 'id', createable: false, nillable: false, length: 18 },
    { name: 'Name', type: 'string', createable: true, nillable: false, length: 80 },
    { name: 'RecordTypeId', type: 'reference', createable: true, nillable: true, length: 18 },
  ],
};

/** The record types an object has, as its describe lists them: Asset's two. */
const RECORD_TYPES: Readonly<Record<string, readonly unknown[]>> = {
  Asset: [
    { recordTypeId: '012000000000010AAA', developerName: 'Hardware', available: true },
    { recordTypeId: '012000000000011AAA', developerName: 'Software', available: true },
  ],
};

/** Nothing the org runs as records go in or out. */
const QUIET: ForgeTargetAutomation = {
  objectsRead: [],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 0,
};

/** The key prefix of each object's ids. */
const PREFIX: Readonly<Record<string, string>> = { Account: '001', Contact: '003', Asset: '02i' };

/** How the contacts of an account hang from it, as the org's describe of Account lists them. */
const CHILDREN: Readonly<Record<string, readonly MemoryChild[]>> = {
  Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
};

/** What the world's org is. */
export interface EnvWorldOptions {
  /** Its Organization Id. */
  organizationId?: string;
  /** What its Organization record says: a sandbox (scratch orgs say so too), or an edition. */
  sandbox?: boolean;
  edition?: string;
  /** Whether the sf CLI shows it as a scratch org. */
  scratch?: boolean;
  /** What its `/limits` say. */
  limits?: Record<string, unknown>;
  /** Called after each script ran: a test moves its fake clock on from it. */
  tick?: () => void;
}

/** One script the runner ran, its line and how it ended. */
export interface EnvWorldCall {
  script: string;
  args: string[];
  code: number;
}

/** A Developer Edition's limits, as its `/limits` say them: 15 single emails a day. */
export const DEVELOPER_LIMITS: Readonly<Record<string, unknown>> = {
  DataStorageMB: { Max: 5, Remaining: 5 },
  DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
  SingleEmail: { Max: 15, Remaining: 15 },
};

/** `process.exit`, as a script calls it, stopped where it was called. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** The world: an org in memory, a connection to it, and the runner of the seed against it. */
export class EnvWorld {
  readonly org: MemoryRemovalOrg;
  readonly organizationId: string;
  /** Every script the runner ran, in order. */
  readonly calls: EnvWorldCall[] = [];
  /** Called before each record the seed writes is taken: a test stops a run from it. */
  onCreate?: (objectApiName: string, written: number) => void;
  /** Why the org refuses a record the seed sends, as a validation rule would; taken when undefined. */
  refuseCreate?: (objectApiName: string, record: Record<string, unknown>) => string | undefined;
  /** What the org runs as records go in or out, as the scripts read it. */
  automation: ForgeTargetAutomation = QUIET;
  private made = 0;
  private readonly options: EnvWorldOptions;

  constructor(options: EnvWorldOptions = {}) {
    this.options = options;
    this.organizationId = options.organizationId ?? '00D000000000009AAA';
    this.org = new MemoryRemovalOrg(CHILDREN);
    const conn = this.connection();
    vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
    vi.mocked(loadOrg).mockImplementation(async (alias: string) => ({
      alias,
      username: 'test-user@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'token',
      ...(options.scratch === true ? { scratch: true as const } : {}),
    }));
    vi.mocked(removalOrg).mockReturnValue(this.org);
    vi.mocked(targetAutomationReader).mockReturnValue({
      read: async (): Promise<ForgeTargetAutomation> => this.automation,
    } as unknown as ReturnType<typeof targetAutomationReader>);
  }

  /** The records of an object the org holds, as the seed wrote them. */
  records(objectApiName: string): Array<Record<string, unknown>> {
    return this.org.all(objectApiName);
  }

  /** The runner of `sandforge-seed`, in this process; any other script is refused. */
  readonly runner: CommandRunner = async (script, args) => {
    if (script !== 'sandforge-seed')
      throw new Error(`The world runs sandforge-seed alone, not ${script}`);
    const run = await runInProcess(() => seedMain(['node', 'sandforge-seed.ts', ...args]));
    this.calls.push({ script, args: [...args], code: run.code });
    this.options.tick?.();
    return run;
  };

  private describeOf(objectApiName: string): Record<string, unknown> {
    const fields = OBJECTS[objectApiName];
    if (fields === undefined) throw new Error(`The world's org has no ${objectApiName}`);
    return {
      name: objectApiName,
      createable: true,
      recordTypeInfos: RECORD_TYPES[objectApiName] ?? [],
      fields: fields.map((field) => ({
        referenceTo: [],
        defaultedOnCreate: false,
        picklistValues: [],
        ...field,
      })),
    };
  }

  private connection(): Record<string, unknown> {
    const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
    const sandbox = this.options.sandbox ?? true;
    return {
      sobject: (objectApiName: string) => ({
        describe: async () => this.describeOf(objectApiName),
        create: async (records: Array<Record<string, unknown>>) =>
          records.map((record) => {
            this.onCreate?.(objectApiName, this.made);
            const refused = this.refuseCreate?.(objectApiName, record);
            if (refused !== undefined) {
              return {
                success: false,
                errors: [
                  { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: refused, fields: [] },
                ],
              };
            }
            const id = `${PREFIX[objectApiName] ?? '0xx'}${String(this.made++).padStart(12, '0')}AAA`;
            this.org.add(
              objectApiName,
              {
                ...record,
                Id: id,
                CreatedById: MEMORY_ORG_USER,
                LastModifiedById: MEMORY_ORG_USER,
              },
              orgStamp(Date.now()),
            );
            return { success: true, id };
          }),
      }),
      describe: async (objectApiName: string) => this.describeOf(objectApiName),
      describeGlobal: async () => ({
        sobjects: Object.keys(OBJECTS).map((name) => ({ name, createable: true })),
      }),
      query: async (soql: string) => {
        if (/FROM Organization/.test(soql)) {
          return page([
            {
              Id: this.organizationId,
              IsSandbox: sandbox,
              ...(this.options.edition !== undefined
                ? { OrganizationType: this.options.edition }
                : {}),
            },
          ]);
        }
        // A relation's existing parents, read from the records the org holds.
        if (/^SELECT Id FROM (Account|Contact|Asset)\b/.test(soql)) return this.org.query(soql);
        return page([]);
      },
      queryMore: async (url: string) => this.org.queryMore(url),
      tooling: { query: async () => page([]) },
      identity: async () => ({ user_id: MEMORY_ORG_USER }),
      request: async (request: { url?: string } | string) => {
        const url = typeof request === 'string' ? request : (request.url ?? '');
        if (url.endsWith('/limits')) return this.options.limits ?? DEVELOPER_LIMITS;
        throw new Error(`The world's org answers no request to ${url}`);
      },
    };
  }
}

/** Where an environment's plan reads its runs and writes its dry runs' templates. */
export interface EnvPlanPlace {
  store: EnvStore;
  journalDir: string;
  /** A folder of the test's own, for the dry runs' templates. */
  dir: string;
  alias: string;
}

/** Each named resource dry-run through the seed, as the command line does. */
export async function dryRunsIn(
  world: EnvWorld,
  place: EnvPlanPlace,
  resolved: EnvFileResolved,
  names: readonly string[],
): Promise<Record<string, EnvDryRun>> {
  const out: Record<string, EnvDryRun> = {};
  for (const resource of resolved.resources) {
    if (!names.includes(resource.name)) continue;
    const templateFile = join(place.dir, `${resource.name}.dry.json`);
    writeFileSync(templateFile, JSON.stringify(resource.run.template));
    const ran = await world.runner(
      'sandforge-seed',
      seedDryRunLine({
        target: place.alias,
        templateFile,
        runId: `env-${resolved.checked.file.name}-${resource.name}-dry`,
        ...(resource.run.seed !== undefined ? { seed: resource.run.seed } : {}),
        ...(resource.run.recordTypes !== undefined
          ? { recordTypes: resource.run.recordTypes }
          : {}),
      }),
      new AbortController().signal,
    );
    try {
      out[resource.name] = { answer: readSeedDryRun(ran.stdout) };
    } catch {
      out[resource.name] = {
        failed: `exit ${ran.code}: ${ran.stderr.trim().split('\n').at(-1) ?? ''}`,
      };
    }
  }
  return out;
}

/** Each run of each resource the state holds, previewed through the seed. */
export async function previewsIn(
  world: EnvWorld,
  place: EnvPlanPlace,
  state: EnvState | undefined,
  switches: { includeChanged?: boolean; acceptAutomation?: boolean } = {},
): Promise<Record<string, EnvRunPreview[]>> {
  const out: Record<string, EnvRunPreview[]> = {};
  for (const [name, resource] of liveResources(state)) {
    const runs: EnvRunPreview[] = [];
    for (const run of [...resource.runs].reverse()) {
      const subject = removalSubjectOf(
        run,
        { organizationId: state?.org.organizationId ?? '', env: state?.env ?? '' },
        place,
      );
      if (subject === undefined) {
        runs.push({ n: run.n, nothing: true });
        continue;
      }
      const ran = await world.runner(
        'sandforge-seed',
        seedPreviewLine({ target: place.alias, summary: subject, ...switches }),
        new AbortController().signal,
      );
      runs.push({ n: run.n, preview: readSeedPreview(ran.stdout) });
    }
    out[name] = runs;
  }
  return out;
}

/**
 * Run a script's `main` in this process, as a process of its own would run:
 * what it writes to stdout and stderr kept, `process.exit` taken for its exit
 * code, and the exit code it set given back to whoever ran it.
 */
export async function runInProcess(main: () => Promise<void>): Promise<CommandRun> {
  const out: string[] = [];
  const err: string[] = [];
  const saved = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    exit: process.exit,
    exitCode: process.exitCode,
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Exited(code ?? 0);
  }) as typeof process.exit;
  process.exitCode = undefined;
  let code: number;
  try {
    await main();
    code = Number(process.exitCode ?? 0);
  } catch (error: unknown) {
    if (error instanceof Exited) {
      code = error.code;
    } else {
      // What the script's own last line does with an error it did not catch.
      err.push(`${error instanceof Error ? error.message : String(error)}\n`);
      code = 1;
    }
  } finally {
    process.stdout.write = saved.stdout;
    process.stderr.write = saved.stderr;
    process.exit = saved.exit;
    process.exitCode = saved.exitCode;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}
