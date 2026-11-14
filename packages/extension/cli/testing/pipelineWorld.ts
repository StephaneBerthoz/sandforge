/**
 * The world the tests of `sandforge pipeline` run in: the memory org of an
 * environment's tests (`envWorld.ts`), reached by the pipeline's own host
 * through the extension's handlers, beside the other orgs a pipeline file
 * names, each answering its sf alias with an Organization record of its own —
 * a sandbox, a scratch org, a Developer Edition org, a production org.
 *
 * Only what reaches past this machine is stood in for: `sf`'s session of each
 * alias, the identity query of a connection, the org. The command's `main`,
 * its host, the Automation page's handler and the Seed and Sync flows it runs
 * are the product's own, and the seed command's removal runs in the same
 * world (`world.env.runner`), on the same journal: what the run printed to
 * take it back is run as it was printed.
 *
 * A test file that uses it mocks what `envWorld.ts` asks, and
 * `../../src/core/connection/ConnectionHelper.js` (`getJsforceConnection`),
 * which the handlers reach their orgs through: every org's connection is the
 * memory org's, and what a step writes lands there.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type {
  PipelineFileDraft,
  PipelineFileOrg,
  PipelineFileStep,
  PipelineFileStored,
  PipelineFileSyncConfig,
  PipelineVariable,
} from '@sandforge/shared';
import { writePipelineFile } from '@sandforge/shared';
import { AuthProvider } from '../../src/core/connection/AuthProvider.js';
import { MEMORY_ORG_USER } from '../../src/test/memoryRemovalOrg.js';
import { main as pipelineMain, type PipelineDeps } from '../sandforge-pipeline.js';
import type { CommandRun } from '../scriptRunner.js';
import { loadOrg } from '../sfSession.js';
import { EnvWorld, runInProcess } from './envWorld.js';

/** An org of the world, as its alias answers. */
export interface PipelineWorldOrg {
  alias: string;
  organizationId: string;
  /** What its Organization record says: a sandbox (a scratch org says so too). Default true. */
  sandbox?: boolean;
  /** Its edition: `Developer Edition`, `Enterprise Edition`. */
  edition?: string;
  /** Whether sf shows it as a scratch org, with a Dev Hub. */
  scratch?: boolean;
}

/** The memory org's Organization Id: the org every step writes to. */
export const WORLD_TARGET_ID = '00D000000000009AAA';

/** A Seed template that fills Account with two records of a fixed name. */
export const ACCOUNTS_TEMPLATE: PipelineFileStored = {
  id: 'seed-two-accounts',
  name: 'Two accounts',
  strategy: 'faker',
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 2,
      fieldRules: [
        { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'PIPE account' } },
      ],
      excludedFields: [],
      insertOrder: 0,
    },
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

/** What a test's pipeline file holds; the rest is the world's own. */
export interface WorldPipeline {
  steps: PipelineFileStep[];
  orgs: Record<string, PipelineFileOrg>;
  variables?: PipelineVariable[];
  syncConfigs?: Record<string, PipelineFileSyncConfig>;
  seedTemplates?: Record<string, PipelineFileStored>;
  settings?: PipelineFileDraft['settings'];
  id?: string;
  name?: string;
}

/** The world: the memory org, the orgs beside it, and the command run in this process. */
export class PipelineWorld {
  readonly env: EnvWorld;
  private readonly byAlias = new Map<string, PipelineWorldOrg>();

  /**
   * @param dir - A folder of the test's own: the files it writes go there.
   * @param orgs - The orgs the aliases reach; the first is the memory org.
   */
  constructor(
    readonly dir: string,
    orgs: readonly PipelineWorldOrg[],
  ) {
    const [target] = orgs;
    this.env = new EnvWorld({
      organizationId: target?.organizationId ?? WORLD_TARGET_ID,
      sandbox: target?.sandbox ?? true,
      ...(target?.edition !== undefined ? { edition: target.edition } : {}),
    });
    for (const org of orgs) this.byAlias.set(org.alias, org);
    vi.mocked(loadOrg).mockImplementation(async (alias: string) => {
      const org = this.byAlias.get(alias);
      if (org === undefined) throw new Error(`sf does not know ${alias}`);
      return {
        alias,
        username: `${alias.toLowerCase()}@example.com`,
        instanceUrl: 'https://example.my.salesforce.com',
        accessToken: `token-${alias}`,
        ...(org.scratch === true ? { scratch: true as const } : {}),
      };
    });
    vi.spyOn(AuthProvider.prototype, 'validateConnection').mockImplementation(
      async (accessToken: string) => {
        const org = this.byAlias.get(accessToken.replace(/^token-/, ''));
        if (org === undefined) throw new Error('INVALID_SESSION_ID: Session expired or invalid');
        return {
          userId: MEMORY_ORG_USER,
          username: `${org.alias.toLowerCase()}@example.com`,
          displayName: 'Test User',
          orgId: org.organizationId,
          orgName: `${org.alias} org`,
          orgType: org.edition ?? 'Developer Edition',
          isSandbox: org.sandbox ?? true,
        };
      },
    );
  }

  /** Write a pipeline file as the Automation page's export writes one, and give its path. */
  file(pipeline: WorldPipeline, name = 'nightly'): string {
    const written = writePipelineFile({
      exportedAt: '2026-11-20T10:00:00.000Z',
      sandforgeVersion: '1.81.0',
      pipeline: {
        id: pipeline.id ?? 'pipe-nightly',
        name: pipeline.name ?? 'Nightly reset',
        description: '',
        steps: pipeline.steps,
        variables: pipeline.variables ?? [],
        tags: [],
      },
      schedule: null,
      orgs: pipeline.orgs,
      syncConfigs: pipeline.syncConfigs ?? {},
      seedTemplates: pipeline.seedTemplates ?? {},
      maskingTemplates: {},
      settings: pipeline.settings ?? {},
      notes: [],
    });
    if (!written.ok) {
      throw new Error(
        `The test's pipeline file does not read: ${written.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      );
    }
    const path = join(this.dir, `${name}.sandforge-pipeline.json`);
    writeFileSync(path, written.text);
    return path;
  }

  /** Run `sandforge pipeline` in this process, as a process of its own would run. */
  run(args: readonly string[], deps: PipelineDeps = {}): Promise<CommandRun> {
    return runInProcess(() =>
      pipelineMain(['node', 'sandforge-pipeline.ts', ...args], {
        isTTY: false,
        pipelinesRoot: join(this.dir, 'journal', 'pipelines'),
        version: '1.81.0',
        ...deps,
      }),
    );
  }
}

/** A step of a pipeline file, its other fields as the editor saves them. */
export function step(
  id: string,
  name: string,
  type: string,
  config: Record<string, unknown> = {},
): PipelineFileStep {
  return { id, name, type, config, continueOnError: false };
}
