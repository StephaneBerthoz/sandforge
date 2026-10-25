/**
 * An org in memory for the tests of an environment's steps, and a runner that
 * runs the scripts' own `main` in this process against it: what the seed
 * writes lands in the memory org, and its preview and its removal read and
 * delete there, so an apply, a plan and a destroy are held to what the script
 * itself prints, exits with and keeps — never to a stand-in of it.
 *
 * Given a source org (`EnvWorldOptions.source`), the world runs
 * `sandforge-clone`'s own `main` too, from that memory source org to the
 * memory target org: discovery and the reads of the clone go to the source,
 * its writes to the target, and its removal, its preview and its
 * verification read and delete there, as they do the seed's.
 *
 * A test file that uses it mocks, as the seed's own tests do, `../sfSession.js`
 * (`loadOrg`, `makeConn`), `../sandforge-clone.js` (`targetAutomationReader`)
 * and `../../src/modules/forge/ForgeRunRemoval.js` (`removalOrg`); the world
 * points each at itself. A file that runs the clone keeps the rest of
 * `../sfSession.js` (the clone counts its requests with `countRequests`) and
 * mocks `../../src/modules/forge/RunVerifier.js` (`verifiedOrg`) as well.
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
import { dryRunLineOf, previewLineOf, readDryRunOf, readPreviewOf } from '../env/envKinds.js';
import { liveResources, type EnvDryRun, type EnvRunPreview } from '../env/envPlan.js';
import type { EnvStore } from '../env/envState.js';
import { removalOrg } from '../../src/modules/forge/ForgeRunRemoval.js';
import { verifiedOrg, type VerifiedOrg } from '../../src/modules/forge/RunVerifier.js';
import {
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  orgStamp,
  type MemoryChild,
  type MemoryRow,
} from '../../src/test/memoryRemovalOrg.js';
import { main as cloneMain, targetAutomationReader } from '../sandforge-clone.js';
import { main as seedMain } from '../sandforge-seed.js';
import type { CommandRun, CommandRunner } from '../scriptRunner.js';
import { loadOrg, makeConn } from '../sfSession.js';

/** A field of a describe, as the scripts read one. */
interface WorldField {
  name: string;
  type: string;
  createable: boolean;
  nillable: boolean;
  length?: number;
  referenceTo?: string[];
  relationshipName?: string;
}

/** The objects the world's orgs describe, and the fields each takes. */
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
      relationshipName: 'Account',
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

/** The source org a forge resource clones from. */
export interface EnvWorldSource {
  /** The sf CLI alias it is reached by. */
  alias: string;
  /** Its Organization Id. */
  organizationId?: string;
}

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
  /** A source org the clone reads from: every other alias reaches the target. */
  source?: EnvWorldSource;
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

/** The Organization Id of the world's source org, unless it names another. */
const SOURCE_ORG_ID = '00D000000000008SRC';

/** `process.exit`, as a script calls it, stopped where it was called. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** A page of a query, every record in it. */
const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

/** The world: an org in memory, a connection to it, and the runner of the scripts against it. */
export class EnvWorld {
  readonly org: MemoryRemovalOrg;
  readonly organizationId: string;
  /** The org a forge resource clones from, when the world has one. */
  readonly source: MemoryRemovalOrg | undefined;
  readonly sourceOrganizationId: string;
  /** Every script the runner ran, in order. */
  readonly calls: EnvWorldCall[] = [];
  /** Called before each record a script writes is taken: a test stops a run from it. */
  onCreate?: (objectApiName: string, written: number) => void;
  /** Why the org refuses a record a script sends, as a validation rule would; taken when undefined. */
  refuseCreate?: (objectApiName: string, record: Record<string, unknown>) => string | undefined;
  /** What the org runs as records go in or out, as the scripts read it. */
  automation: ForgeTargetAutomation = QUIET;
  private made = 0;
  private readonly options: EnvWorldOptions;

  constructor(options: EnvWorldOptions = {}) {
    this.options = options;
    this.organizationId = options.organizationId ?? '00D000000000009AAA';
    this.sourceOrganizationId = options.source?.organizationId ?? SOURCE_ORG_ID;
    this.org = new MemoryRemovalOrg(CHILDREN);
    this.source = options.source !== undefined ? new MemoryRemovalOrg(CHILDREN) : undefined;
    const conn = this.connection();
    const sourceConn = this.source !== undefined ? this.sourceConnection() : undefined;
    vi.mocked(makeConn).mockImplementation(
      (session) =>
        (sourceConn !== undefined && session.alias === options.source?.alias
          ? sourceConn
          : conn) as unknown as Connection,
    );
    vi.mocked(loadOrg).mockImplementation(async (alias: string) => ({
      alias,
      username: 'test-user@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'token',
      ...(options.scratch === true && alias !== options.source?.alias
        ? { scratch: true as const }
        : {}),
    }));
    vi.mocked(removalOrg).mockReturnValue(this.org);
    vi.mocked(targetAutomationReader).mockReturnValue({
      read: async (): Promise<ForgeTargetAutomation> => this.automation,
    } as unknown as ReturnType<typeof targetAutomationReader>);
    // A file that runs the clone reads its verification from the memory orgs.
    if (vi.isMockFunction(verifiedOrg)) {
      vi.mocked(verifiedOrg).mockImplementation(
        (connection) =>
          (connection === (sourceConn as unknown)
            ? this.source
            : this.org) as unknown as VerifiedOrg,
      );
    }
  }

