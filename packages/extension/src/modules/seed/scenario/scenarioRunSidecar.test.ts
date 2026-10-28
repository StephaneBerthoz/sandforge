import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BROADBAND_SUPPORT_PACK, RETAIL_ORDERS_PACK } from '@sandforge/shared';
import type { AgentTestChoice, ScenarioPack } from '@sandforge/shared';
import { compileScenario } from './compileScenario';
import {
  compiledForSidecar,
  nodeScenarioSidecarFiles,
  readScenarioRunSidecar,
  scenarioPackFingerprint,
  scenarioRunSidecar,
  scenarioSidecarPath,
  withAgentChoice,
  writeScenarioRunSidecar,
  type ScenarioSidecarFiles,
} from './scenarioRunSidecar';

const OPTIONS = { seed: 7, customers: 6, historyPerCustomer: 1 };
const compiled = compileScenario(RETAIL_ORDERS_PACK, OPTIONS);

/** An id for every case of the compiled scenario, open and closed, as the run gives them. */
function caseIds(): Record<string, string> {
  const rows = compiled.template.objects.find((o) => o.objectApiName === 'Case')?.rows ?? [];
  return Object.fromEntries(
    rows.map((row, index) => [row.key, `500${String(index + 1).padStart(12, '0')}AAA`]),
  );
}

function sidecar() {
  return scenarioRunSidecar({
    runId: 'seed-run-1',
    pack: RETAIL_ORDERS_PACK,
    compiled,
    options: OPTIONS,
    caseIds: caseIds(),
  });
}

const CHOICE: AgentTestChoice = {
  agent: 'Retail_Service_Agent',
  runner: 'testing-center',
  topics: [{ packTopic: 'refund', agentTopic: 'Order_Issues', actions: [] }],
  guardTopic: null,
};

