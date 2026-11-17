import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';
import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';

import { archiveKeyText } from '../src/modules/checkpoint/checkpointArchive.js';
import { removalAutomationRefusal } from '../src/modules/forge/ForgeRunGate.js';
import type { ClonePlanReceipt } from './mcpClonePlans.js';
import { refusedLine } from './runRefused.js';
import { rootsMaxTotalRefusal, rootsStorageRefusal, sweepOptionWords } from './sandforge-clone.js';
import { main as envMain } from './sandforge-env.js';
import { RELAYED_BY_VARIABLE } from './scriptRunner.js';
import { runInProcess } from './testing/envWorld.js';
import { undeletableRefusal } from './undeletableAnswer.js';
import { commandOf } from './invocation.js';

import {
  ERROR,
  HANDSHAKE_VERSIONS,
  INSTRUCTIONS,
  PROTOCOL_VERSION,
  TOOLS,
  claimStdout,
  cloneOrgPlanLine,
  exitWords,
  planLines,
  planSummaryOf,
  serve,
  toolRunner,
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

/**
 * A client of a server it stands up, with the scripts it is given, and the
 * journal folder its plans and runs are kept in when a test runs a tool that keeps one, and how
 * long a call holds its script before it hands its run back.
 */
function client(
  runCommand: CommandRunner = scripts().run,
  options: { journalDir?: string; holdMs?: number } = {},
) {
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
    ...(options.journalDir !== undefined ? { journalDir: options.journalDir } : {}),
    ...(options.holdMs !== undefined ? { holdMs: options.holdMs } : {}),
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
  it('lists the twenty-four tools in one order every time, the reads read-only and what deletes or writes over destructive', async () => {
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
      'clone_records',
      'clone_org_plan',
      'clone_org',
      'run_remove',
      'run_status',
      'run_stop',
      'checkpoint_list',
      'checkpoint_preview',
      'checkpoint_take',
      'checkpoint_rewind',
      'checkpoint_undo',
      'checkpoint_delete',
      'checkpoint_replay',
      'checkpoint_replay_remove',
      'empty_preview',
      'empty_run',
      'empty_undo',
      'env_plan',
      'env_apply',
      'env_destroy',
      'pipeline_plan',
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      'seed_templates',
      'run_status',
      'checkpoint_list',
      'checkpoint_preview',
      'empty_preview',
      'env_plan',
      // A pipeline's plan reads its orgs, on a copy of its store.
      'pipeline_plan',
    ]) {
      expect(hints[name], name).toMatchObject({ readOnlyHint: true });
      expect(hints[name]?.destructiveHint, name).toBeUndefined();
    }
    for (const name of [
      'run_remove',
      'checkpoint_rewind',
      'checkpoint_undo',
      'checkpoint_delete',
      // A replay given again takes back first what the replays before it created.
      'checkpoint_replay',
      'checkpoint_replay_remove',
      'empty_run',
      'empty_undo',
      // An apply takes back the runs a replace or a resource the file dropped held.
      'env_apply',
      'env_destroy',
    ]) {
      expect(hints[name], name).toEqual(
        expect.objectContaining({ readOnlyHint: false, destructiveHint: true }),
      );
    }
    // A plan is kept on this machine, a clone of the whole org inserts, and a
    // run stopped keeps what it wrote: none deletes or writes over.
    for (const name of [
      'seed_run',
      'clone_record',
      'clone_records',
      'clone_org_plan',
      'clone_org',
      'run_stop',
      'checkpoint_take',
    ]) {
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
    {
      tool: 'clone_records',
      org: 'SB',
      args: { source: 'SRC', target: 'SB', object: 'Account', limit: 5, dryRun: false },
    },
    { tool: 'run_remove', org: 'DEV', args: { module: 'seed', org: 'DEV', run: 'run.ndjson' } },
    { tool: 'checkpoint_rewind', org: 'DEV', args: { org: 'DEV', checkpoint: 'baseline' } },
    { tool: 'checkpoint_undo', org: 'DEV', args: { org: 'DEV', checkpoint: 'baseline' } },
    { tool: 'checkpoint_delete', org: 'DEV', args: { org: 'DEV', checkpoint: 'baseline' } },
    {
      tool: 'checkpoint_replay',
      org: 'SB',
      args: { checkpoint: 'ck-20261101-110000-c3d4', target: 'SB', dryRun: false, maxRecords: 12 },
    },
    {
      tool: 'checkpoint_replay_remove',
      org: 'SB',
      args: { checkpoint: 'ck-20261101-110000-c3d4', target: 'SB' },
    },
    { tool: 'empty_run', org: 'DEV', args: { org: 'DEV', objects: ['Contact'] } },
    { tool: 'empty_undo', org: 'DEV', args: { org: 'DEV', run: 'em-20261113-101500-ab12' } },
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
    await c.call('env_plan', {
      file: '/repo/sandforge.yaml',
      org: 'SB',
      failOnDrift: true,
      acceptEmails: true,
    });

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
      // The replays into the org, read off this machine as its checkpoints are.
      { script: 'sandforge-checkpoint', args: ['replays', '--target', 'DEV', '--json'] },
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
          '--accept-emails',
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
      acceptEmails: true,
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
      acceptEmails: true,
    });
    await c.call('checkpoint_delete', { org: 'DEV', checkpoint: 'Before UAT', confirm: 'DEV' });
    await c.call('env_apply', { file: 'sandforge.yaml', org: 'SB', confirm: 'SB' });
    await c.call('env_apply', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
      replace: ['accounts', 'case-contacts'],
      acceptNoState: true,
      acceptEmails: true,
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
          '--accept-emails',
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
          '--accept-emails',
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
          '--accept-emails',
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

  it('names acceptEmails where a rewind or an undo is refused for the emails the org delivers, and never takes it from acceptAutomation', async () => {
    const refusal =
      'DEV delivers every email its automation sends (Setup > Deliverability: All email). ' +
      'Nothing was written. Add --accept-emails to rewind all the same.';
    const { run, ran } = scripts(() => ({
      code: 1,
      stdout: JSON.stringify({ refusal: { code: 'EMAILS_DELIVERED', message: refusal } }),
      stderr: `${refusal}\n`,
    }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_rewind', {
      org: 'DEV',
      checkpoint: 'baseline',
      confirm: 'DEV',
      acceptAutomation: true,
    });

    expect(textOf(result)).toContain(
      "--accept-emails, named above, is this tool's acceptEmails: true. Give it only once the " +
        'person using you has accepted what it lets through.',
    );
    expect(ran[0]?.args).toContain('--accept-automation');
    expect(ran[0]?.args).not.toContain('--accept-emails');
    await c.close();
  });

  it('hands muteAutomation to a rewind and an undo as --mute-automation, and names it where their refusal names the flag', async () => {
    // The rewind's refusal for the emails said "--mute-automation keeps quiet
    // ..." to a reader whose checkpoint_rewind and checkpoint_undo took no
    // such parameter, though the script's rewind and undo take the flag.
    const refusal =
      'DEV delivers every email its automation sends (Setup > Deliverability: All email), and ' +
      'flow "Welcome Email" on Contact sends some as the rewind writes. Nothing was written. ' +
      "Add --accept-emails to rewind all the same, set the org's deliverability to System " +
      'email only, or turn off what sends them. --mute-automation keeps quiet flow "Welcome ' +
      'Email" on Contact, which tests a bypass a permission set of DEV holds.';
    const { run, ran } = scripts((_script, args) =>
      args.includes('--mute-automation')
        ? { code: 0, stdout: '{}' }
        : {
            code: 1,
            stdout: JSON.stringify({ refusal: { code: 'EMAILS_DELIVERED', message: refusal } }),
            stderr: `${refusal}\n`,
          },
    );
    const c = client(run);
    await c.initialized();
    const asked = { org: 'DEV', checkpoint: 'baseline', confirm: 'DEV' };

    const rewound = await c.call('checkpoint_rewind', asked);
    const undone = await c.call('checkpoint_undo', asked);
    const muted = await c.call('checkpoint_rewind', { ...asked, muteAutomation: true });
    const undoMuted = await c.call('checkpoint_undo', { ...asked, muteAutomation: true });

    for (const answered of [rewound, undone]) {
      expect(textOf(answered)).toContain(
        "--mute-automation, named above, is this tool's muteAutomation: true. Give it only once " +
          'the person using you has accepted what it lets through.',
      );
    }
    for (const answered of [muted, undoMuted]) expect(answered.isError).toBe(false);
    expect(ran.map(({ args }) => args.includes('--mute-automation'))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    await c.close();
  });

  it('hands acceptEmails to a seed and a clone as --accept-emails, never from acceptAutomation, and names it where they are refused for the emails', async () => {
    const refusal =
      'DEV delivers every email its automation sends (Setup > Deliverability: All email). ' +
      'Nothing was written. Add --accept-emails to seed all the same.';
    const { run, ran } = scripts(() => ({ code: 1, stderr: `${refusal}\n` }));
    const c = client(run);
    await c.initialized();

    const seeded = await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: false,
      confirm: 'DEV',
    });
    await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: false,
      confirm: 'DEV',
      acceptEmails: true,
    });
    const cloned = await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
      acceptAutomation: true,
    });
    await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
      acceptEmails: true,
    });

    const named =
      "--accept-emails, named above, is this tool's acceptEmails: true. Give it only once the " +
      'person using you has accepted what it lets through.';
    expect(textOf(seeded)).toContain(named);
    expect(textOf(cloned)).toContain(named);
    expect(ran.map((line) => line.args.includes('--accept-emails'))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(ran[2]?.args).toContain('--accept-automation');
    expect(ran[3]?.args).not.toContain('--accept-automation');
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

  it('says how to take back a seed, a clone or an apply stopped part way, as it does one that went through', async () => {
    // Stopped by Ctrl-C, a kill or a closed terminal, a seed or a clone said
    // "stopped by SIGINT" and nothing that took back what it had written.
    const { run } = scripts((script) => ({
      code: 130,
      stdout: JSON.stringify(
        script === 'sandforge-seed'
          ? { runFile: '/j/seed-runs/r1.ndjson', interrupted: true }
          : { journal: '/j/forge-runs/f1.ndjson', interrupted: true },
      ),
      stderr: 'interrupted\n',
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
    const applied = await c.call('env_apply', { file: 'sandforge.yaml', org: 'SB', confirm: 'SB' });

    for (const result of [seeded, cloned, applied]) {
      expect(result.structuredContent.exitCode).toBe(130);
      expect(textOf(result)).toContain('exit 130: stopped by SIGINT before it was through');
      expect(textOf(result)).toContain(
        'It stopped part way, between two calls to the org: what it wrote is kept, and said above.',
      );
    }
    expect(textOf(seeded)).toContain(
      'run_remove with module "seed" and run "/j/seed-runs/r1.ndjson" takes this run back.',
    );
    expect(textOf(cloned)).toContain(
      'run_remove with module "forge" and run "/j/forge-runs/f1.ndjson" takes this run back.',
    );
    expect(textOf(applied)).toContain(
      'env_destroy with file "sandforge.yaml" and org "SB" takes this environment back.',
    );
    await c.close();
  });

  it('previews a removal of a Seed or Forge run without confirm, as --preview, and refuses it for a Sync run', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    for (const module of ['seed', 'forge']) {
      const previewed = await c.call('run_remove', {
        module,
        org: 'DEV',
        run: 'run.json',
        preview: true,
      });
      expect(previewed.isError, module).toBe(false);
    }
    const sync = await c.call('run_remove', {
      module: 'sync',
      org: 'DEV',
      run: 'run.json',
      preview: true,
    });
    const unconfirmed = await c.call('run_remove', {
      module: 'forge',
      org: 'DEV',
      run: 'run.json',
    });

    expect(sync.structuredContent).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    expect(textOf(sync)).toContain('preview goes with module "seed" or "forge"');
    expect(textOf(unconfirmed)).toContain(
      'Before it, run_remove with preview: true (a Seed or Forge run) says what it would delete',
    );
    const line = ['--remove', 'run.json', '--target', 'DEV', '--preview', '--json'];
    expect(ran).toEqual([
      { script: 'sandforge-seed', args: line },
      { script: 'sandforge-clone', args: line },
    ]);
    await c.close();
  });

  it('names preview where a removal’s lines name --preview, which the server tells the script it takes', async () => {
    const { run } = scripts(() => ({
      code: 3,
      stdout: '{}',
      stderr: 'delete them by hand, then remove the run again; --preview says what of it…\n',
    }));
    const c = client(run);
    await c.initialized();

    const removed = await c.call('run_remove', {
      module: 'forge',
      org: 'DEV',
      run: 'run.json',
      confirm: 'DEV',
    });

    expect(textOf(removed)).toContain(
      "--preview, named above, is this tool's preview: true, for a Seed or Forge run",
    );
    await c.close();
  });

  it('hands includeChanged, muteAutomation and leaveUndeletable to the line of a removal, each only once asked', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    for (const module of ['seed', 'forge', 'sync']) {
      await c.call('run_remove', {
        module,
        org: 'DEV',
        run: 'run.json',
        confirm: 'DEV',
        includeChanged: true,
        acceptAutomation: true,
        muteAutomation: true,
        leaveUndeletable: true,
      });
    }

    const line = [
      '--remove',
      'run.json',
      '--target',
      'DEV',
      '--include-changed',
      '--accept-automation',
      '--mute-automation',
      '--leave-undeletable',
      '--json',
    ];
    expect(ran).toEqual([
      { script: 'sandforge-seed', args: line },
      { script: 'sandforge-clone', args: line },
      { script: 'sandforge-sync', args: line },
    ]);
    await c.close();
  });

  it("names the parameter each answer a removal's lines give stands for: the records changed since, the mute, what its user may not delete", async () => {
    // run_remove relayed these flags and took none of them: the person using
    // the agent was sent to a parameter the tool refused.
    const automation = {
      objectsRead: ['Account'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountCleanup', events: ['beforeDelete' as const] }],
        },
      ],
      unread: [],
    };
    const fires = removalAutomationRefusal(automation, 'DEV', {
      assign: [{ permission: 'Skip_Cleanup', permissionSet: 'Cleanup_Bypass', others: [] }],
      mayMute: true,
    });
    const answers: Array<Partial<CommandRun>> = [
      {
        code: 1,
        stderr: `${refusedLine({ code: 'AUTOMATION_NOT_ACCEPTED', message: fires ?? '' })}\n`,
      },
      {
        code: 1,
        stderr: `${refusedLine(undeletableRefusal([{ objectApiName: 'Account', records: 2 }], 'DEV'))}\n`,
      },
      {
        code: 0,
        stderr:
          'records changed since the run stay, as do those records added since depend on ' +
          '(--include-changed takes them)\n',
      },
    ];
    const { run } = scripts(() => answers.shift() ?? {});
    const c = client(run);
    await c.initialized();
    const remove = (module: string) =>
      c.call('run_remove', { module, org: 'DEV', run: 'run.json', confirm: 'DEV' });

    const muted = textOf(await remove('seed'));
    const left = textOf(await remove('sync'));
    const changed = textOf(await remove('forge'));

    expect(muted).toContain('With --mute-automation, the removal assigns Cleanup_Bypass');
    expect(muted).toContain(
      "--mute-automation, named above, is this tool's muteAutomation: true. Give it only once " +
        'the person using you has accepted what it lets through.',
    );
    expect(muted).toContain(
      "--accept-automation, named above, is this tool's acceptAutomation: true.",
    );
    expect(left).toContain('run again with --leave-undeletable');
    expect(left).toContain(
      "--leave-undeletable, named above, is this tool's leaveUndeletable: true.",
    );
    expect(changed).toContain(
      "--include-changed, named above, is this tool's includeChanged: true.",
    );
    await c.close();
  });

  it('hands muteAutomation to a seed and a clone as --mute-automation, a dry run as a write, and names it where their lines name the flag', async () => {
    // seed_run and clone_record relayed "--mute-automation keeps quiet ..."
    // and took no such parameter. A script asked to mute names the flag no
    // more, as a seed under it did not on the trap org: its lines say the
    // mute it plans, and the refusal it would have met without it is gone.
    const sends =
      'refused (EMAILS_NOT_ACCEPTED): DEV delivers every email its automation sends. ' +
      'Nothing was written. --mute-automation keeps quiet flow "Welcome Email" on Contact, ' +
      'which tests a bypass a permission set of DEV holds.\n';
    const muted =
      'mute: planned, the permission set(s) holding Welcome_Bypass for the user it writes as ' +
      'in DEV, for the run alone; nothing is assigned yet\n' +
      '  silenced: flow "Welcome Email" on Contact (bypass Welcome_Bypass)\n';
    const { ran, run } = scripts((_script, args) =>
      args.includes('--mute-automation')
        ? { code: 0, stdout: '{}', stderr: muted }
        : { code: 1, stderr: sends },
    );
    const c = client(run);
    await c.initialized();

    const seededMuted = await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: true,
      muteAutomation: true,
    });
    const clonedMuted = await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
      muteAutomation: true,
    });
    const seeded = await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: true,
    });
    const cloned = await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
    });

    expect(ran.map(({ args }) => args.includes('--mute-automation'))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    for (const answered of [seededMuted, clonedMuted]) {
      expect(textOf(answered)).toContain('mute: planned, the permission set(s) holding');
      expect(textOf(answered)).not.toContain('named above');
    }
    for (const answered of [seeded, cloned]) {
      expect(textOf(answered)).toContain(
        "--mute-automation, named above, is this tool's muteAutomation: true.",
      );
    }
    await c.close();
  });

  it('hands store to the removal of a Sync run as its --store, names it where the line asks for it, and refuses it for any other module', async () => {
    // run_remove relayed "Give --store with the next removal" and took no store.
    const unsaid =
      'The run was of the saved configuration cfg-1, and its store was not given: its next ' +
      'delta run is not told what this removal took, and a later run may point a lookup at a ' +
      'record it deleted. Give --store with the next removal, or run the configuration full ' +
      'next time.\n';
    const { ran, run } = scripts(() => ({ stdout: '{}', stderr: unsaid }));
    const c = client(run);
    await c.initialized();

    const removed = await c.call('run_remove', {
      module: 'sync',
      org: 'DEV',
      run: 'run.json',
      confirm: 'DEV',
      store: 'configs/sync',
    });
    const seed = await c.call('run_remove', {
      module: 'seed',
      org: 'DEV',
      run: 'run.json',
      confirm: 'DEV',
      store: 'configs/sync',
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-sync',
        args: ['--remove', 'run.json', '--target', 'DEV', '--store', 'configs/sync', '--json'],
      },
    ]);
    expect(textOf(removed)).toContain(
      "--store, named above, is this tool's store: the directory of the run's saved " +
        'configuration, as the person using you names it.',
    );
    expect(seed).toMatchObject({
      isError: true,
      structuredContent: { refusal: { code: 'ARGUMENTS' } },
    });
    expect(textOf(seed)).toContain('store goes with module "sync"');
    await c.close();
  });

  it("says what to write in the file where an environment's removal asks for --accept-automation, which neither env tool takes", async () => {
    const fires =
      'refused (AUTOMATION_NOT_ACCEPTED): SB runs automation on the records this removal ' +
      'deletes: Account: Apex trigger AccountCleanup (before delete). Nothing was deleted. Add ' +
      '--accept-automation to remove all the same, or turn that automation off in SB first.\n';
    const { run } = scripts(() => ({ code: 1, stderr: fires }));
    const c = client(run);
    await c.initialized();

    const destroyed = await c.call('env_destroy', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
    });
    const applied = await c.call('env_apply', {
      file: 'sandforge.yaml',
      org: 'SB',
      confirm: 'SB',
    });

    for (const [answered, tool] of [
      [destroyed, 'env_destroy'],
      [applied, 'env_apply'],
    ] as const) {
      expect(textOf(answered)).toContain(
        `--accept-automation, named above, is no parameter of ${tool}: an environment's ` +
          "acceptance of automation is its file's. Write accept: { automation: true } on the " +
          'resource whose run it names, in the file, once the person using you has accepted ' +
          `what fires, then call ${tool} again.`,
      );
      expect(textOf(answered)).not.toContain("is this tool's acceptAutomation");
    }
    await c.close();
  });

  it('answers a script that could not be started with why', async () => {
    const c = client(() => Promise.reject(new Error('spawn ENOENT')));
    await c.initialized();

    const result = await c.call('checkpoint_list', { org: 'DEV' });

    expect(result).toMatchObject({ isError: true, structuredContent: { exitCode: 1 } });
    expect(textOf(result)).toContain('sandforge checkpoint could not be started: spawn ENOENT');
    await c.close();
  });

  it('tells each script it runs that its lines are relayed, so that what a removal says takes what it kept is what this reader can run', async () => {
    // run_remove takes no sweep: relayed as they were, "--sweep takes them
    // first" and "(--sweep-untied takes them)" named flags of no tool.
    const inherited = process.execArgv;
    process.execArgv = ['--import', 'tsx'];
    try {
      const run = toolRunner({ scriptPath: () => join(__dirname, 'testing', 'stopProbe.ts') });
      const ran = await run('sandforge-clone', ['exit'], new AbortController().signal);

      expect(JSON.parse(ran.stdout)).toMatchObject({ relayedBy: 'sandforge mcp' });
    } finally {
      process.execArgv = inherited;
    }
  }, 120_000);
});