  /** The records of an object the org holds, as the scripts wrote them. */
  records(objectApiName: string): Array<Record<string, unknown>> {
    return this.org.all(objectApiName);
  }

  /** Put records in the source org, a day before now, each its own Id. */
  seedSource(objectApiName: string, rows: ReadonlyArray<Omit<MemoryRow, 'Id'> & { Id?: string }>) {
    if (this.source === undefined) throw new Error('The world has no source org');
    const at = orgStamp(Date.now() - 86_400_000);
    for (const row of rows) {
      const id =
        row.Id ?? `${PREFIX[objectApiName] ?? '0xx'}${String(this.made++).padStart(12, '0')}SRC`;
      this.source.add(objectApiName, { ...row, Id: id }, at);
    }
  }

  /** The runner of the scripts, in this process; a script the world does not run is refused. */
  readonly runner: CommandRunner = async (script, args) => {
    let run: CommandRun;
    if (script === 'sandforge-seed') {
      run = await runInProcess(() => seedMain(['node', 'sandforge-seed.ts', ...args]));
    } else if (script === 'sandforge-clone' && this.source !== undefined) {
      run = await runInProcess(() =>
        withoutPauses(() => cloneMain(['node', 'sandforge-clone.ts', ...args])),
      );
    } else {
      throw new Error(
        `The world runs sandforge-seed${this.source !== undefined ? ' and sandforge-clone' : ''} alone, not ${script}`,
      );
    }
    this.calls.push({ script, args: [...args], code: run.code });
    this.options.tick?.();
    return run;
  };

  private describeOf(objectApiName: string): Record<string, unknown> {
    const fields = OBJECTS[objectApiName];
    if (fields === undefined) throw new Error(`The world's org has no ${objectApiName}`);
    return {
      name: objectApiName,
      keyPrefix: PREFIX[objectApiName] ?? null,
      createable: true,
      recordTypeInfos: RECORD_TYPES[objectApiName] ?? [],
      childRelationships: (CHILDREN[objectApiName] ?? []).map((child) => ({
        childSObject: child.childSObject,
        field: child.field,
        relationshipName: `${child.childSObject}s`,
        cascadeDelete: child.cascadeDelete ?? false,
      })),
      fields: fields.map((field) => ({
        referenceTo: [],
        relationshipName: null,
        defaultedOnCreate: false,
        picklistValues: [],
        updateable: field.createable,
        ...field,
      })),
    };
  }

  private connection(): Record<string, unknown> {
    const sandbox = this.options.sandbox ?? true;
    return {
      version: '62.0',
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
            return { success: true, id, errors: [] };
          }),
      }),
      describe: async (objectApiName: string) => this.describeOf(objectApiName),
      describe$: async (objectApiName: string) => this.describeOf(objectApiName),
      describeGlobal: async () => ({
        sobjects: Object.keys(OBJECTS).map((name) => ({
          name,
          keyPrefix: PREFIX[name] ?? null,
          createable: true,
        })),
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
        // What a script reads of the records the org holds: a relation's
        // existing parents, the dates of what a clone wrote.
        if (/^SELECT [\w, ]+ FROM (Account|Contact|Asset)\b/.test(soql))
          return this.org.query(soql);
        return page([]);
      },
      queryMore: async (url: string) => this.org.queryMore(url),
      tooling: { query: async () => page([]), queryMore: async () => page([]) },
      identity: async () => ({ user_id: MEMORY_ORG_USER }),
      request: async (request: { url?: string; body?: string } | string) => {
        const url = typeof request === 'string' ? request : (request.url ?? '');
        if (url.endsWith('/limits')) return this.options.limits ?? DEVELOPER_LIMITS;
        if (url.endsWith('/tooling/composite') && typeof request !== 'string') {
          return compositeOfNothing(request.body);
        }
        throw new Error(`The world's org answers no request to ${url}`);
      },
    };
  }

  /** The source org's connection: what discovery and the clone's reads see. */
  private sourceConnection(): Record<string, unknown> {
    const source = this.source;
    if (source === undefined) throw new Error('The world has no source org');
    return {
      version: '62.0',
      sobject: (objectApiName: string) => ({
        describe: async () => this.describeOf(objectApiName),
      }),
      describe: async (objectApiName: string) => this.describeOf(objectApiName),
      describe$: async (objectApiName: string) => this.describeOf(objectApiName),
      describeGlobal: async () => ({
        sobjects: Object.keys(OBJECTS).map((name) => ({
          name,
          keyPrefix: PREFIX[name] ?? null,
          createable: true,
        })),
      }),
      query: async (soql: string) =>
        /FROM Organization/.test(soql)
          ? page([{ Id: this.sourceOrganizationId, IsSandbox: true }])
          : /FROM (RecordType|User|Group)\b/.test(soql)
            ? page([])
            : source.query(soql),
      queryMore: async (url: string) => source.queryMore(url),
      tooling: { query: async () => page([]), queryMore: async () => page([]) },
      request: async (request: { url?: string; body?: string } | string) => {
        const url = typeof request === 'string' ? request : (request.url ?? '');
        if (url.endsWith('/limits')) return DEVELOPER_LIMITS;
        if (url.endsWith('/tooling/composite') && typeof request !== 'string') {
          return compositeOfNothing(request.body);
        }
        throw new Error(`The world's source org answers no request to ${url}`);
      },
    };
  }
}