/** A file system in memory, keeping what each call did, in order. */
function memoryFiles(): ScenarioSidecarFiles & { files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>();
  const calls: string[] = [];
  return {
    files,
    calls,
    readFile: async (file) => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (file, content) => {
      calls.push(`write ${path.basename(file)}`);
      files.set(file, content);
    },
    rename: async (from, to) => {
      calls.push(`rename ${path.basename(from)} ${path.basename(to)}`);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    mkdir: async (dir) => {
      calls.push(`mkdir ${path.basename(dir)}`);
    },
  };
}

describe('scenarioRunSidecar', () => {
  it('keeps the id of each open case by its key, and none of a closed case', () => {
    const kept = sidecar();
    const open = compiled.tests.flatMap((t) => (t.openCase ? [t.openCase.caseKey] : []));
    expect(Object.keys(kept.openCases).sort()).toEqual([...new Set(open)].sort());
    const ids = caseIds();
    for (const key of Object.keys(kept.openCases)) expect(kept.openCases[key]).toBe(ids[key]);
    expect(Object.keys(kept.openCases).every((key) => key.endsWith('-open'))).toBe(true);
  });

  it('keeps no value of a record: no subject, no address, no name the run wrote', () => {
    const text = JSON.stringify(sidecar());
    for (const test of compiled.tests) {
      if (!test.openCase) continue;
      expect(text).not.toContain(test.openCase.contactEmail);
      expect(text).not.toContain(test.openCase.subject);
    }
    const accounts =
      compiled.template.objects.find((o) => o.objectApiName === 'Account')?.rows ?? [];
    for (const row of accounts) expect(text).not.toContain(String(row.values.Name));
  });

  it('keeps the pack by its id and fingerprint, and the choices it was compiled with, its seed among them', () => {
    expect(sidecar()).toEqual({
      version: 1,
      runId: 'seed-run-1',
      packId: 'retail-orders',
      packFingerprint: scenarioPackFingerprint(RETAIL_ORDERS_PACK),
      compile: { seed: 7, customers: 6, historyPerCustomer: 1 },
      openCases: expect.any(Object),
    });
    const defaults = scenarioRunSidecar({
      runId: 'seed-run-2',
      pack: RETAIL_ORDERS_PACK,
      compiled: compileScenario(RETAIL_ORDERS_PACK),
      caseIds: {},
    });
    expect(defaults.compile).toEqual({ seed: 1 });
    expect(defaults.openCases).toEqual({});
  });

  it('keeps the agent the user matched the scenario to, once matched', () => {
    expect(withAgentChoice(sidecar(), CHOICE).agent).toEqual(CHOICE);
    expect(() => withAgentChoice(sidecar(), { ...CHOICE, runner: 'studio' } as never)).toThrow();
  });
});

describe('scenarioPackFingerprint', () => {
  it('is the same for a pack saved again with its keys in another order', () => {
    const reordered = Object.fromEntries(
      Object.entries(RETAIL_ORDERS_PACK).reverse(),
    ) as unknown as ScenarioPack;
    expect(scenarioPackFingerprint(reordered)).toBe(scenarioPackFingerprint(RETAIL_ORDERS_PACK));
  });

  it('changes with one word of the pack', () => {
    const edited = structuredClone(RETAIL_ORDERS_PACK);
    edited.topics[2].utterances[0].text += ' Please.';
    expect(scenarioPackFingerprint(edited)).not.toBe(scenarioPackFingerprint(RETAIL_ORDERS_PACK));
    expect(scenarioPackFingerprint(RETAIL_ORDERS_PACK)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('compiledForSidecar', () => {
  it('compiles the pack again into the tests the run was compiled with', () => {
    const again = compiledForSidecar(sidecar(), RETAIL_ORDERS_PACK);
    expect(again.ok && again.compiled.tests).toEqual(compiled.tests);
  });

  it('refuses a pack edited since the run, whose tests would be about what no record holds', () => {
    const edited = structuredClone(RETAIL_ORDERS_PACK);
    edited.topics[0].utterances[0].expectedOutcome += ' Promptly.';
    expect(compiledForSidecar(sidecar(), edited)).toEqual({
      ok: false,
      message:
        'The scenario retail-orders has changed since the run: its tests would be about subjects ' +
        'and addresses no record of the run holds',
    });
  });

  it('refuses another pack than the run was seeded from', () => {
    expect(compiledForSidecar(sidecar(), BROADBAND_SUPPORT_PACK)).toEqual({
      ok: false,
      message: 'The run was seeded from the scenario retail-orders, not broadband-support',
    });
  });
});

describe('the companion file on disk', () => {
  it('is named after its run, beside the seed runs, a character a file name cannot hold as _', () => {
    expect(scenarioSidecarPath(path.join('storage'), 'seed:run/1')).toBe(
      path.join('storage', 'seed-runs', 'seed_run_1.scenario.json'),
    );
  });

  it('is written whole through a file renamed over it, and read back as it was written', async () => {
    const files = memoryFiles();
    const kept = withAgentChoice(sidecar(), CHOICE);
    const where = await writeScenarioRunSidecar(files, 'storage', kept);
    expect(where).toBe(scenarioSidecarPath('storage', 'seed-run-1'));
    expect(files.calls).toEqual([
      'mkdir seed-runs',
      `write seed-run-1.scenario.json.${process.pid}.tmp`,
      `rename seed-run-1.scenario.json.${process.pid}.tmp seed-run-1.scenario.json`,
    ]);
    expect(await readScenarioRunSidecar(files, 'storage', 'seed-run-1')).toEqual({
      kind: 'read',
      sidecar: kept,
    });
  });

  it('says there is none for a run that kept none', async () => {
    expect(await readScenarioRunSidecar(memoryFiles(), 'storage', 'seed-run-9')).toEqual({
      kind: 'absent',
    });
  });

  it('says what is wrong with a file that is not a companion file, without throwing', async () => {
    const files = memoryFiles();
    const file = scenarioSidecarPath('storage', 'seed-run-1');
    files.files.set(file, '{ "version": 1, ');
    expect(await readScenarioRunSidecar(files, 'storage', 'seed-run-1')).toEqual({
      kind: 'invalid',
      message: 'seed-run-1.scenario.json is not JSON',
    });
    files.files.set(file, JSON.stringify({ ...sidecar(), packFingerprint: 'abc' }));
    expect(await readScenarioRunSidecar(files, 'storage', 'seed-run-1')).toEqual({
      kind: 'invalid',
      message: 'seed-run-1.scenario.json: packFingerprint: A sha256, in lower-case hexadecimal',
    });
    files.files.set(file, JSON.stringify({ ...sidecar(), runId: 'seed-run-2' }));
    expect(await readScenarioRunSidecar(files, 'storage', 'seed-run-1')).toEqual({
      kind: 'invalid',
      message: 'seed-run-1.scenario.json is the companion of the run seed-run-2, not seed-run-1',
    });
  });

  describe('over Node file system', () => {
    let root: string | undefined;
    afterEach(async () => {
      if (root) await rm(root, { recursive: true, force: true });
      root = undefined;
    });

    it('writes the file under seed-runs, leaving no temporary file, and reads it back', async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'sandforge-scenario-sidecar-'));
      const files = nodeScenarioSidecarFiles();
      await writeScenarioRunSidecar(files, root, sidecar());
      expect(await readdir(path.join(root, 'seed-runs'))).toEqual(['seed-run-1.scenario.json']);
      expect(JSON.parse(await readFile(scenarioSidecarPath(root, 'seed-run-1'), 'utf8'))).toEqual(
        sidecar(),
      );
      const read = await readScenarioRunSidecar(files, root, 'seed-run-1');
      expect(read).toEqual({ kind: 'read', sidecar: sidecar() });
      await writeFile(scenarioSidecarPath(root, 'seed-run-1'), 'not json');
      expect((await readScenarioRunSidecar(files, root, 'seed-run-1')).kind).toBe('invalid');
    });
  });
});