describe('sandforge-mcp: emptying objects or an org', () => {
  it('runs the dry run with no confirm, the objects named or the whole org with its options, and the acceptances it would be run with', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('empty_preview', { org: 'DEV', objects: ['Contact', 'Case'] });
    await c.call('empty_preview', {
      org: 'DEV',
      wholeOrg: true,
      excluded: ['Lead'],
      files: true,
      hardDelete: true,
      acceptNoUndo: true,
      acceptAutomation: true,
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-empty',
        args: ['--target', 'DEV', '--objects', 'Contact,Case', '--dry-run', '--json'],
      },
      {
        script: 'sandforge-empty',
        args: [
          '--target',
          'DEV',
          '--org',
          '--exclude-object',
          'Lead',
          '--files',
          '--hard-delete',
          '--accept-no-undo',
          '--accept-automation',
          '--dry-run',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('runs a confirmed emptying, its resume and its undo with --yes, and refuses each without confirm', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    for (const [tool, args] of [
      ['empty_run', { org: 'DEV', objects: ['Contact'] }],
      ['empty_run', { org: 'DEV', resume: 'em-20261113-101500-ab12' }],
      ['empty_undo', { org: 'DEV', run: 'em-20261113-101500-ab12' }],
    ] as const) {
      const refused = await c.call(tool, args);
      expect(refused.structuredContent, tool).toMatchObject({ refusal: { code: 'CONFIRM' } });
    }
    expect(ran).toEqual([]);

    await c.call('empty_run', {
      org: 'DEV',
      objects: ['Contact'],
      checkpointFirst: true,
      muteAutomation: true,
      confirm: 'DEV',
    });
    await c.call('empty_run', { org: 'DEV', resume: 'em-20261113-101500-ab12', confirm: 'DEV' });
    await c.call('empty_undo', {
      org: 'DEV',
      run: 'em-20261113-101500-ab12',
      acceptEmails: true,
      confirm: 'DEV',
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-empty',
        args: [
          '--target',
          'DEV',
          '--objects',
          'Contact',
          '--checkpoint-first',
          '--mute-automation',
          '--yes',
          '--json',
        ],
      },
      {
        script: 'sandforge-empty',
        args: ['--target', 'DEV', '--resume', 'em-20261113-101500-ab12', '--yes', '--json'],
      },
      {
        script: 'sandforge-empty',
        args: [
          '--target',
          'DEV',
          '--undo',
          'em-20261113-101500-ab12',
          '--accept-emails',
          '--yes',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('passes the acceptance of the people at work to a dry run, a run and a resume, and never to an undo', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('empty_preview', { org: 'DEV', objects: ['Contact'], acceptPeopleActive: true });
    await c.call('empty_run', {
      org: 'DEV',
      objects: ['Contact'],
      acceptPeopleActive: true,
      confirm: 'DEV',
    });
    await c.call('empty_run', {
      org: 'DEV',
      resume: 'em-20261113-101500-ab12',
      acceptPeopleActive: true,
      confirm: 'DEV',
    });
    const undo = await c.call('empty_undo', {
      org: 'DEV',
      run: 'em-20261113-101500-ab12',
      acceptPeopleActive: true,
      confirm: 'DEV',
    });

    expect(ran.map((each) => each.args)).toEqual([
      ['--target', 'DEV', '--objects', 'Contact', '--accept-people-active', '--dry-run', '--json'],
      ['--target', 'DEV', '--objects', 'Contact', '--accept-people-active', '--yes', '--json'],
      [
        '--target',
        'DEV',
        '--resume',
        'em-20261113-101500-ab12',
        '--accept-people-active',
        '--yes',
        '--json',
      ],
    ]);
    expect(undo.isError).toBe(true);
    await c.close();
  });

  it('refuses, before any script runs, both objects and the whole org, neither, and a run that is no emptying’s', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();

    for (const [tool, args] of [
      ['empty_preview', { org: 'DEV' }],
      ['empty_preview', { org: 'DEV', objects: ['Contact'], wholeOrg: true }],
      [
        'empty_run',
        { org: 'DEV', objects: ['Contact'], resume: 'em-20261113-101500-ab12', confirm: 'DEV' },
      ],
      ['empty_undo', { org: 'DEV', run: 'latest', confirm: 'DEV' }],
      ['empty_preview', { org: 'DEV', objects: ['Contact,Case'] }],
    ] as const) {
      const result = await c.call(tool, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(ran).toEqual([]);
    await c.close();
  });

  it('names the parameter a flag of its lines stands for, and the undo a run offers', async () => {
    const { run } = scripts(() => ({
      code: 0,
      stdout: JSON.stringify({
        result: { runId: 'em-20261113-101500-ab12', status: 'success', undo: { offered: true } },
      }),
      stderr:
        'sandforge-empty --target DEV --undo em-20261113-101500-ab12 --yes brings them back\n',
    }));
    const c = client(run);
    await c.initialized();

    const ran = await c.call('empty_run', { org: 'DEV', objects: ['Contact'], confirm: 'DEV' });
    expect(textOf(ran)).toContain('--undo, named above, is empty_undo');
    expect(textOf(ran)).toContain(
      'empty_undo with run "em-20261113-101500-ab12" brings back what it deleted',
    );

    const { run: refusing } = scripts(() => ({
      code: 1,
      stdout: JSON.stringify({ refused: { code: 'NO_UNDO' } }),
      stderr: 'refused (NO_UNDO): … (--accept-no-undo accepts it)\n',
    }));
    const d = client(refusing);
    await d.initialized();
    const refused = await d.call('empty_preview', { org: 'DEV', objects: ['Account', 'Case'] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("--accept-no-undo, named above, is this tool's acceptNoUndo");
    expect(textOf(refused)).not.toContain('empty_undo with run');
    await c.close();
    await d.close();
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
      structuredContent: { exitCode: 0, answer: [], replays: [] },
    });
    // Asked of DEV, over a store that keeps none: of DEV, where another may be kept.
    expect(textOf(list.result as unknown as CallResult)).toContain(
      'No checkpoint of DEV is kept in',
    );
    expect(textOf(list.result as unknown as CallResult)).toContain('One kept in another folder');
    expect(textOf(list.result as unknown as CallResult)).toContain(
      'No replay into DEV is kept on this machine.',
    );
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    // Its own lines, and the script's, on stderr.
    expect(stderr).toContain('sandforge mcp: 24 tools on stdio');
    expect(stderr).toContain('No checkpoint of DEV is kept in');
  }, 60_000);
});

describe('sandforge-mcp: a seed fitted to the storage', () => {
  it('hands fit and its bound to the seed’s line, a dry run as a write', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-sales-cloud-starter',
      dryRun: true,
      fit: 'share',
      fitWithinMB: 2.5,
    });
    await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-sales-cloud-starter',
      dryRun: false,
      fit: 'share',
      confirm: 'DEV',
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-seed',
        args: [
          '--target',
          'DEV',
          '--template',
          'prebuilt-sales-cloud-starter',
          '--dry-run',
          '--fit',
          'share',
          '--fit-within',
          '2.5',
          '--json',
        ],
      },
      {
        script: 'sandforge-seed',
        args: [
          '--target',
          'DEV',
          '--template',
          'prebuilt-sales-cloud-starter',
          '--fit',
          'share',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('refuses a bound with no fit, and a fit that is not by share, before any script runs', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();

    const refusals = [
      await c.call('seed_run', {
        org: 'DEV',
        template: 'prebuilt-sales-cloud-starter',
        dryRun: true,
        fitWithinMB: 2,
      }),
      await c.call('seed_run', {
        org: 'DEV',
        template: 'prebuilt-sales-cloud-starter',
        dryRun: true,
        fit: 'caps',
      }),
      await c.call('seed_run', {
        org: 'DEV',
        template: 'prebuilt-sales-cloud-starter',
        dryRun: true,
        fit: 'share',
        fitWithinMB: 0,
      }),
    ];

    for (const result of refusals) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    }
    expect(textOf(refusals[0] as CallResult)).toContain('fitWithinMB goes with fit: "share"');
    expect(ran).toEqual([]);
    await c.close();
  });
});

describe('sandforge-mcp: a checkpoint before a run', () => {
  const CHECKPOINT = 'ck-20261101-110000-c3d4';

  it('hands checkpointFirst, its days and what it leaves out to the line of a seed and of a clone, a dry run as a write', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: true,
      checkpointFirst: {},
    });
    await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: false,
      confirm: 'DEV',
      checkpointFirst: { keepDays: 0, excluded: ['Task', 'Event'] },
    });
    await c.call('clone_record', {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
      checkpointFirst: { keepDays: 30 },
    });

    expect(ran.map(({ args }) => args.slice(args.indexOf('--checkpoint-first')))).toEqual([
      ['--checkpoint-first', '--json'],
      [
        '--checkpoint-first',
        '--checkpoint-keep-days',
        '0',
        '--checkpoint-exclude-object',
        'Task',
        '--checkpoint-exclude-object',
        'Event',
        '--json',
      ],
      ['--checkpoint-first', '--checkpoint-keep-days', '30', '--json'],
    ]);
    await c.close();
  });

  it('leaves the option off the line unless it is asked', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('seed_run', { org: 'DEV', template: 'prebuilt-crm-starter', dryRun: true });

    expect(ran[0]?.args.join(' ')).not.toContain('--checkpoint');
    await c.close();
  });

  it('refuses days past what a checkpoint is kept, a name that is no object, and any other key, before any script runs', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();
    const seed = { org: 'DEV', template: 'prebuilt-crm-starter', dryRun: true };

    const refusals = [
      await c.call('seed_run', { ...seed, checkpointFirst: { keepDays: 3651 } }),
      await c.call('seed_run', { ...seed, checkpointFirst: { keepDays: 1.5 } }),
      await c.call('seed_run', { ...seed, checkpointFirst: { excluded: ['--dry-run'] } }),
      await c.call('seed_run', { ...seed, checkpointFirst: { excluded: [] } }),
      await c.call('seed_run', { ...seed, checkpointFirst: { keep: 3 } }),
      await c.call('seed_run', { ...seed, checkpointFirst: true }),
    ];

    for (const result of refusals) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    }
    expect(ran).toEqual([]);
    await c.close();
  });

  it('says how to rewind to the checkpoint a run kept, from its answer, and of no other', async () => {
    const answers: Array<Record<string, unknown>> = [
      { checkpoint: { state: 'taken', checkpointId: CHECKPOINT } },
      { checkpoint: { state: 'deleted', deleted: 'nothingWritten' } },
      {},
    ];
    const { run } = scripts(() => ({ stdout: JSON.stringify(answers.shift()) }));
    const c = client(run);
    await c.initialized();
    const clone = {
      source: 'SRC',
      target: 'SB',
      recordId: '001000000000001AAA',
      dryRun: false,
      confirm: 'SB',
    };

    const kept = await c.call('clone_record', clone);
    const deleted = await c.call('clone_record', clone);
    const none = await c.call('clone_record', clone);

    expect(textOf(kept)).toContain(`checkpoint_rewind with checkpoint "${CHECKPOINT}" returns`);
    expect(textOf(deleted)).not.toContain('checkpoint_rewind with');
    expect(textOf(none)).not.toContain('checkpoint_rewind with');
    await c.close();
  });

  it('says nothing of a rewind after a seed’s dry run, which took no checkpoint', async () => {
    const { run } = scripts(() => ({
      stdout: JSON.stringify({ checkpoint: { state: 'planned' } }),
    }));
    const c = client(run);
    await c.initialized();

    const dry = await c.call('seed_run', {
      org: 'DEV',
      template: 'prebuilt-crm-starter',
      dryRun: true,
      checkpointFirst: {},
    });

    expect(textOf(dry)).not.toContain('checkpoint_rewind with');
    await c.close();
  });
});