/** A Tooling composite, each of its subrequests answered with no row. */
function compositeOfNothing(body: string | undefined): unknown {
  const parsed = JSON.parse(body ?? '{}') as {
    compositeRequest?: Array<{ referenceId: string }>;
  };
  return {
    compositeResponse: (parsed.compositeRequest ?? []).map((sub) => ({
      referenceId: sub.referenceId,
      httpStatusCode: 200,
      body: page([]),
    })),
  };
}

/**
 * Run `work` with every pause of it answered at once: a verification reads
 * the target after two seconds, and again until two readings agree, which in
 * memory agree at once.
 */
async function withoutPauses<T>(work: () => Promise<T>): Promise<T> {
  const pause = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void) => {
    handler();
    return 0;
  }) as unknown as typeof setTimeout);
  try {
    return await work();
  } finally {
    pause.mockRestore();
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

/** Each named resource dry-run through its script, as the command line does. */
export async function dryRunsIn(
  world: EnvWorld,
  place: EnvPlanPlace,
  resolved: EnvFileResolved,
  names: readonly string[],
): Promise<Record<string, EnvDryRun>> {
  const out: Record<string, EnvDryRun> = {};
  for (const resource of resolved.resources) {
    if (!names.includes(resource.name)) continue;
    if (resource.kind === 'forge') {
      const read = resource.source.read;
      if (read === undefined || 'refusal' in read) continue;
    }
    const templateFile = join(place.dir, `${resource.name}.dry.json`);
    writeFileSync(templateFile, JSON.stringify(resource.run.template));
    const line = dryRunLineOf(resource, {
      target: place.alias,
      templateFile,
      runId: `env-${resolved.checked.file.name}-${resource.name}-dry`,
    });
    const ran = await world.runner(line.script, line.args, new AbortController().signal);
    try {
      out[resource.name] = { answer: readDryRunOf(resource.kind, ran.stdout) };
    } catch {
      out[resource.name] = {
        failed: `exit ${ran.code}: ${ran.stderr.trim().split('\n').at(-1) ?? ''}`,
      };
    }
  }
  return out;
}

/**
 * Each run of each resource the state holds, previewed through its script, as
 * the command line previews them: but those a removal took back whole.
 */
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
      if (run.takenBack === true) continue;
      const subject = removalSubjectOf(
        run,
        { organizationId: state?.org.organizationId ?? '', env: state?.env ?? '' },
        place,
      );
      if (subject === undefined) {
        runs.push({ n: run.n, nothing: true });
        continue;
      }
      const line = previewLineOf(resource.kind, {
        target: place.alias,
        subject,
        includeChanged: switches.includeChanged === true,
        acceptAutomation: switches.acceptAutomation === true,
      });
      const ran = await world.runner(line.script, line.args, new AbortController().signal);
      runs.push({ n: run.n, preview: readPreviewOf(resource.kind, ran.stdout) });
    }
    out[name] = runs;
  }
  return out;
}

/* eslint-disable no-console -- the clone says its lines through the console: run in this process, they are its stdout and stderr */
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
    log: console.log,
    error: console.error,
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  // The clone prints its lines through the console, as a script of its own
  // writes them to its stdout and stderr.
  console.log = (...line: unknown[]) => {
    out.push(`${line.map(String).join(' ')}\n`);
  };
  console.error = (...line: unknown[]) => {
    err.push(`${line.map(String).join(' ')}\n`);
  };
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
    console.log = saved.log;
    console.error = saved.error;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}
/* eslint-enable no-console */
