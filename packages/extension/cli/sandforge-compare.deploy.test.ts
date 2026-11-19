import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileConfigStore } from './fileConfigStore.js';
import { createPanelHost, orgFromIdentity } from './panelHost.js';
import type { PanelHost, PanelHostOptions, PanelHostWiring, PanelRequest } from './panelHost.js';
import type { PromptStreams } from './prompt.js';
import { main, parseArgs, progressLines } from './sandforge-compare.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { AuditTrailStore } from '../src/modules/audit/auditTrail.js';

vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * `sandforge compare --deploy` whole, through the extension's own host
 * (`panelHost.ts`): Compare's handler answers it with the real deployer and
 * the real Production Guard, as it answers the Deploy tab. Only what reaches
 * past this machine is stood in for: the `sf` CLI's session and the identity
 * query of a connection (the host's `connect`), and the Metadata API of each
 * org, which records what it was asked.
 */

const SOURCE_ID = '00D000000000001AAA';
const TARGET_ID = '00D000000000002AAA';

/** What the target is, as its Organization record says. */
type TargetKind = 'sandbox' | 'developer' | 'production';

/** The Metadata API of one org, answering each deployment with the next of `deployResults`. */
function orgApi(deployResults: Array<Record<string, unknown>> = [], fields: string[] = []) {
  let deployments = 0;
  const metadata = {
    // The custom fields the org lists, and nothing of any other type.
    list: vi.fn((queries: Array<{ type: string }>) =>
      Promise.resolve(
        queries.some((q) => q.type === 'CustomField')
          ? fields.map((fullName) => ({ fullName, type: 'CustomField' }))
          : [],
      ),
    ),
    retrieve: vi.fn(() => Promise.resolve({ id: '09S000000000001' })),
    checkRetrieveStatus: vi.fn(() =>
      Promise.resolve({
        done: true,
        success: true,
        status: 'Succeeded',
        zipFile: 'UEsDBBQ=',
        fileProperties: [],
        messages: [],
      }),
    ),
    deploy: vi.fn(() => {
      deployments += 1;
      return Promise.resolve({ id: `0Af00000000000${deployments}` });
    }),
    checkDeployStatus: vi.fn((id: string) =>
      Promise.resolve({
        id,
        done: true,
        status: 'Succeeded',
        success: true,
        numberComponentsTotal: 2,
        numberComponentsDeployed: 2,
        numberComponentErrors: 0,
        numberTestsTotal: 0,
        numberTestsCompleted: 0,
        numberTestErrors: 0,
        details: {
          componentSuccesses: [
            { componentType: 'ApexClass', fullName: 'Invoicing', success: true, changed: true },
            {
              componentType: 'CustomField',
              fullName: 'Account.Region__c',
              success: true,
              created: true,
            },
          ],
          componentFailures: [],
        },
        ...deployResults[Number(id.slice(-1)) - 1],
      }),
    ),
  };
  return { version: '66.0', metadata, limitInfo: undefined };
}

type OrgApi = ReturnType<typeof orgApi>;

/** A deployment the target refused: a component that does not compile. */
const REFUSED = {
  status: 'Failed',
  success: false,
  numberComponentsDeployed: 1,
  numberComponentErrors: 1,
  details: {
    componentSuccesses: [],
    componentFailures: [
      {
        componentType: 'ApexClass',
        fullName: 'Invoicing',
        success: false,
        problem: 'Variable does not exist: total',
        lineNumber: 12,
        columnNumber: 5,
      },
    ],
  },
};

/** A terminal the alias is typed on: `answer` is what was typed. */
function terminal(answer: string): PromptStreams & { said: () => string } {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  input.write(`${answer}\n`);
  const output = new PassThrough();
  let said = '';
  output.on('data', (chunk: Buffer) => {
    said += String(chunk);
  });
  return { input, output, said: () => said };
}

/** No terminal at all: a CI step's stdin. */
function noTerminal(): PromptStreams {
  return { input: Object.assign(new PassThrough(), { isTTY: false }), output: new PassThrough() };
}

interface Harness {
  dir: string;
  source: OrgApi;
  target: OrgApi;
  /** The aliases the command connected, in order. */
  connected: string[];
  /** The requests the command sent the handler, in order. */
  sent: PanelRequest[];
  run: (
    streams: PromptStreams,
    ...args: string[]
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const dirs: string[] = [];

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function harness(
  options: {
    target?: TargetKind;
    targetDeploys?: Array<Record<string, unknown>>;
    /** The custom fields each org lists. */
    fields?: { source: string[]; target: string[] };
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-compare-deploy-'));
  dirs.push(dir);
  const source = orgApi([], options.fields?.source);
  const target = orgApi(options.targetDeploys, options.fields?.target);
  const connected: string[] = [];
  const sent: PanelRequest[] = [];
  vi.mocked(getJsforceConnection).mockImplementation((orgId: string) =>
    Promise.resolve((orgId === SOURCE_ID ? source : target) as never),
  );

  // The product's host, but for its `connect`.
  const createHost = (hostOptions: PanelHostOptions): PanelHost => {
    let wiring: PanelHostWiring | undefined;
    const host = createPanelHost({
      ...hostOptions,
      compose: (built) => {
        hostOptions.compose?.(built);
        wiring = built;
      },
    });
    return {
      get posted() {
        return host.posted;
      },
      request: (request) => {
        sent.push(request);
        return host.request(request);
      },
      connect: async (alias) => {
        connected.push(alias);
        const kind = alias === 'SRC' ? 'sandbox' : (options.target ?? 'developer');
        const session = {
          alias,
          username: `tester@${alias.toLowerCase()}.example.com`,
          instanceUrl: `https://${alias.toLowerCase()}.example.my.salesforce.com`,
          accessToken: 'not-a-token',
        };
        const registered = orgFromIdentity(session, {
          userId: '005000000000001AAA',
          username: session.username,
          displayName: 'Tester',
          orgId: alias === 'SRC' ? SOURCE_ID : TARGET_ID,
          orgName: 'Example',
          orgType:
            kind === 'production'
              ? 'Enterprise Edition'
              : kind === 'developer'
                ? 'Developer Edition'
                : 'Enterprise Edition',
          isSandbox: kind === 'sandbox',
        });
        if (!wiring) throw new Error('The host built no handlers.');
        await wiring.orgRegistry.saveOrg(registered, {
          loginUrl: session.instanceUrl,
          instanceUrl: session.instanceUrl,
          accessToken: session.accessToken,
          username: session.username,
        });
        return registered;
      },
    };
  };

  const run = async (streams: PromptStreams, ...args: string[]) => {
    let stdout = '';
    let stderr = '';
    let exited: number | undefined;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code;
      throw new Error(`exit ${code}`);
    }) as never);
    process.exitCode = undefined;
    try {
      await main(
        [
          'node',
          'sandforge-compare.ts',
          '--source',
          'SRC',
          '--target',
          'TGT',
          '--store',
          dir,
        ].concat(args),
        { createHost, terminal: streams },
      );
    } catch (thrown: unknown) {
      if (exited === undefined) throw thrown;
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
    const code = exited ?? Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return { code, stdout, stderr };
  };

  return { dir, source, target, connected, sent, run };
}

/** The deployments the target was asked for, check-only or not, with the package each carried. */
function deploymentsOf(
  api: OrgApi,
): Array<{ zip: string; checkOnly: unknown; testLevel: unknown }> {
  return api.metadata.deploy.mock.calls.map((call) => {
    const [zip, options] = call as unknown as [string, Record<string, unknown>];
    return { zip, checkOnly: options.checkOnly, testLevel: options.testLevel };
  });
}

const COMPONENTS = ['--deploy', 'ApexClass:Invoicing', '--deploy', 'CustomField:Account.Region__c'];

describe('sandforge compare --deploy', () => {
  it('validates the components check-only, then deploys the package the target validated, as the Deploy tab does', async () => {
    const h = harness();
    const { code, stdout } = await h.run(noTerminal(), ...COMPONENTS, '--yes');

    expect(code).toBe(0);
    expect(h.sent.map((r) => r.type)).toEqual(['compare:validate-deployment', 'compare:deploy']);
    expect(h.sent[1]?.payload).toEqual({
      validationId: '0Af000000000001',
      targetOrgId: TARGET_ID,
    });
    // Retrieved once from the source; the target checks it, then takes the same package.
    expect(h.source.metadata.retrieve).toHaveBeenCalledTimes(1);
    expect(h.source.metadata.deploy).not.toHaveBeenCalled();
    expect(deploymentsOf(h.target)).toEqual([
      { zip: 'UEsDBBQ=', checkOnly: true, testLevel: 'RunLocalTests' },
      { zip: 'UEsDBBQ=', checkOnly: false, testLevel: 'RunLocalTests' },
    ]);
    expect(stdout).toContain('  validation 0Af000000000001: Succeeded, success');
    expect(stdout).toContain(
      'Deploy to TGT: the 2 components validated as 0Af000000000001 will be deployed to TGT, ' +
        'with the same tests, and TGT keeps them.',
    );
    expect(stdout).toContain('  deployment 0Af000000000002: Succeeded, success');
    expect(stdout).toContain('Setup › Deployment Status as 0Af000000000002');
  });

  it('records the deployment in the audit trail of its store, as the panel records its own', async () => {
    const h = harness();
    await h.run(noTerminal(), ...COMPONENTS, '--yes');

    const { entries } = new AuditTrailStore(
      fileConfigStore(join(h.dir, 'configStore.json')),
    ).list();
    expect(entries).toEqual([
      expect.objectContaining({
        action: 'metadata_deploy',
        module: 'compare',
        orgId: TARGET_ID,
        sourceOrgId: SOURCE_ID,
        outcome: 'success',
      }),
    ]);
  });

  it('says what the Deploy tab says before it deploys: the orgs, the components, and the tests it advises for Apex', async () => {
    const h = harness();
    const { stdout } = await h.run(noTerminal(), ...COMPONENTS, '--yes');

    expect(stdout).toContain('deploy from SRC to TGT, validated in TGT first');
    expect(stdout).toContain('  ApexClass Invoicing\n  CustomField Account.Region__c\n');
    expect(stdout).toContain(
      '  Apex tests in TGT: RunLocalTests — Apex is among the components: as the Deploy tab ' +
        'advises, the target’s own tests run unless --tests says otherwise',
    );
  });

  it('runs the tests asked for, and runs none for components that hold no Apex', async () => {
    const asked = harness();
    await asked.run(noTerminal(), ...COMPONENTS, '--tests', 'NoTestRun', '--yes');
    expect(deploymentsOf(asked.target).map((d) => d.testLevel)).toEqual(['NoTestRun', 'NoTestRun']);

    const noApex = harness();
    await noApex.run(noTerminal(), '--deploy', 'CustomField:Account.Region__c', '--yes');
    expect(deploymentsOf(noApex.target).map((d) => d.testLevel)).toEqual([
      'NoTestRun',
      'NoTestRun',
    ]);
  });

  it('asks for the target’s alias to be typed before it deploys, and deploys once it is', async () => {
    const h = harness();
    const typed = terminal('TGT');
    const { code } = await h.run(typed, ...COMPONENTS);

    expect(code).toBe(0);
    expect(typed.said()).toContain('Type TGT to deploy it:');
    expect(deploymentsOf(h.target).map((d) => d.checkOnly)).toEqual([true, false]);
  });

  it('deploys nothing when what is typed is not the alias, and exits 1', async () => {
    const h = harness();
    const { code, stdout } = await h.run(terminal('tgt'), ...COMPONENTS);

    expect(code).toBe(1);
    expect(h.sent.map((r) => r.type)).toEqual(['compare:validate-deployment']);
    expect(deploymentsOf(h.target).map((d) => d.checkOnly)).toEqual([true]);
    expect(stdout).toContain('Nothing was deployed: what was typed is not TGT.');
  });

  it('refuses, exit 2, with no terminal to type the alias on and no --yes, before it connects an org', async () => {
    const h = harness();
    const { code, stderr } = await h.run(noTerminal(), ...COMPONENTS);

    expect(code).toBe(2);
    expect(h.connected).toEqual([]);
    expect(stderr).toContain('give --yes');
    expect(stderr).toContain('--dry-run');
  });

  it('refuses a production target, exit 1, before it sends either org a request', async () => {
    const h = harness({ target: 'production' });
    const { code, stderr } = await h.run(noTerminal(), ...COMPONENTS, '--yes');

    expect(code).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.source.metadata.retrieve).not.toHaveBeenCalled();
    expect(h.target.metadata.deploy).not.toHaveBeenCalled();
    expect(stderr).toContain('TGT is a production org');
    expect(stderr).toContain('Nothing was written');
  });

  it('refuses a production target in a dry run as well, and names what runs against it', async () => {
    const h = harness({ target: 'production' });
    const { code, stderr } = await h.run(noTerminal(), ...COMPONENTS, '--dry-run');

    expect(code).toBe(1);
    expect(h.sent).toEqual([]);
    expect(stderr).toContain('a comparison without --deploy, which only reads, runs against it');
  });

  it('deploys to a sandbox and a Developer Edition org alike', async () => {
    const h = harness({ target: 'sandbox' });
    const { code } = await h.run(noTerminal(), ...COMPONENTS, '--yes');
    expect(code).toBe(0);
    expect(deploymentsOf(h.target).map((d) => d.checkOnly)).toEqual([true, false]);
  });

  it('lists what it would deploy in a dry run, and sends nothing to either org', async () => {
    const h = harness();
    const { code, stdout } = await h.run(noTerminal(), ...COMPONENTS, '--dry-run');

    expect(code).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.source.metadata.retrieve).not.toHaveBeenCalled();
    expect(h.target.metadata.deploy).not.toHaveBeenCalled();
    expect(stdout).toContain('  ApexClass Invoicing\n  CustomField Account.Region__c\n');
    expect(stdout).toContain('dry run: nothing was sent to SRC or TGT');
  });

  it('deploys nothing when the validation fails, and exits 3 as a failed validation does', async () => {
    const h = harness({ targetDeploys: [REFUSED] });
    const { code, stdout } = await h.run(noTerminal(), ...COMPONENTS, '--yes');

    expect(code).toBe(3);
    expect(h.sent.map((r) => r.type)).toEqual(['compare:validate-deployment']);
    expect(deploymentsOf(h.target).map((d) => d.checkOnly)).toEqual([true]);
    expect(stdout).toContain(
      '    failed        ApexClass Invoicing — Variable does not exist: total (line 12, column 5)',
    );
    expect(stdout).toContain('the validation did not succeed: nothing was deployed');
  });

  it('says a deployment the target refused was rolled back whole, and exits 3', async () => {
    const h = harness({ targetDeploys: [{}, REFUSED] });
    const { code, stdout } = await h.run(noTerminal(), ...COMPONENTS, '--yes');

    expect(code).toBe(3);
    expect(stdout).toContain('  deployment 0Af000000000002: Failed, no success');
    expect(stdout).toContain('rolled back: TGT kept nothing');

    const again = harness({ targetDeploys: [{}, REFUSED] });
    const json = await again.run(noTerminal(), ...COMPONENTS, '--yes', '--json');
    expect((JSON.parse(json.stdout) as { deploy: { outcome: string } }).deploy.outcome).toBe(
      'rolled-back',
    );
  });

  it('answers --json with both reports and what came of the deployment', async () => {
    const h = harness();
    const { stdout, stderr } = await h.run(noTerminal(), ...COMPONENTS, '--yes', '--json');

    const answer = JSON.parse(stdout) as {
      tool: string;
      results: Array<{ op: string; answer: { outcome: string } }>;
      deploy: Record<string, unknown>;
    };
    expect(answer.tool).toBe('sandforge-compare');
    expect(answer.results.map((r) => [r.op, r.answer.outcome])).toEqual([
      ['validate-deployment', 'answered'],
      ['deploy', 'answered'],
    ]);
    expect(answer.deploy).toMatchObject({
      source: 'SRC',
      target: 'TGT',
      testLevel: 'RunLocalTests',
      outcome: 'deployed',
      validationId: '0Af000000000001',
      deploymentId: '0Af000000000002',
    });
    expect(stderr).toContain('deployment 0Af000000000002: Succeeded, success');
  });
});