describe('sandforge-mcp: what the tools reach', () => {
  it('takes a checkpoint under the limit asked, as --max-total, up to a million records', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('checkpoint_take', { org: 'DEV', estimate: true, maxTotal: 750_000 });
    for (const maxTotal of [0, 1_000_001, 1.5]) {
      const refused = await c.call('checkpoint_take', { org: 'DEV', maxTotal });
      expect(refused.isError, String(maxTotal)).toBe(true);
    }

    expect(ran).toEqual([
      {
        script: 'sandforge-checkpoint',
        args: ['take', '--org', 'DEV', '--max-total', '750000', '--estimate', '--json'],
      },
    ]);
    await c.close();
  });

  it('tells the model what no tool does — a clone of tables, Compare, Backup — and the command that does it', async () => {
    const c = client();
    const answer = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const said = String(answer.result?.instructions);

    for (const command of [
      'pnpm exec tsx packages/extension/cli/sandforge-clone.ts --object',
      'pnpm exec tsx packages/extension/cli/sandforge-compare.ts',
      'pnpm exec tsx packages/extension/cli/sandforge-backup.ts',
    ]) {
      expect(said).toContain(command);
    }
    expect(said).toContain('sandforge.yaml');
    await c.close();
  });

  it('tells the model how a clone of the whole org goes — a plan, its question to show, then the run of that plan — and that a long call hands back a run', async () => {
    // It said "No tool clones the whole org", and sent the person to a
    // terminal for a dry run and a --yes.
    const c = client();
    const answer = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const said = String(answer.result?.instructions);

    expect(said).not.toContain('No tool clones the whole org');
    expect(said).not.toContain('--depth all --fit share');
    expect(said).toContain(
      'clone_org_plan, show the person the question its plan comes back with, then clone_org ' +
        'with that plan and confirm; its personal fields are always anonymized.',
    );
    expect(said).toContain(
      'A call still running after 45 seconds hands back a run: run_status follows it, run_stop ' +
        'stops it.',
    );
    // What the package rewrites (scripts/npm-package.mjs, REWRITES).
    expect(INSTRUCTIONS).toContain('run from a checkout of its repository. ');
    await c.close();
  });
});

