import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';
import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';

import { main as envMain } from './sandforge-env.js';
import { runInProcess } from './testing/envWorld.js';

import {
  ERROR,
  HANDSHAKE_VERSIONS,
  PROTOCOL_VERSION,
  TOOLS,
  claimStdout,
  exitWords,
  serve,
  type CommandRun,
  type CommandRunner,
  type Script,
} from './sandforge-mcp.js';

/*
 * The MCP server driven as a client drives it: messages written to its input
 * one a line, its answers read off what it sends. The scripts it runs are
 * stood in for here, so what each call would run is read without an org; the
 * last test runs the server and a script for real, over the pipes of a
 * process of its own.
 */

type Message = Record<string, unknown> & {
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/** A tool call's result, as these tests read it. */
interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** The meta of a request of the revision this server follows. */
const PER_REQUEST = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  },
};

/** A stand-in for the scripts: what each call ran, and what it answers. */
function scripts(
  answer: (script: Script, args: readonly string[]) => Partial<CommandRun> = () => ({}),
) {
  const ran: Array<{ script: Script; args: string[] }> = [];
  const run: CommandRunner = (script, args) => {
    ran.push({ script, args: [...args] });
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...answer(script, args) });
  };
  return { ran, run };
}

/** A client of a server it stands up, with the scripts it is given. */
function client(runCommand: CommandRunner = scripts().run) {
  const input = new PassThrough();
  const lines: string[] = [];
  const received: Message[] = [];
  const waiting: Array<{ until: (message: Message) => boolean; resolve: (m: Message) => void }> =
    [];
  const serving = serve({
    input,
    send: (line) => {
      lines.push(line);
      const message = JSON.parse(line) as Message;
      received.push(message);
      for (const waiter of waiting.splice(0)) {
        if (waiter.until(message)) waiter.resolve(message);
        else waiting.push(waiter);
      }
    },
    runCommand,
    log: () => undefined,
  });
  let next = 1;
  const nextMessage = (until: (message: Message) => boolean): Promise<Message> =>
    new Promise((resolve) => {
      const already = received.find(until);
      if (already) resolve(already);
      else waiting.push({ until, resolve });
    });
  const request = (method: string, params?: unknown, id: string | number = next++) => {
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`,
    );
    return nextMessage((message) => message.id === id);
  };
  const initialized = async (version = HANDSHAKE_VERSIONS[0]) => {
    await request('initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const answer = await request('tools/call', { name, arguments: args });
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    return answer.result as unknown as CallResult;
  };
  return {
    input,
    lines,
    received,
    serving,
    request,
    nextMessage,
    initialized,
    call,
    write: (line: string) => input.write(`${line}\n`),
    close: async () => {
      input.end();
      await serving.done;
    },
  };
}

/** The text of a call's result: the lines the script said, and what the server added. */
const textOf = (result: CallResult): string => result.content[0]?.text ?? '';

describe('sandforge-mcp: the protocol', () => {
  it('agrees on the version initialize asks for when it serves it, and offers the newest it serves otherwise', async () => {
    const c = client();
    const asked = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const older = await c.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });

    expect(asked.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sandforge' },
      instructions: expect.stringContaining('confirm, the alias of that org exactly') as string,
    });
    expect(older.result?.protocolVersion).toBe('2025-11-25');
    expect(HANDSHAKE_VERSIONS[0]).toBe('2025-11-25');
    await c.close();
  });

  it('serves a request of 2026-07-28 with no handshake: its result says it is complete and who answered', async () => {
    const c = client();

    const discovered = await c.request('server/discover', PER_REQUEST);
    const listed = await c.request('tools/list', PER_REQUEST);

    expect(PROTOCOL_VERSION).toBe('2026-07-28');
    expect(discovered.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      cacheScope: 'public',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'sandforge' } },
    });
    expect(listed.result).toMatchObject({
      resultType: 'complete',
      cacheScope: 'public',
      ttlMs: expect.any(Number) as number,
    });
    expect((listed.result?.tools as unknown[]).length).toBe(TOOLS.length);
    await c.close();
  });

  it('refuses a version it does not serve with -32022, naming the one a request can name', async () => {
    const c = client();

    const answer = await c.request('tools/list', {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '1900-01-01',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    });

    expect(answer.error).toEqual({
      code: ERROR.unsupportedVersion,
      message: 'Unsupported protocol version',
      data: { supported: ['2026-07-28'], requested: '1900-01-01' },
    });
    await c.close();
  });

  it('refuses with -32602 a request naming no version before initialize, and one of 2026-07-28 without its client capabilities', async () => {
    const c = client();

    const bare = await c.request('tools/list');
    const noCapabilities = await c.request('tools/list', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION },
    });

    expect(bare.error?.code).toBe(ERROR.invalidParams);
    expect(bare.error?.message).toContain('or open with initialize');
    expect(noCapabilities.error?.code).toBe(ERROR.invalidParams);
    await c.close();
  });

  it('answers ping before the handshake, and serves tools/list after it with no _meta', async () => {
    const c = client();

    const pinged = await c.request('ping');
    await c.initialized();
    const listed = await c.request('tools/list');

    expect(pinged.result).toEqual({});
    expect(listed.result?.resultType).toBeUndefined();
    expect((listed.result?.tools as unknown[]).length).toBe(TOOLS.length);
    await c.close();
  });

  it('answers a line that is not JSON, a batch, an unknown method and an unknown tool with their JSON-RPC errors', async () => {
    const c = client();
    await c.initialized();

    c.write('{"jsonrpc":"2.0","id":');
    const parse = await c.nextMessage((m) => m.error?.code === ERROR.parse);
    c.write('[{"jsonrpc":"2.0","id":9,"method":"ping"}]');
    const batch = await c.nextMessage((m) => m.error?.code === ERROR.invalidRequest);
    const unknownMethod = await c.request('resources/list');
    const unknownTool = await c.request('tools/call', { name: 'run_apex', arguments: {} });

    expect(parse.id).toBeUndefined();
    expect(batch.error?.message).toContain('one message a line');
    expect(unknownMethod.error?.code).toBe(ERROR.methodNotFound);
    expect(unknownTool.error).toEqual({
      code: ERROR.invalidParams,
      message: 'Unknown tool: run_apex',
    });
    await c.close();
  });

  it('answers no notification, and reads a response as nothing to answer', async () => {
    const c = client();
    await c.initialized();

    c.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }));
    c.write(JSON.stringify({ jsonrpc: '2.0', id: 77, result: {} }));
    const pinged = await c.request('ping');

    expect(pinged.result).toEqual({});
    // The initialize answer and the ping's: nothing for the two lines between.
    expect(c.received.map((m) => m.id)).toEqual([1, 2]);
    await c.close();
  });

  it('sends one message a line, with no line break inside it, whatever the script said', async () => {
    const { run } = scripts(() => ({ code: 0, stdout: '[]\n', stderr: 'one\ntwo\r\nthree\n' }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_list', { org: 'DEV' });

    expect(textOf(result)).toContain('one\ntwo\r\nthree');
    for (const line of c.lines) expect(line).not.toMatch(/[\r\n]/);
    await c.close();
  });
});

describe('sandforge-mcp: the tools', () => {
  it('lists the thirteen tools in one order every time, the reads read-only and what deletes or writes over destructive', async () => {
    const c = client();
    await c.initialized();

    const first = await c.request('tools/list');
    const second = await c.request('tools/list');

    const tools = first.result?.tools as Array<{
      name: string;
      annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
    }>;
    expect(second.result?.tools).toEqual(tools);
    expect(tools.map((t) => t.name)).toEqual([
      'seed_templates',
      'seed_run',
      'clone_record',
      'run_remove',
      'checkpoint_list',
      'checkpoint_preview',
      'checkpoint_take',
      'checkpoint_rewind',
      'checkpoint_undo',
      'checkpoint_delete',
      'env_plan',
      'env_apply',
      'env_destroy',
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of ['seed_templates', 'checkpoint_list', 'checkpoint_preview', 'env_plan']) {
      expect(hints[name], name).toMatchObject({ readOnlyHint: true });
      expect(hints[name]?.destructiveHint, name).toBeUndefined();
    }
    for (const name of [
      'run_remove',
      'checkpoint_rewind',
      'checkpoint_undo',
      'checkpoint_delete',
      // An apply takes back the runs a replace or a resource the file dropped held.
      'env_apply',
      'env_destroy',
    ]) {
      expect(hints[name], name).toEqual(
        expect.objectContaining({ readOnlyHint: false, destructiveHint: true }),
      );
    }
    for (const name of ['seed_run', 'clone_record', 'checkpoint_take']) {
      expect(hints[name], name).toEqual(
        expect.objectContaining({ readOnlyHint: false, destructiveHint: false }),
      );
    }
    await c.close();
  });

  it('gives each tool an object schema that names no other argument than those it reads', () => {
    for (const { definition } of TOOLS) {
      expect(definition.inputSchema, definition.name).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(definition.inputSchema.$schema, definition.name).toBeUndefined();
    }
    const rewind = TOOLS.find((t) => t.definition.name === 'checkpoint_rewind');
    expect(rewind?.definition.inputSchema.required).toEqual(['org', 'checkpoint']);
    for (const name of ['env_plan', 'env_apply', 'env_destroy']) {
      const env = TOOLS.find((t) => t.definition.name === name);
      expect(env?.definition.inputSchema.required, name).toEqual(['file', 'org']);
    }
  });

  it('lists the built-in templates by their English names, running no script', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();

    const result = await c.call('seed_templates', {});

    const { templates } = result.structuredContent as {
      templates: Array<{ id: string; name: string; description: string; records: number }>;
    };
    expect(templates.map((t) => t.id)).toEqual(PREBUILT_SEED_TEMPLATES.map((t) => t.id));
    expect(templates[0]).toMatchObject({
      id: 'prebuilt-crm-starter',
      name: 'CRM Starter',
      records: 295,
    });
    for (const template of templates) {
      expect(template.name).not.toMatch(/^seed\.templates\./);
      expect(template.description).not.toMatch(/^seed\.templates\./);
    }
    expect(result.isError).toBe(false);
    expect(ran).toEqual([]);
    await c.close();
  });
});

describe('sandforge-mcp: confirm', () => {
  /** Every call that writes to an org, as it would be made without confirm. */
  const WRITES: Array<{ tool: string; org: string; args: Record<string, unknown> }> = [
    {
      tool: 'seed_run',
      org: 'DEV',
      args: { org: 'DEV', template: 'prebuilt-crm-starter', dryRun: false },
    },
    {
      tool: 'clone_record',
      org: 'SB',
      args: { source: 'SRC', target: 'SB', recordId: '001000000000001AAA', dryRun: false },
    },
    { tool: 'run_remove', org: 'DEV', args: { module: 'seed', org: 'DEV', run: 'run.ndjson' } },
    { tool: 'checkpoint_rewind', org: 'DEV', args: { org: 'DEV', checkpoint: 'baseline' } },
    { tool: 'checkpoint_undo', org: 'DEV', args: { org: 'DEV', checkpoint: 'baseline' } },
    { tool: 'checkpoint_delete', org: 'DEV', args: { org: 'DEV', checkpoint: 'baseline' } },
    { tool: 'env_apply', org: 'SB', args: { file: 'sandforge.yaml', org: 'SB' } },
    {
      tool: 'env_destroy',
      org: 'SB',
      args: { file: 'sandforge.yaml', org: 'SB', includeChanged: true },
    },
  ];

  it('refuses a write without confirm, or with another alias, before any script runs', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();

    for (const { tool, org, args } of WRITES) {
      for (const confirm of [undefined, `${org}2`, org.toLowerCase(), ` ${org}`]) {
        const result = await c.call(tool, confirm === undefined ? args : { ...args, confirm });
        expect(result.isError, `${tool} ${String(confirm)}`).toBe(true);
        expect(result.structuredContent).toMatchObject({ refusal: { code: 'CONFIRM' } });
        expect(textOf(result)).toContain(`${tool} writes to ${org}`);
        expect(textOf(result)).toContain(`Give confirm: "${org}"`);
        expect(textOf(result)).toContain('Refused: nothing was read or written.');
      }
    }
    expect(ran).toEqual([]);
    await c.close();
  });

  it('runs a dry run and a read with no confirm', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('seed_run', { org: 'DEV', template: 'prebuilt-crm-starter', dryRun: true });
    await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: true,
    });
    await c.call('checkpoint_preview', { org: 'DEV' });
    await c.call('checkpoint_take', { org: 'DEV', estimate: true });
    await c.call('checkpoint_list', { org: 'DEV' });
    await c.call('env_plan', { file: 'envs/sandforge.yaml', org: 'SB' });
    await c.call('env_plan', { file: '/repo/sandforge.yaml', org: 'SB', failOnDrift: true });

    expect(ran).toEqual([
      {
        script: 'sandforge-seed',
        args: ['--target', 'DEV', '--template', 'prebuilt-crm-starter', '--dry-run', '--json'],
      },
      {
        script: 'sandforge-clone',
        args: [
          '--record',
          '001000000000001AAA',
          '--source',
          'SRC',
          '--target',
          'SB',
          '--dry-run',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: ['preview', '--org', 'DEV', '--checkpoint', 'latest', '--json'],
      },
      { script: 'sandforge-checkpoint', args: ['take', '--org', 'DEV', '--estimate', '--json'] },
      { script: 'sandforge-checkpoint', args: ['list', '--org', 'DEV', '--json'] },
      {
        script: 'sandforge-env',
        args: ['plan', '--file', 'envs/sandforge.yaml', '--org', 'SB', '--json'],
      },
      {
        script: 'sandforge-env',
        args: [
          'plan',
          '--file',
          '/repo/sandforge.yaml',
          '--org',
          'SB',
          '--fail-on-drift',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('runs a confirmed write with the line its script takes: --yes where the script would ask, --json always', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('seed_run', {
      org: 'DEV',
      objects: [
        { objectApiName: 'Account', count: 5 },
        { objectApiName: 'Contact', count: 10 },
      ],
      dryRun: false,
      confirm: 'DEV',
    });
    await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      depth: 2,
      maxNodes: 80,
      dryRun: false,
      confirm: 'SB',
      acceptAutomation: true,
    });
    await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      depth: 'full',
      dryRun: false,
      confirm: 'SB',
    });
    for (const module of ['seed', 'forge', 'sync']) {
      await c.call('run_remove', { module, org: 'DEV', run: '/runs/a b.json', confirm: 'DEV' });
    }
    await c.call('checkpoint_take', {
      org: 'DEV',
      name: 'Before UAT',
      objects: ['Account', 'Case'],
    });
    await c.call('checkpoint_rewind', {
      org: 'DEV',
      checkpoint: 'Before UAT',
      confirm: 'DEV',
      acceptAutomation: true,
      acceptNoUndo: true,
      acceptRecreate: true,
      acceptOutside: true,
      acceptUnseen: true,
    });
    await c.call('checkpoint_rewind', { org: 'DEV', checkpoint: 'Before UAT', confirm: 'DEV' });
    await c.call('checkpoint_undo', {
      org: 'DEV',
      checkpoint: 'Before UAT',
      confirm: 'DEV',
      acceptAutomation: true,
    });
    await c.call('checkpoint_delete', { org: 'DEV', checkpoint: 'Before UAT', confirm: 'DEV' });
    await c.call('env_apply', { file: 'sandforge.yaml', org: 'SB', confirm: 'SB' });
    await c.call('env_apply', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
      replace: ['accounts', 'case-contacts'],
      acceptNoState: true,
    });
    await c.call('env_destroy', { file: 'sandforge.yaml', org: 'SB', confirm: 'SB' });
    await c.call('env_destroy', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
      includeChanged: true,
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-seed',
        args: ['--target', 'DEV', '--object', 'Account:5', '--object', 'Contact:10', '--json'],
      },
      {
        script: 'sandforge-clone',
        args: [
          '--record',
          '001000000000001AAA',
          '--source',
          'SRC',
          '--target',
          'SB',
          '--depth',
          'custom',
          '--custom-depth',
          '2',
          '--max-nodes',
          '80',
          '--accept-automation',
          '--json',
        ],
      },
      {
        script: 'sandforge-clone',
        args: [
          '--record',
          '001000000000001AAA',
          '--source',
          'SRC',
          '--target',
          'SB',
          '--depth',
          'full',
          '--json',
        ],
      },
      {
        script: 'sandforge-seed',
        args: ['--remove', '/runs/a b.json', '--target', 'DEV', '--json'],
      },
      {
        script: 'sandforge-clone',
        args: ['--remove', '/runs/a b.json', '--target', 'DEV', '--json'],
      },
      {
        script: 'sandforge-sync',
        args: ['--remove', '/runs/a b.json', '--target', 'DEV', '--json'],
      },
      {
        script: 'sandforge-checkpoint',
        args: [
          'take',
          '--org',
          'DEV',
          '--name',
          'Before UAT',
          '--object',
          'Account',
          '--object',
          'Case',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: [
          'rewind',
          '--org',
          'DEV',
          '--checkpoint',
          'Before UAT',
          '--yes',
          '--accept-automation',
          '--accept-no-undo',
          '--accept-recreate',
          '--accept-outside',
          '--accept-unseen',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: ['rewind', '--org', 'DEV', '--checkpoint', 'Before UAT', '--yes', '--json'],
      },
      {
        script: 'sandforge-checkpoint',
        args: [
          'undo',
          '--org',
          'DEV',
          '--checkpoint',
          'Before UAT',
          '--yes',
          '--accept-automation',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: ['delete', '--org', 'DEV', '--checkpoint', 'Before UAT', '--yes', '--json'],
      },
      {
        script: 'sandforge-env',
        args: ['apply', '--file', 'sandforge.yaml', '--org', 'SB', '--yes', '--json'],
      },
      {
        script: 'sandforge-env',
        args: [
          'apply',
          '--file',
          'sandforge.yaml',
          '--org',
          'SB',
          '--replace',
          'accounts',
          '--replace',
          'case-contacts',
          '--accept-no-state',
          '--yes',
          '--json',
        ],
      },
      {
        script: 'sandforge-env',
        args: ['destroy', '--file', 'sandforge.yaml', '--org', 'SB', '--yes', '--json'],
      },
      {
        script: 'sandforge-env',
        args: [
          'destroy',
          '--file',
          'sandforge.yaml',
          '--org',
          'SB',
          '--include-changed',
          '--yes',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('limits a rewind and its preview to the objects named, each as an --object of the script, and refuses a name that is no API name before any script runs', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('checkpoint_preview', { org: 'DEV', objects: ['Contact', 'Case'] });
    await c.call('checkpoint_rewind', {
      org: 'DEV',
      checkpoint: 'Before UAT',
      confirm: 'DEV',
      objects: ['Contact'],
    });
    const refused = await c.call('checkpoint_rewind', {
      org: 'DEV',
      checkpoint: 'Before UAT',
      confirm: 'DEV',
      objects: ['--accept-outside'],
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-checkpoint',
        args: [
          'preview',
          '--org',
          'DEV',
          '--checkpoint',
          'latest',
          '--object',
          'Contact',
          '--object',
          'Case',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: [
          'rewind',
          '--org',
          'DEV',
          '--checkpoint',
          'Before UAT',
          '--yes',
          '--object',
          'Contact',
          '--json',
        ],
      },
    ]);
    expect(JSON.stringify(refused)).toContain('objects');
    await c.close();
  });

  it('refuses, before any script runs, a value the script would read as a flag and an argument the tool does not read', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();

    const refusals = [
      await c.call('checkpoint_preview', { org: '--dry-run' }),
      await c.call('checkpoint_preview', { org: 'DEV', checkpoint: '--yes' }),
      await c.call('run_remove', { module: 'seed', org: 'DEV', run: '-x', confirm: 'DEV' }),
      await c.call('clone_record', {
        source: 'SRC',
        target: 'SB',
        recordId: 'not-an-id',
        dryRun: true,
      }),
      // A misspelt dryRun is no dry run: refused, never read as one left out.
      await c.call('seed_run', { org: 'DEV', template: 'prebuilt-crm-starter', dry_run: true }),
      await c.call('checkpoint_list', { org: 'DEV', store: '/elsewhere' }),
      // Every org's checkpoints would put the other orgs' names and aliases in the agent's context.
      await c.call('checkpoint_list', {}),
      await c.call('env_plan', { file: '--org=PROD', org: 'SB' }),
      await c.call('env_plan', { org: 'SB' }),
      await c.call('env_apply', {
        file: 'sandforge.yaml',
        org: 'SB',
        confirm: 'SB',
        replace: ['--replace-drifted'],
      }),
      // Not offered: a reset, a destroy by rewind, an apply's acceptance of automation.
      await c.call('env_destroy', {
        file: 'sandforge.yaml',
        org: 'SB',
        confirm: 'SB',
        rewind: true,
      }),
      await c.call('env_apply', {
        file: 'sandforge.yaml',
        org: 'SB',
        confirm: 'SB',
        acceptAutomation: true,
      }),
    ];

    for (const result of refusals) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
      expect(textOf(result)).toContain('Nothing was run.');
    }
    expect(textOf(refusals[4] as CallResult)).toContain('dryRun');
    expect(ran).toEqual([]);
    await c.close();
  });
});

describe("sandforge-mcp: a script's answer", () => {
  it("answers with the script's JSON beside its exit code and its lines; partial and unstable are answers, a refusal is an error", async () => {
    const answers: Record<string, Partial<CommandRun>> = {
      done: { code: 0, stdout: '{"status":"success"}\n', stderr: 'read again, nothing differs\n' },
      partial: { code: 3, stdout: '{"status":"partial"}', stderr: '' },
      unstable: { code: 4, stdout: '{"status":"unstable"}', stderr: '' },
      refused: {
        code: 1,
        stdout: '{"refusal":{"code":"PRODUCTION","message":"a production org"}}',
        stderr: 'a production org\n',
      },
      stopped: { code: 130, stdout: '', stderr: 'interrupted\n' },
    };
    let next = 'done';
    const { run } = scripts(() => answers[next] ?? {});
    const c = client(run);
    await c.initialized();

    const results: Record<string, CallResult> = {};
    for (const name of Object.keys(answers)) {
      next = name;
      results[name] = await c.call('checkpoint_preview', { org: 'DEV', checkpoint: 'baseline' });
    }

    expect(results.done).toMatchObject({
      isError: false,
      structuredContent: { exitCode: 0, answer: { status: 'success' } },
    });
    expect(textOf(results.done as CallResult)).toBe(
      'ran: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts preview --org DEV ' +
        '--checkpoint baseline --json\nexit 0: done\n\nread again, nothing differs',
    );
    expect(JSON.parse(results.done?.content[1]?.text ?? '')).toEqual(
      results.done?.structuredContent,
    );
    expect(results.partial).toMatchObject({ isError: false, structuredContent: { exitCode: 3 } });
    expect(results.unstable).toMatchObject({ isError: false, structuredContent: { exitCode: 4 } });
    expect(results.refused).toMatchObject({
      isError: true,
      structuredContent: { exitCode: 1, answer: { refusal: { code: 'PRODUCTION' } } },
    });
    expect(results.stopped).toMatchObject({ isError: true, structuredContent: { exitCode: 130 } });
    expect(textOf(results.stopped as CallResult)).toContain('exit 130: stopped by SIGINT');
    await c.close();
  });

  it('gives back a question the script asked as the call’s error, in its words, for the person using the agent to answer', async () => {
    const question =
      "Delete 'baseline' from this machine? DEV can no longer be rewound to it. The org is not " +
      'touched. [y/N]\nno terminal to answer: give --yes to go ahead without the question.\n';
    const { run } = scripts(() => ({ code: 2, stderr: question }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_delete', {
      org: 'DEV',
      checkpoint: 'baseline',
      confirm: 'DEV',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Delete 'baseline' from this machine?");
    expect(textOf(result)).toContain('It is a question for the person using you');
    expect(exitWords(2)).toContain('nothing was written');
    await c.close();
  });

  it('names acceptUnseen as the parameter a rewind refused for what its user cannot see stands for', async () => {
    const refusal =
      "Deleting 2 Account record(s) created since also deletes what tester@example.com can't " +
      "see under them in Task: Rewind can't count those. Rewind refused; give --accept-unseen " +
      'to rewind all the same. No record was written.';
    const { run } = scripts(() => ({
      code: 1,
      stdout: JSON.stringify({ refusal: { code: 'UNSEEN', message: refusal } }),
      stderr: `${refusal}\n`,
    }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_rewind', {
      org: 'DEV',
      checkpoint: 'baseline',
      confirm: 'DEV',
    });

    expect(textOf(result)).toContain(
      "--accept-unseen, named above, is this tool's acceptUnseen: true. Give it only once the " +
        'person using you has accepted what it lets through.',
    );
    await c.close();
  });

  it('names the parameter a flag the script names stands for, as the person’s to give', async () => {
    const refusal =
      'DEV: what runs as the rewind writes could not all be read, so automation may run. Rewind ' +
      'refused; give --accept-automation to rewind all the same. No record was written.';
    const { run } = scripts(() => ({
      code: 1,
      stdout: JSON.stringify({ refusal: { code: 'AUTOMATION', message: refusal } }),
      stderr: `${refusal}\n`,
    }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_rewind', {
      org: 'DEV',
      checkpoint: 'baseline',
      confirm: 'DEV',
    });

    expect(textOf(result)).toContain(
      "--accept-automation, named above, is this tool's acceptAutomation: true. Give it only " +
        'once the person using you has accepted what it lets through.',
    );
    expect(textOf(result)).not.toContain('acceptNoUndo');
    await c.close();
  });

  it('says how to take a seed or a clone back, from the run file or the journal its answer names', async () => {
    const { run } = scripts((script) => ({
      stdout: JSON.stringify(
        script === 'sandforge-seed'
          ? { runFile: '/j/seed-runs/r1.ndjson' }
          : { journal: '/j/forge-runs/f1.ndjson' },
      ),
    }));
    const c = client(run);
    await c.initialized();

    const seeded = await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: false,
      confirm: 'DEV',
    });
    const cloned = await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
    });
    const dry = await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: true,
    });

    expect(textOf(seeded)).toContain(
      'run_remove with module "seed" and run "/j/seed-runs/r1.ndjson" takes this run back.',
    );
    expect(textOf(cloned)).toContain(
      'run_remove with module "forge" and run "/j/forge-runs/f1.ndjson" takes this run back.',
    );
    expect(textOf(dry)).not.toContain('run_remove');
    await c.close();
  });

  it('answers a script that could not be started with why', async () => {
    const c = client(() => Promise.reject(new Error('spawn ENOENT')));
    await c.initialized();

    const result = await c.call('checkpoint_list', { org: 'DEV' });

    expect(result).toMatchObject({ isError: true, structuredContent: { exitCode: 1 } });
    expect(textOf(result)).toContain('sandforge-checkpoint could not be started: spawn ENOENT');
    await c.close();
  });
});

describe('sandforge-mcp: the environment tools', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("answers env_plan with the env script's own refusal of a file that does not validate, exit 2, before any org is reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-env-'));
    dirs.push(dir);
    const project = join(dir, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const file = join(project, 'sandforge.yaml');
    writeFileSync(file, 'version: 1\nname: Not A Name\nresources: {}\n');
    const reached: string[] = [];
    const ran: string[][] = [];
    // The env script's own main, its output read as a process's would be.
    const run: CommandRunner = async (script, args) => {
      if (script !== 'sandforge-env') throw new Error(`no ${script} here`);
      ran.push([...args]);
      return runInProcess(() =>
        envMain(['node', 'sandforge-env.ts', ...args], {
          reach: (alias) => {
            reached.push(alias);
            return Promise.reject(new Error('no org here'));
          },
          runner: () => Promise.reject(new Error('no script here')),
          journalDir: join(dir, 'journal'),
          locksDir: join(dir, 'locks'),
          onStop: () => () => undefined,
          cwd: project,
        }),
      );
    };
    const c = client(run);
    await c.initialized();

    const result = await c.call('env_plan', { file, org: 'SB' });

    expect(ran).toEqual([['plan', '--file', file, '--org', 'SB', '--json']]);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { exitCode: 2, answer: { refusal: { code: 'INVALID_FILE' } } },
    });
    expect(textOf(result)).toContain('does not validate');
    expect(reached).toEqual([]);
    await c.close();
  });

  it('says a plan that found drift is an answer, in its own words, not a partial run', async () => {
    const { run } = scripts(() => ({ code: 3, stdout: '{"env":"case-flow","actions":[]}' }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('env_plan', {
      file: 'sandforge.yaml',
      org: 'SB',
      failOnDrift: true,
    });

    expect(result).toMatchObject({ isError: false, structuredContent: { exitCode: 3 } });
    expect(textOf(result)).toContain(
      'exit 3: drift: the org no longer holds the environment as applied',
    );
    expect(textOf(result)).not.toContain('partial');
    await c.close();
  });

  it('names acceptNoState and includeChanged where the env script names their flags, and how an apply is taken back', async () => {
    const noState =
      'This machine keeps no state of case-flow on SB: records an earlier apply left there ' +
      'cannot be told from the org’s own. On a sandbox that lives on, apply asks ' +
      '--accept-no-state to go ahead: restore the journal directory of the apply before it, or ' +
      'give the flag. Nothing was written.\n';
    const answers: Array<Partial<CommandRun>> = [
      { code: 1, stdout: JSON.stringify({ refusal: { code: 'NO_STATE' } }), stderr: noState },
      { code: 0, stdout: '{"status":"success"}' },
      {
        code: 3,
        stdout: '{"status":"partial"}',
        stderr: '1 kept, changed since the apply: --include-changed takes it\n',
      },
    ];
    const { run } = scripts(() => answers.shift() ?? {});
    const c = client(run);
    await c.initialized();

    const refused = await c.call('env_apply', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
    });
    const applied = await c.call('env_apply', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
      acceptNoState: true,
    });
    const left = await c.call('env_destroy', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
    });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(
      "--accept-no-state, named above, is this tool's acceptNoState: true.",
    );
    // A refusal is no apply: there is nothing to take back.
    expect(textOf(refused)).not.toContain('env_destroy');
    expect(applied.isError).toBe(false);
    expect(textOf(applied)).toContain(
      'env_destroy with file "sandforge.yaml" and org "SB" takes this environment back.',
    );
    expect(left.isError).toBe(false);
    expect(textOf(left)).toContain(
      "--include-changed, named above, is this tool's includeChanged: true.",
    );
    await c.close();
  });
});

describe('sandforge-mcp: stopping', () => {
  /** A script that runs until it is stopped, and ends as Ctrl-C ends it. */
  function stoppable() {
    const signals: AbortSignal[] = [];
    const run: CommandRunner = (_script, _args, signal) =>
      new Promise((resolve) => {
        signals.push(signal);
        signal.addEventListener('abort', () =>
          resolve({ code: 130, stdout: '', stderr: 'interrupted\n' }),
        );
      });
    return { signals, run };
  }

  it('stops a call the client cancels as Ctrl-C stops its script, and answers nothing for it', async () => {
    const { signals, run } = stoppable();
    const c = client(run);
    await c.initialized();

    c.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'take',
        method: 'tools/call',
        params: { name: 'checkpoint_take', arguments: { org: 'DEV' } },
      }),
    );
    await expect.poll(() => signals.length).toBe(1);
    c.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'take', reason: 'the user stopped it' },
      }),
    );
    await expect.poll(() => signals[0]?.aborted).toBe(true);
    const pinged = await c.request('ping');

    expect(pinged.result).toEqual({});
    expect(c.received.some((m) => m.id === 'take')).toBe(false);
    await c.close();
    expect(c.received.some((m) => m.id === 'take')).toBe(false);
  });

  it('stops the calls under way once its input ends, answers them, and is done once they are', async () => {
    const { signals, run } = stoppable();
    const c = client(run);
    await c.initialized();

    c.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'rewind',
        method: 'tools/call',
        params: {
          name: 'checkpoint_rewind',
          arguments: { org: 'DEV', checkpoint: 'baseline', confirm: 'DEV' },
        },
      }),
    );
    await expect.poll(() => signals.length).toBe(1);
    await c.close();

    expect(signals[0]?.aborted).toBe(true);
    const answer = c.received.find((m) => m.id === 'rewind');
    expect((answer?.result as unknown as CallResult | undefined)?.structuredContent).toEqual({
      exitCode: 130,
    });
  });
});

describe('claimStdout', () => {
  it('keeps stdout for the protocol: whatever else writes there lands on stderr', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const send = claimStdout(stdout, stderr);

    stdout.write('a stray line\n');
    send('{"jsonrpc":"2.0","id":1,"result":{}}');

    expect(String(stdout.read())).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(String(stderr.read())).toBe('a stray line\n');
  });
});

describe('sandforge-mcp over the pipes of a process of its own', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('answers initialize, lists its tools, refuses a rewind without confirm and runs the checkpoint script for a list, nothing but messages on stdout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandforge-mcp-'));
    dirs.push(home);
    const tsx = createRequire(join(__dirname, 'sandforge-mcp.ts')).resolve('tsx/cli');
    const server = spawn(process.execPath, [tsx, join(__dirname, 'sandforge-mcp.ts')], {
      // A home and a store of the test's own: the list reads them, and nothing else.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SANDFORGE_JOURNAL_DIR: join(home, 'journal'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    const waiting = new Map<number, (message: Message) => void>();
    createInterface({ input: server.stdout }).on('line', (line) => {
      lines.push(line);
      const message = JSON.parse(line) as Message;
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    });
    let stderr = '';
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve) => server.on('close', resolve));
    const request = (id: number, method: string, params: unknown): Promise<Message> =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const initialized = await request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listed = await request(2, 'tools/list', {});
    const rewind = await request(3, 'tools/call', {
      name: 'checkpoint_rewind',
      arguments: { org: 'DEV', checkpoint: 'baseline' },
    });
    const list = await request(4, 'tools/call', {
      name: 'checkpoint_list',
      arguments: { org: 'DEV' },
    });
    server.stdin.end();

    expect(await exited, stderr).toBe(0);
    expect(initialized.result?.protocolVersion).toBe('2025-11-25');
    expect((listed.result?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(
      TOOLS.map((t) => t.definition.name),
    );
    expect(rewind.result).toMatchObject({
      isError: true,
      structuredContent: { refusal: { code: 'CONFIRM' } },
    });
    expect(list.result, stderr).toMatchObject({
      isError: false,
      structuredContent: { exitCode: 0, answer: [] },
    });
    expect(textOf(list.result as unknown as CallResult)).toContain('No checkpoint is kept in');
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    // Its own lines, and the script's, on stderr.
    expect(stderr).toContain('sandforge-mcp: 13 tools on stdio');
    expect(stderr).toContain('No checkpoint is kept in');
  }, 60_000);
});