describe('sandforge compare, a diff', () => {
  /** Two fields only the source holds, one only the target holds: the counts tell the signs apart. */
  const fields = { source: ['Account.Gate__c', 'Account.Tier__c'], target: ['Account.Old__c'] };

  it('marks the fields only the source holds +, to deploy, as the page does, where it printed "-1 removed"', async () => {
    const h = harness({ fields });
    const { code, stdout } = await h.run(noTerminal(), '--op', 'execute', '--type', 'CustomField');

    expect(code).toBe(0);
    expect(stdout).toContain(
      '+2 only in the source  -1 only in the target  ~0 modified  =0 unchanged  ?0 not compared',
    );
    expect(stdout).toContain('  only in the source CustomField: Account.Gate__c, Account.Tier__c');
    expect(stdout).toContain('  only in the target CustomField: Account.Old__c');
  });

  it('names the changes in --json beside the page’s answer, which keeps its published words', async () => {
    const h = harness({ fields });
    const { stdout } = await h.run(
      noTerminal(),
      '--op',
      'execute',
      '--type',
      'CustomField',
      '--json',
    );

    const answer = JSON.parse(stdout) as {
      results: Array<{
        op: string;
        answer: { message: { payload: { diffs: Array<{ fullName: string; status: string }> } } };
        changes?: Record<string, string[]>;
      }>;
    };
    const [execute] = answer.results;
    expect(execute?.changes).toEqual({
      onlyInSource: ['CustomField:Account.Gate__c', 'CustomField:Account.Tier__c'],
      onlyInTarget: ['CustomField:Account.Old__c'],
      modified: [],
    });
    // The page's own message, unchanged: `removed` is only in the source.
    expect(execute?.answer.message.payload.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fullName: 'Account.Gate__c', status: 'removed' }),
        expect.objectContaining({ fullName: 'Account.Old__c', status: 'added' }),
      ]),
    );
  });
});