describe('sandforge-mcp: the records a query chooses (clone_records)', () => {
  const clone = { source: 'SRC', target: 'SB' };

  it('clones the records its object, where, orderBy and limit choose as one query, or the ids it names, the most a run takes their limit or count', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('clone_records', {
      ...clone,
      object: 'Account',
      where: "Industry = 'Energy'",
      orderBy: 'CreatedDate DESC',
      limit: 50,
      depth: 'direct',
      maxReadTotal: 20_000,
      dryRun: true,
    });
    await c.call('clone_records', {
      ...clone,
      recordIds: ['001000000000001AAA', '001000000000002AAA', '001000000000003AAA'],
      dryRun: false,
      confirm: 'SB',
      muteAutomation: true,
      checkpointFirst: {},
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-clone',
        args: [
          '--query',
          "SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY CreatedDate DESC LIMIT 50",
          '--max-roots',
          '50',
          '--source',
          'SRC',
          '--target',
          'SB',
          '--depth',
          'direct',
          '--max-read-total',
          '20000',
          '--dry-run',
          '--json',
        ],
      },
      {
        script: 'sandforge-clone',
        args: [
          '--record',
          '001000000000001AAA',
          '--record',
          '001000000000002AAA',
          '--record',
          '001000000000003AAA',
          '--max-roots',
          '3',
          '--source',
          'SRC',
          '--target',
          'SB',
          '--mute-automation',
          '--checkpoint-first',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('refuses, before any script runs, a query and ids both or neither, a query without its limit, ids of two objects, and a query the clone would refuse, in its words', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();

    const refusals = {
      both: await c.call('clone_records', {
        ...clone,
        object: 'Account',
        limit: 5,
        recordIds: ['001000000000001AAA', '001000000000002AAA'],
        dryRun: true,
      }),
      neither: await c.call('clone_records', { ...clone, dryRun: true }),
      noLimit: await c.call('clone_records', { ...clone, object: 'Account', dryRun: true }),
      pastTheMost: await c.call('clone_records', {
        ...clone,
        object: 'Account',
        limit: 2001,
        dryRun: true,
      }),
      oneId: await c.call('clone_records', {
        ...clone,
        recordIds: ['001000000000001AAA'],
        dryRun: true,
      }),
      twoObjects: await c.call('clone_records', {
        ...clone,
        recordIds: ['001000000000001AAA', '003000000000001AAA'],
        dryRun: true,
      }),
      whereOfIds: await c.call('clone_records', {
        ...clone,
        recordIds: ['001000000000001AAA', '001000000000002AAA'],
        where: "Name = 'x'",
        dryRun: true,
      }),
      comment: await c.call('clone_records', {
        ...clone,
        object: 'Account',
        where: "Name = 'x' -- y",
        limit: 5,
        dryRun: true,
      }),
      grouped: await c.call('clone_records', {
        ...clone,
        object: 'Account',
        where: "Name = 'x' GROUP BY Name",
        limit: 5,
        dryRun: true,
      }),
      orderedByAFunction: await c.call('clone_records', {
        ...clone,
        object: 'Account',
        orderBy: 'COUNT(Id)',
        limit: 5,
        dryRun: true,
      }),
    };

    for (const [name, result] of Object.entries(refusals)) {
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
      expect(textOf(result), name).toContain('Nothing was run.');
    }
    expect(textOf(refusals.both)).toContain('give object, with limit,');
    expect(textOf(refusals.noLimit)).toContain('limit goes with object');
    expect(textOf(refusals.twoObjects)).toContain('the records of one object: these are of 2');
    expect(textOf(refusals.whereOfIds)).toContain('where goes with object');
    expect(textOf(refusals.grouped)).toContain(
      'where: The query’s GROUP BY changes the records it returns',
    );
    expect(textOf(refusals.grouped)).toContain('(ROOTS_QUERY_REFUSED)');
    expect(ran).toEqual([]);
    await c.close();
  });

  it('reads the refusal the clone said on a line of its own, exit 2 and no JSON, as its code and its words, and names the parameters that make the query', async () => {
    const said = refusedLine({
      code: 'ROOTS_QUERY_REFUSED',
      message:
        'The query’s OFFSET changes the records it returns, and the clone would read others ' +
        'than it shows: take it out. Nothing was read or written.',
    });
    const { run } = scripts(() => ({ code: 2, stderr: `${said}\n` }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('clone_records', {
      ...clone,
      object: 'Account',
      limit: 5,
      dryRun: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      exitCode: 2,
      refused: {
        code: 'ROOTS_QUERY_REFUSED',
        message:
          'The query’s OFFSET changes the records it returns, and the clone would read others ' +
          'than it shows: take it out. Nothing was read or written.',
      },
    });
    expect(textOf(result)).toContain(
      'exit 2: the clone refused what it was asked before any org was reached',
    );
    expect(textOf(result)).toContain('change the parameter it names, then dryRun: true again');
    await c.close();
  });

  it('answers a refusal of its volume with the limit and the orderBy that take as many records as fit, the query the clone names being made of them', async () => {
    // What the clone says, relayed by this server: its own --query, which no
    // parameter of this tool is. The call's limit and orderBy make it.
    const relayed = process.env[RELAYED_BY_VARIABLE];
    process.env[RELAYED_BY_VARIABLE] = 'sandforge mcp';
    let overStorage: string;
    let overTotal: string;
    try {
      const roots = {
        objectApiName: 'Account',
        count: 41,
        query: { where: "Industry = 'Energy'", limit: 41 },
        fits: 3,
      };
      overStorage =
        rootsStorageRefusal(
          { verdict: 'exceeds', estimateMB: 13, remainingMB: 5, maxMB: 5 },
          'SB',
          { ...roots, each: 'about 0.32 MB', past: 'what SB has left' },
        ) ?? '';
      overTotal = rootsMaxTotalRefusal(
        1_320,
        100,
        {
          ...roots,
          query: { ...roots.query, orderBy: 'Name ASC' },
          each: 'about 33 records',
          past: 'the 100 --max-total holds the run to',
        },
        true,
      );
    } finally {
      if (relayed === undefined) delete process.env[RELAYED_BY_VARIABLE];
      else process.env[RELAYED_BY_VARIABLE] = relayed;
    }
    const answered = (message: string, code: string) => () => ({
      code: 1,
      stdout: JSON.stringify({ dryRun: true, refusals: [{ code, message }] }),
      stderr: `  a real run would be refused (${code}): ${message}\n`,
    });
    const call = async (message: string, code: string, orderBy?: string) => {
      const c = client(scripts(answered(message, code)).run);
      await c.initialized();
      const result = await c.call('clone_records', {
        source: 'SRC',
        target: 'SB',
        object: 'Account',
        where: "Industry = 'Energy'",
        ...(orderBy !== undefined ? { orderBy } : {}),
        limit: 41,
        dryRun: true,
      });
      await c.close();
      return textOf(result);
    };

    const storage = await call(overStorage, 'STORAGE_EXCEEDED');
    const total = await call(overTotal, 'MAX_TOTAL_EXCEEDED', 'Name ASC');

    // Relayed as the clone said it, then read for this tool.
    expect(storage).toContain(
      `this script's own --query "SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY ` +
        `CreatedDate DESC, Id DESC LIMIT 3"`,
    );
    expect(storage).toContain(
      '--query, named above, is this call with limit: 3 and orderBy: "CreatedDate DESC, Id ' +
        'DESC", its object and where as they were: dryRun: true first.',
    );
    expect(total).toContain(
      '--query, named above, is this call with limit: 3 and orderBy: "Name ASC", its object ' +
        'and where as they were: dryRun: true first.',
    );
  });

  it('says how to take a run back, and names the parameter each flag of its lines stands for', async () => {
    const { run } = scripts(() => ({
      code: 1,
      stdout: '',
      stderr:
        'refused (READ_BOUND_EXCEEDED): 61,000 records to read, past --max-read-total 50000\n' +
        'refused (ROOTS_EXCEEDED): give --max-roots 300\n',
    }));
    const c = client(run);
    await c.initialized();
    const refused = await c.call('clone_records', {
      ...clone,
      object: 'Account',
      limit: 5,
      dryRun: true,
    });
    await c.close();

    const done = scripts(() => ({
      stdout: JSON.stringify({ journal: '/j/forge-runs/fr-1.ndjson' }),
    }));
    const d = client(done.run);
    await d.initialized();
    const wrote = await d.call('clone_records', {
      ...clone,
      object: 'Account',
      limit: 5,
      dryRun: false,
      confirm: 'SB',
    });
    const dry = await d.call('clone_records', {
      ...clone,
      object: 'Account',
      limit: 5,
      dryRun: true,
    });

    expect(textOf(refused)).toContain(
      "--max-read-total, named above, is this tool's maxReadTotal.",
    );
    expect(textOf(refused)).toContain("--max-roots, named above, is this tool's limit");
    expect(refused.structuredContent.refused).toMatchObject({ code: 'READ_BOUND_EXCEEDED' });
    expect(textOf(wrote)).toContain(
      'run_remove with module "forge" and run "/j/forge-runs/fr-1.ndjson" takes this run back.',
    );
    expect(textOf(dry)).not.toContain('run_remove with');
    await d.close();
  });

  it('gives the terminal line that sets a field only the target requires, a value no parameter of this tool gives, as its dry run names it', async () => {
    // Run for real, a dry run said every account would be refused for a
    // field only the target requires, and the call had no way to give it.
    const targetGaps = {
      gaps: [
        {
          kind: 'required_field_missing',
          severity: 'blocking',
          objectApiName: 'Account',
          field: 'Region__c',
          detail: { type: 'string', reason: 'notInSource' },
        },
        {
          kind: 'required_field_missing',
          severity: 'blocking',
          objectApiName: 'Contact',
          field: 'Code__c',
          answeredBy: 'default "C-1"',
        },
        { kind: 'validation_rule', severity: 'warning', objectApiName: 'Contact', field: 'Email' },
      ],
    };
    const { run } = scripts(() => ({ stdout: JSON.stringify({ dryRun: true, targetGaps }) }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('clone_records', {
      ...clone,
      object: 'Account',
      limit: 3,
      dryRun: true,
    });
    await c.close();

    const text = textOf(result);
    expect(text).toContain(
      'Account.Region__c is a field SB requires that the clone does not write: a real run sees ' +
        'every record of Account refused, and no parameter of this tool gives it a value.',
    );
    expect(text).toContain(
      '{"defaultValues":[{"object":"Account","field":"Region__c","value":"…"}]}',
    );
    expect(text).toContain(
      `${commandOf('clone')} --query 'SELECT Id FROM Account LIMIT 3' --max-roots 3 --source ` +
        'SRC --target SB --dry-run --config <file.json>',
    );
    // A field a decision answers needs nothing.
    expect(text).not.toContain('Contact.Code__c');
  });
});

describe('sandforge-mcp: the draw of a sample of the whole org', () => {
  it('hands the oldest roots, a window of dates, the conditions of the roots and the strata to the dry run’s line', () => {
    const line = cloneOrgPlanLine({
      source: 'SRC',
      target: 'TGT',
      fit: 'share',
      fitDraw: 'oldest',
      fitWindow: { field: 'created', from: '2025-01-01', to: '2025-06-30T12:00:00Z' },
      fitWhere: [
        { objectApiName: 'Account', where: "BillingCountry = 'France'" },
        { objectApiName: 'Case', where: "Status = 'New'" },
      ],
      fitStrata: ['RecordTypeId', 'Case.Priority'],
    });
    const lastDays = cloneOrgPlanLine({
      source: 'SRC',
      target: 'TGT',
      fit: 'share',
      fitWindow: { field: 'modified', lastDays: 30 },
    });
    const openEnded = cloneOrgPlanLine({
      source: 'SRC',
      target: 'TGT',
      fit: 'share',
      fitWindow: { field: 'created', to: '2024-12-31' },
    });

    expect(line.slice(line.indexOf('--fit-draw'), line.indexOf('--anonymize'))).toEqual([
      '--fit-draw',
      'oldest',
      '--fit-window',
      'created:2025-01-01..2025-06-30T12:00:00Z',
      '--fit-where',
      "Account=BillingCountry = 'France'",
      '--fit-where',
      "Case=Status = 'New'",
      '--fit-strata',
      'RecordTypeId',
      '--fit-strata',
      'Case.Priority',
    ]);
    expect(lastDays).toContain('modified:30d');
    expect(openEnded).toContain('created:..2024-12-31');
  });

  it('refuses, before any script runs, a window with both bounds and days or neither, one that ends before it starts, a date the calendar has not, a condition with a comment, two strata of one object, and any of them without fit', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();
    const plan = { source: 'SRC', target: 'TGT', fit: 'share' };

    const refusals = [
      await c.call('clone_org_plan', {
        ...plan,
        fitWindow: { field: 'created', from: '2025-01-01', lastDays: 30 },
      }),
      await c.call('clone_org_plan', { ...plan, fitWindow: { field: 'created' } }),
      await c.call('clone_org_plan', {
        ...plan,
        fitWindow: { field: 'created', from: '2025-07-01', to: '2025-06-30' },
      }),
      await c.call('clone_org_plan', {
        ...plan,
        fitWindow: { field: 'created', from: '2025-02-30' },
      }),
      await c.call('clone_org_plan', {
        ...plan,
        fitWindow: { field: 'CreatedDate', lastDays: 3 },
      }),
      await c.call('clone_org_plan', {
        ...plan,
        fitWhere: [{ objectApiName: 'Account', where: "Name = 'x' /* y */" }],
      }),
      await c.call('clone_org_plan', { ...plan, fitStrata: ['Account.Type', 'Account.Rating'] }),
      await c.call('clone_org_plan', { ...plan, fitStrata: ['--fit-whole'] }),
      await c.call('clone_org_plan', { ...plan, fitDraw: 'newest' }),
      await c.call('clone_org_plan', {
        source: 'SRC',
        target: 'TGT',
        fitStrata: ['RecordTypeId'],
      }),
    ];

    for (const result of refusals) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    }
    expect(textOf(refusals[0] as CallResult)).toContain(
      'a window gives from, to or both, or lastDays',
    );
    expect(textOf(refusals[2] as CallResult)).toContain('a window starts before it ends');
    expect(textOf(refusals[6] as CallResult)).toContain(
      'the roots of Account are stratified by one field at most',
    );
    expect(textOf(refusals[9] as CallResult)).toContain('the fit* parameters go with fit: "share"');
    expect(ran).toEqual([]);
    await c.close();
  });

  it('names the parameter of each flag of the draw a refusal names, and says a draw refused for what it was asked keeps no plan', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-draw-'));
    try {
      const invalid = {
        refused: {
          code: 'SAMPLE_DRAW_INVALID',
          message:
            'The source refuses the condition --fit-where gives Account, and Case has no field ' +
            'Priority__c that --fit-strata names; --fit-window reads CreatedDate.',
        },
      };
      const { run } = scripts(() => ({
        code: 2,
        stdout: JSON.stringify(invalid),
        stderr: `refused (SAMPLE_DRAW_INVALID): ${invalid.refused.message}\n`,
      }));
      const c = client(run, { journalDir });
      await c.initialized();

      const result = await c.call('clone_org_plan', {
        source: 'SRC',
        target: 'TGT',
        fit: 'share',
        fitWhere: [{ objectApiName: 'Account', where: "Name = 'x'" }],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'exit 2: refused for what it was asked, before any record was drawn',
      );
      expect(textOf(result)).toContain(
        "--fit-where, named above, is this tool's fitWhere, an objectApiName and the where its roots match.",
      );
      expect(textOf(result)).toContain("--fit-strata, named above, is this tool's fitStrata");
      expect(textOf(result)).toContain("--fit-window, named above, is this tool's fitWindow");
      expect(result.structuredContent).toMatchObject({ exitCode: 2, answer: invalid });
      expect(result.structuredContent.plan).toBeUndefined();
      await c.close();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  it('says how the roots of a plan were drawn, and carries what the dry run said of them', () => {
    const receipt: ClonePlanReceipt = {
      version: 1,
      id: 'co-20261115-101500-ab12',
      createdAt: '2026-11-15T10:15:00.000Z',
      expiresAt: '2026-11-16T10:15:00.000Z',
      source: 'SRC',
      target: 'TGT',
      args: [],
      mode: 'sample',
      totalRows: 120,
      accepted: [],
      runs: [],
    };
    const roots = {
      window: { field: 'CreatedDate', from: '2025-01-01T00:00:00Z' },
      strata: [{ objectApiName: 'Account', field: 'RecordTypeId', values: [] }],
    };
    const drawn = planSummaryOf(receipt, {
      wholeOrg: {
        wouldInsert: [{}, {}],
        sample: { share: 0.25, seed: 1, draw: 'oldest', budget: { limitedBy: 'draw' }, roots },
      },
    });
    const uniform = planSummaryOf(receipt, {
      wholeOrg: { wouldInsert: [{}], sample: { share: 0.5, seed: 1, draw: 'uniform' } },
    });

    expect(drawn.sample).toEqual({
      share: 0.25,
      seed: 1,
      draw: 'oldest',
      limitedBy: 'draw',
      roots,
    });
    expect(planLines(drawn)[0]).toContain(
      "a sample of SRC, 25 % of each object's roots, its roots drawn oldest first, within a " +
        'window of their dates, by strata (plan.sample.roots says how), held by draw,',
    );
    expect(planLines(uniform)[0]).toContain("50 % of each object's roots, every personal field");
    expect(uniform.sample?.roots).toBeUndefined();
  });
});

describe('sandforge-mcp: a checkpoint replayed into another org', () => {
  const CHECKPOINT = 'ck-20261101-110000-c3d4';

  it('runs the dry run of a replay with its choices, the replay with the count its dry run said and --yes once confirmed, and its verification with neither', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('checkpoint_replay', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      dryRun: true,
      objects: ['Account', 'Contact'],
      excludedObjects: ['Task'],
      owners: 'me',
      customSettings: true,
      mask: true,
      acceptEmails: true,
      checkpointFirst: { keepDays: 3 },
    });
    await c.call('checkpoint_replay', {
      checkpoint: 'Before UAT',
      from: '00D000000000001AAA',
      target: 'SB',
      dryRun: false,
      maxRecords: 412,
      confirm: 'SB',
      again: true,
      muteAutomation: true,
      acceptAutomation: true,
    });
    await c.call('checkpoint_replay', { checkpoint: CHECKPOINT, target: 'SB', verify: true });

    expect(ran).toEqual([
      {
        script: 'sandforge-checkpoint',
        args: [
          'replay',
          '--checkpoint',
          CHECKPOINT,
          '--target',
          'SB',
          '--dry-run',
          '--objects',
          'Account,Contact',
          '--exclude-object',
          'Task',
          '--owners',
          'me',
          '--custom-settings',
          '--mask',
          '--accept-emails',
          '--checkpoint-first',
          '--checkpoint-keep-days',
          '3',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: [
          'replay',
          '--checkpoint',
          'Before UAT',
          '--from',
          '00D000000000001AAA',
          '--target',
          'SB',
          '--again',
          '--mute-automation',
          '--accept-automation',
          '--max-records',
          '412',
          '--yes',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: ['replay', '--checkpoint', CHECKPOINT, '--target', 'SB', '--verify', '--json'],
      },
    ]);
    await c.close();
  });

  it('replays a file a teammate sent with its key read from the variable keyEnv names, and refuses a key given as an argument without repeating it', async () => {
    // A key as an export shows it, and the same with its dashes left out.
    const key = archiveKeyText(Buffer.alloc(32, 7));
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('checkpoint_replay', {
      file: '/shared/recette.sfcheckpoint',
      keyEnv: 'D8_KEY',
      target: 'SB',
      dryRun: true,
    });
    const refusals = {
      asAnArgument: await c.call('checkpoint_replay', {
        file: '/shared/recette.sfcheckpoint',
        key,
        target: 'SB',
        dryRun: true,
      }),
      asItsName: await c.call('checkpoint_replay', {
        file: '/shared/recette.sfcheckpoint',
        keyEnv: key.replace(/-/g, ''),
        target: 'SB',
        dryRun: true,
      }),
      noVariable: await c.call('checkpoint_replay', {
        file: '/shared/recette.sfcheckpoint',
        target: 'SB',
        dryRun: true,
      }),
      kept: await c.call('checkpoint_replay', {
        checkpoint: CHECKPOINT,
        keyEnv: 'D8_KEY',
        target: 'SB',
        dryRun: true,
      }),
      both: await c.call('checkpoint_replay', {
        checkpoint: CHECKPOINT,
        file: '/shared/recette.sfcheckpoint',
        keyEnv: 'D8_KEY',
        target: 'SB',
        dryRun: true,
      }),
    };

    expect(ran).toEqual([
      {
        script: 'sandforge-checkpoint',
        args: [
          'replay',
          '--file',
          '/shared/recette.sfcheckpoint',
          '--key-env',
          'D8_KEY',
          '--target',
          'SB',
          '--dry-run',
          '--json',
        ],
      },
    ]);
    for (const [name, result] of Object.entries(refusals)) {
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
      expect(JSON.stringify(result), name).not.toContain(key);
      expect(JSON.stringify(result), name).not.toContain(key.replace(/-/g, ''));
    }
    expect(textOf(refusals.asAnArgument)).toContain('checkpoint_replay takes no key (key)');
    expect(textOf(refusals.asItsName)).toContain(
      'the name of the variable that holds the key, never the key',
    );
    expect(textOf(refusals.noVariable)).toContain('a file goes with keyEnv');
    expect(textOf(refusals.kept)).toContain('keyEnv goes with file');
    await c.close();
  });

  it('refuses, before any script runs, a replay that writes without the count of its dry run, a dry run and a verification both or neither, a verification given choices, and a checkpoint named without its org', async () => {
    const { ran, run } = scripts();
    const c = client(run);
    await c.initialized();
    const replay = { checkpoint: CHECKPOINT, target: 'SB' };

    const refusals = {
      noCount: await c.call('checkpoint_replay', { ...replay, dryRun: false, confirm: 'SB' }),
      countOfADryRun: await c.call('checkpoint_replay', { ...replay, dryRun: true, maxRecords: 3 }),
      neither: await c.call('checkpoint_replay', replay),
      both: await c.call('checkpoint_replay', { ...replay, dryRun: true, verify: true }),
      verifyWithChoices: await c.call('checkpoint_replay', {
        ...replay,
        verify: true,
        mask: true,
      }),
      named: await c.call('checkpoint_replay', {
        checkpoint: 'Before UAT',
        target: 'SB',
        dryRun: true,
      }),
      noRealData: await c.call('checkpoint_replay', { ...replay, dryRun: true, noRealData: true }),
      removalNamed: await c.call('checkpoint_replay_remove', {
        checkpoint: 'latest',
        target: 'SB',
        preview: true,
      }),
    };

    for (const [name, result] of Object.entries(refusals)) {
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    }
    expect(textOf(refusals.noCount)).toContain(
      'maxRecords: a replay that writes takes maxRecords, the count its dry run said',
    );
    expect(textOf(refusals.verifyWithChoices)).toContain(
      'mask goes with a replay or its dry run: verify reads the choices',
    );
    expect(textOf(refusals.named)).toContain('"Before UAT" is not a checkpoint\'s id');
    expect(textOf(refusals.removalNamed)).toContain('"latest" is not a checkpoint\'s id');
    expect(ran).toEqual([]);
    await c.close();
  });

  it('says after a dry run the replay that writes, with the count it said, and names the parameter of each flag its lines name', async () => {
    const dry = {
      command: 'replay',
      dryRun: true,
      plan: { perObject: [{ toInsert: 400 }, { toInsert: 12 }] },
      removeWith: `sandforge checkpoint replay --checkpoint ${CHECKPOINT} --target SB --remove`,
    };
    const realData =
      'refused (REPLAY_COPY_UNKNOWN): this sandbox checkpoint was taken before SandForge 1.81: ' +
      'replay it masked (--mask), or declare it holds no real data (--no-real-data).\n';
    let next: Partial<CommandRun> = { stdout: JSON.stringify(dry) };
    const { run } = scripts(() => next);
    const c = client(run);
    await c.initialized();

    const planned = await c.call('checkpoint_replay', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      dryRun: true,
    });
    next = { code: 1, stderr: realData };
    const refused = await c.call('checkpoint_replay', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      dryRun: true,
    });

    expect(textOf(planned)).toContain(
      'checkpoint_replay with the same parameters, dryRun: false, maxRecords: 412 and confirm ' +
        '"SB" creates them, once the person using you has agreed to it',
    );
    expect(textOf(planned)).toContain('--remove, named above, is checkpoint_replay_remove');
    expect(textOf(refused)).toContain("--mask, named above, is this tool's mask: true.");
    expect(textOf(refused)).toContain(
      '--no-real-data, named above, is no parameter of any tool: the declaration that a ' +
        "sandbox's checkpoint holds no real data is the person's, on a terminal",
    );
    expect(textOf(refused)).not.toContain('maxRecords: 412');
    await c.close();
  });

  it('gives the terminal line that declares the required fields a replay leaves empty, and names the parameters of the objects a refusal of its storage names', async () => {
    // Run for real, the replay said "Declare them all, then load again", and
    // no parameter of this tool declares one.
    const said =
      '! replay:load:preview:error: the checkpoint leaves 2 required field(s) empty that the ' +
      'configuration does not cover. Nothing was written. Declare them all, then load again — ' +
      'records are never silently excluded:\n' +
      '- requiredFieldDefaults["Account.Region__c"]: a string for this required field [LOAD_CONFIG]\n' +
      '- requiredLookupPlaceholders["Contact.Desk__c"]: a placeholder (name + ' +
      'recordTypeDeveloperName) for this required lookup to Desk__c [LOAD_CONFIG]\n' +
      'a replay would be refused (FROZEN_STORAGE_EXCEEDED): the checkpoint’s records take about ' +
      '13 MB of data storage, and SB has 5 MB left of 5 MB. To replay part of it, name the ' +
      'objects to replay (--objects A,B) or leave some out (--exclude-object X); or free data ' +
      'storage in SB. Nothing was written.\n';
    const { run } = scripts(() => ({ code: 1, stderr: said }));
    const c = client(run);
    await c.initialized();

    const refused = await c.call('checkpoint_replay', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      dryRun: true,
      objects: ['Account', 'Contact'],
      muteAutomation: true,
    });
    await c.close();

    const text = textOf(refused);
    expect(text).toContain("--objects, named above, is this tool's objects, by API name.");
    expect(text).toContain(
      "--exclude-object, named above, is this tool's excludedObjects, by API name.",
    );
    expect(text).toContain(
      'LOAD_CONFIG, named above, is no parameter of this tool: the values of the required fields ' +
        'it names are the person’s to declare',
    );
    expect(text).toContain(
      '{"requiredFieldDefaults":{"Account.Region__c":"…"},' +
        '"requiredLookupPlaceholders":{"Contact.Desk__c":{"name":"…"}}}',
    );
    expect(text).toContain(
      `${commandOf('checkpoint')} replay --checkpoint ${CHECKPOINT} --target SB --dry-run ` +
        '--objects Account,Contact --mute-automation --replay-config <file.json>',
    );
  });

  it('refuses the removal of a replay this server still runs into its target, naming its run, and previews it all the same', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-replay-'));
    const ran: string[][] = [];
    // The replay goes on until it is stopped, as one past its call's hold does.
    const run: CommandRunner = (_script, args, signal) => {
      ran.push([...args]);
      if (!args.includes('--max-records')) {
        return Promise.resolve({ code: 0, stdout: '{}', stderr: '' });
      }
      return new Promise((done) => {
        signal.addEventListener('abort', () => done({ code: 130, stdout: '', stderr: '' }));
      });
    };
    const c = client(run, { journalDir, holdMs: 0 });
    try {
      await c.initialized();
      const replaying = await c.call('checkpoint_replay', {
        checkpoint: CHECKPOINT,
        target: 'SB',
        dryRun: false,
        maxRecords: 3,
        confirm: 'SB',
      });
      const handle = (replaying.structuredContent.running as { run: string }).run;

      const refused = await c.call('checkpoint_replay_remove', {
        checkpoint: CHECKPOINT,
        target: 'SB',
        confirm: 'SB',
      });
      const previewed = await c.call('checkpoint_replay_remove', {
        checkpoint: CHECKPOINT,
        target: 'SB',
        preview: true,
      });

      expect(refused).toMatchObject({
        isError: true,
        structuredContent: { refusal: { code: 'RUN_UNDER_WAY' } },
      });
      expect(textOf(refused)).toContain(`run_stop with run "${handle}" stops it`);
      expect(previewed.isError).toBe(false);
      expect(ran.filter((args) => args.includes('--remove'))).toEqual([
        ['replay', '--checkpoint', CHECKPOINT, '--target', 'SB', '--remove', '--preview', '--json'],
      ]);
    } finally {
      await c.close();
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  it('previews a removal of a replay without confirm, and removes with --yes once confirmed', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    await c.call('checkpoint_replay_remove', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      preview: true,
      sweep: true,
    });
    await c.call('checkpoint_replay_remove', {
      checkpoint: 'Before UAT',
      from: 'DEV',
      target: 'SB',
      confirm: 'SB',
      includeChanged: true,
      muteAutomation: true,
      acceptAutomation: true,
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-checkpoint',
        args: [
          'replay',
          '--checkpoint',
          CHECKPOINT,
          '--target',
          'SB',
          '--remove',
          '--preview',
          '--sweep',
          '--json',
        ],
      },
      {
        script: 'sandforge-checkpoint',
        args: [
          'replay',
          '--checkpoint',
          'Before UAT',
          '--from',
          'DEV',
          '--target',
          'SB',
          '--remove',
          '--include-changed',
          '--mute-automation',
          '--accept-automation',
          '--yes',
          '--json',
        ],
      },
    ]);
    await c.close();
  });

  it('hands the removal of a replay the flags of its sweep: what came late, what is tied to nothing, and its list, which deletes nothing and takes no confirm', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    const listed = await c.call('checkpoint_replay_remove', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      sweepList: true,
      sweepLate: true,
      sweepUntied: true,
    });
    const removed = await c.call('checkpoint_replay_remove', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      confirm: 'SB',
      sweep: true,
      sweepLate: true,
      sweepUntied: true,
    });
    // As the command refuses them, before any script runs.
    const refused = {
      lateAlone: await c.call('checkpoint_replay_remove', {
        checkpoint: CHECKPOINT,
        target: 'SB',
        confirm: 'SB',
        sweepLate: true,
      }),
      sweepAndList: await c.call('checkpoint_replay_remove', {
        checkpoint: CHECKPOINT,
        target: 'SB',
        sweep: true,
        sweepList: true,
      }),
      previewAndList: await c.call('checkpoint_replay_remove', {
        checkpoint: CHECKPOINT,
        target: 'SB',
        preview: true,
        sweepList: true,
      }),
    };

    expect(listed.isError).toBe(false);
    expect(removed.isError).toBe(false);
    expect(ran.map((each) => each.args)).toEqual([
      [
        'replay',
        '--checkpoint',
        CHECKPOINT,
        '--target',
        'SB',
        '--remove',
        '--sweep-list',
        '--sweep-late',
        '--sweep-untied',
        '--json',
      ],
      [
        'replay',
        '--checkpoint',
        CHECKPOINT,
        '--target',
        'SB',
        '--remove',
        '--sweep',
        '--sweep-late',
        '--sweep-untied',
        '--yes',
        '--json',
      ],
    ]);
    for (const [why, result] of Object.entries(refused)) {
      expect(result.structuredContent, why).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    }
    expect(textOf(refused.lateAlone)).toContain('sweepLate goes with sweep, or with sweepList');
    expect(textOf(refused.sweepAndList)).toContain('sweep deletes and sweepList only lists');
    expect(textOf(refused.previewAndList)).toContain('preview deletes nothing');
    await c.close();
  });

  it('names the parameter each flag of its sweep stands for, as the removal of the replay names them', async () => {
    // What the removal says of what its sweep kept, relayed by this server.
    const relayed = process.env[RELAYED_BY_VARIABLE];
    process.env[RELAYED_BY_VARIABLE] = 'sandforge mcp';
    let said: string;
    try {
      said =
        `  Task: 1 made late — ${sweepOptionWords('--sweep-late')} takes them\n` +
        `  Contact: 2 tied to nothing of the replay — ${sweepOptionWords('--sweep-untied')} ` +
        'takes them\n' +
        `  run ${sweepOptionWords('--sweep-list')} to see what\n`;
    } finally {
      if (relayed === undefined) delete process.env[RELAYED_BY_VARIABLE];
      else process.env[RELAYED_BY_VARIABLE] = relayed;
    }
    const { run } = scripts(() => ({ stdout: '{}', stderr: said }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_replay_remove', {
      checkpoint: CHECKPOINT,
      target: 'SB',
      preview: true,
      sweep: true,
    });

    expect(textOf(result)).toContain("--sweep-late, named above, is this tool's sweepLate: true.");
    expect(textOf(result)).toContain(
      "--sweep-untied, named above, is this tool's sweepUntied: true.",
    );
    expect(textOf(result)).toContain(
      "--sweep-list, named above, is this tool's sweepList: true: it lists what the sweep " +
        'would take, and deletes nothing.',
    );
    await c.close();
  });

  it('lists with the checkpoints of an org the replays into it, each with the call that takes it back, and the dry run that replays a checkpoint that no longer rewinds it', async () => {
    const list = [
      {
        id: CHECKPOINT,
        name: 'Before UAT',
        valid: false,
        why: 'refreshed',
        replayWith: `sandforge checkpoint replay --checkpoint ${CHECKPOINT} --target DEV --dry-run`,
      },
      { id: 'ck-20261102-110000-e5f6', name: 'Later', valid: true },
    ];
    const replays = [
      {
        checkpointId: CHECKPOINT,
        sourceOrganizationId: '00D000000000001AAA',
        target: { organizationId: '00D000000000002AAA', name: 'DEV' },
        inPlace: 412,
        inPlaceByObject: [{ objectApiName: 'Account', records: 412 }],
        removeWith: `sandforge checkpoint replay --checkpoint ${CHECKPOINT} --target DEV --remove`,
      },
      {
        checkpointId: 'ck-20261020-110000-a1b2',
        sourceOrganizationId: '00D000000000001AAA',
        target: { organizationId: '00D000000000002AAA', name: 'DEV' },
        inPlace: 0,
        inPlaceByObject: [],
        removed: true,
        removeWith:
          'sandforge checkpoint replay --checkpoint ck-20261020-110000-a1b2 --target DEV --remove',
      },
    ];
    const { ran, run } = scripts((_script, args) => ({
      stdout: JSON.stringify(args[0] === 'list' ? list : replays),
    }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('checkpoint_list', { org: 'DEV' });

    expect(ran.map((each) => each.args)).toEqual([
      ['list', '--org', 'DEV', '--json'],
      ['replays', '--target', 'DEV', '--json'],
    ]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ exitCode: 0, answer: list, replays });
    expect(textOf(result)).toContain(
      `checkpoint "${CHECKPOINT}" no longer rewinds its org, and replays into another: ` +
        `checkpoint_replay with checkpoint "${CHECKPOINT}", target "DEV" and dryRun: true says ` +
        'what it would create there.',
    );
    expect(textOf(result)).toContain(
      '2 replay(s) into DEV kept on this machine, 1 of them with records still there (replays):',
    );
    expect(textOf(result)).toContain(
      `checkpoint_replay_remove with checkpoint "${CHECKPOINT}" and target "DEV" takes them back`,
    );
    expect(textOf(result)).not.toContain('ck-20261020-110000-a1b2" and target');
    await c.close();
  });
});

describe('sandforge-mcp: the plan of a pipeline', () => {
  it('runs pipeline plan with what the run it plans would be given, and never runs one', async () => {
    const { ran, run } = scripts(() => ({ stdout: '{}' }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('pipeline_plan', {
      file: '/repo/nightly.sandforge-pipeline.json',
      acceptOrgs: [{ key: 'reg-dev', organizationId: '00D000000000003AAA' }],
      vars: [{ name: 'env', value: 'uat 2' }],
      varEnvs: [{ name: 'token', env: 'NIGHTLY_TOKEN' }],
      approve: ['Go?'],
      store: '/repo/.pipeline-store',
    });
    const refusals = [
      await c.call('pipeline_plan', {
        file: '/repo/nightly.sandforge-pipeline.json',
        orgs: { 'reg-dev': 'PROD' },
      }),
      await c.call('pipeline_plan', {
        file: '/repo/nightly.sandforge-pipeline.json',
        dryRun: true,
      }),
      await c.call('pipeline_plan', {
        file: '/repo/nightly.sandforge-pipeline.json',
        vars: [{ name: 'a=b', value: 'c' }],
      }),
    ];

    expect(ran).toEqual([
      {
        script: 'sandforge-pipeline',
        args: [
          'plan',
          '--file',
          '/repo/nightly.sandforge-pipeline.json',
          '--accept-org',
          'reg-dev=00D000000000003AAA',
          '--var',
          'env=uat 2',
          '--var-env',
          'token=NIGHTLY_TOKEN',
          '--approve',
          'Go?',
          '--store',
          '/repo/.pipeline-store',
          '--json',
        ],
      },
    ]);
    expect(textOf(result)).toContain(
      "No tool runs a pipeline: its run is the person's, on a terminal, pnpm exec tsx " +
        'packages/extension/cli/sandforge-pipeline.ts run --file /repo/nightly.sandforge-pipeline.json ' +
        '--dry-run first',
    );
    for (const refused of refusals) {
      expect(refused.structuredContent).toMatchObject({ refusal: { code: 'ARGUMENTS' } });
    }
    expect(textOf(refusals[0] as CallResult)).toContain(
      'pipeline_plan plans the orgs the file names, each by its alias in the file',
    );
    expect(textOf(refusals[1] as CallResult)).toContain('no tool runs a pipeline');
    expect(TOOLS.map((t) => t.definition.name)).not.toContain('pipeline_run');
    await c.close();
  });

  it('takes an org whose Organization Id changed by the alias its refusal names, as --accept-org does, and says so', async () => {
    const answer = {
      pipeline: { id: 'pipe-1', name: 'Nightly' },
      plan: true,
      orgs: [],
      steps: [],
      refusals: [
        {
          code: 'ORG_MOVED',
          message: 'UAT answers with another Organization Id than the file says.',
          wayOut: 'run again with --accept-org UAT=00D000000000004AAA once you checked it.',
        },
      ],
      notes: [],
      exit: 2,
    };
    const { ran, run } = scripts(() => ({ code: 2, stdout: JSON.stringify(answer) }));
    const c = client(run);
    await c.initialized();

    const refused = await c.call('pipeline_plan', {
      file: '/repo/nightly.sandforge-pipeline.json',
    });
    await c.call('pipeline_plan', {
      file: '/repo/nightly.sandforge-pipeline.json',
      acceptOrgs: [{ key: 'UAT', organizationId: '00D000000000004AAA' }],
    });

    const acceptOrgs = (
      TOOLS.find((t) => t.definition.name === 'pipeline_plan')?.definition.inputSchema
        .properties as Record<string, { description?: string }>
    ).acceptOrgs;
    expect(acceptOrgs?.description).toContain(
      'the org by its alias, or by its key in the file, and the Id the plan said',
    );
    expect(textOf(refused)).toContain(
      "--accept-org, named above, is this tool's acceptOrgs: the org by its alias, or by its " +
        'key in the file, and the Organization Id taken for it',
    );
    expect(ran[1]?.args).toContain('UAT=00D000000000004AAA');
    await c.close();
  });

  it('answers a plan that refuses as an error in its words, each flag its refusals name read as the parameter it stands for, and says the plan had no terminal', async () => {
    const answer = {
      pipeline: { id: 'pipe-1', name: 'Nightly' },
      plan: true,
      orgs: [],
      steps: [],
      refusals: [
        {
          code: 'APPROVAL_NO_TERMINAL',
          step: 'Go?',
          message: 'Approval step "Go?" has no one to ask: this run has no terminal.',
          wayOut: 'run it in a terminal, or add --approve "Go?".',
        },
        {
          code: 'PRODUCTION_TARGET',
          message: 'Step "Load" writes to PRD, a production org.',
          wayOut: 'point the step at a sandbox; or map reg-prd to one with --org.',
        },
      ],
      notes: [],
      exit: 2,
    };
    const { run } = scripts(() => ({
      code: 2,
      stdout: JSON.stringify(answer),
      stderr: 'Pipeline "Nightly" (2 steps), exported from SandForge 1.81.0 on 2026-11-20.\n',
    }));
    const c = client(run);
    await c.initialized();

    const result = await c.call('pipeline_plan', { file: 'nightly.sandforge-pipeline.json' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ exitCode: 2, answer });
    expect(textOf(result)).toContain('exit 2: the plan refuses: a run would be refused');
    expect(textOf(result)).toContain("--approve, named above, is this tool's approve");
    expect(textOf(result)).toContain(
      '--org, named above, is no parameter of pipeline_plan, which plans the aliases the file names',
    );
    expect(textOf(result)).toContain('This plan had no terminal: an Approval step it says');
    await c.close();
  });
});