describe('sandforge compare --validate', () => {
  it('names --deploy once a validation succeeds, where it said this tool never deploys', async () => {
    const h = harness();
    const { code, stdout } = await h.run(noTerminal(), '--validate', 'ApexClass:Invoicing');

    expect(code).toBe(0);
    expect(h.sent.map((r) => r.type)).toEqual(['compare:validate-deployment']);
    expect(stdout).toContain('--deploy in place of each --validate deploys it');
    expect(stdout).not.toContain('never deploys');
  });
});

describe('progressLines', () => {
  /** A progress message of request `operationId`. */
  const progress = (operationId: string, currentStep: string, done: number, total: number) => ({
    id: 'p',
    type: 'operation:progress',
    timestamp: 0,
    payload: { operationId, currentStep, processedRecords: done, totalRecords: total },
  });

  it('says each move of the request it follows, in the Deploy tab’s words, and nothing else', () => {
    const said: string[] = [];
    const lines = progressLines((line) => said.push(line));
    lines.follow('cli-deploy-1');
    lines.onPost(progress('cli-deploy-1', 'components', 0, 2));
    lines.onPost(progress('cli-deploy-1', 'components', 0, 2));
    lines.onPost(progress('wv-other', 'components', 1, 2));
    lines.onPost(progress('cli-deploy-1', 'tests', 3, 40));
    lines.follow(undefined);
    lines.onPost(progress('cli-deploy-1', 'tests', 4, 40));

    expect(said).toEqual([
      '  checking the components: 0 of 2',
      '  running the Apex tests: 3 of 40',
    ]);
  });
});

describe('parseArgs, deploying', () => {
  const base = ['node', 'sandforge-compare.ts', '--source', 'SRC', '--target', 'TGT'];

  /** Run a parse that is meant to be refused, and report the exit. */
  function refuse(...args: string[]): { code: number | undefined; message: string } {
    let code: number | undefined;
    let message = '';
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c;
      throw new Error('exit');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      message += chunk;
      return true;
    }) as never);
    try {
      parseArgs([...base, ...args]);
    } catch {
      // `process.exit` is stubbed to throw so the parse stops where it would.
    }
    return { code, message };
  }

  it('reads the components to deploy, the tests, --yes and --dry-run', () => {
    const args = parseArgs([...base, '--deploy', 'Layout:Order-Order Layout', '--dry-run']);
    expect(args.deploy).toEqual({
      components: [{ componentType: 'Layout', fullName: 'Order-Order Layout' }],
      testLevel: 'NoTestRun',
      runTests: [],
      testsAdvised: false,
      yes: false,
      dryRun: true,
    });
    expect(args.operations).toEqual([]);
  });

  it('names --deploy when asked for the deploy operation, where it said the tool never deploys', () => {
    const { code, message } = refuse('--op', 'deploy');
    expect(code).toBe(2);
    expect(message).toContain('--deploy Type:Name');
    expect(message).not.toContain('never deploys');
  });

  it.each([
    ['--validate beside it, since it validates first', ['--validate', 'ApexClass:A']],
    ['--op beside it', ['--op', 'drift']],
    ['a comparison flag beside it', ['--type', 'ApexClass']],
    ['--dry-run and --yes together', ['--dry-run', '--yes']],
    ['a type a deployment does not carry', ['--deploy', 'Profile:Admin']],
  ])('refuses --deploy with %s', (_what, extra) => {
    const line = extra[0] === '--deploy' ? extra : ['--deploy', 'ApexClass:Invoicing', ...extra];
    expect(refuse(...line).code).toBe(2);
  });

  it.each([['--yes'], ['--dry-run']])('refuses %s without --deploy, which alone writes', (flag) => {
    const { code, message } = refuse('--op', 'drift', flag);
    expect(code).toBe(2);
    expect(message).toContain('--deploy');
  });
});
