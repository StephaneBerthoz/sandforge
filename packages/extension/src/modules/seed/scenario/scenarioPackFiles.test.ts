import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_SCENARIO_PACKS, RETAIL_ORDERS_PACK, SAAS_SUPPORT_PACK } from '@sandforge/shared';
import type { ScenarioPack } from '@sandforge/shared';
import {
  SCENARIO_PACK_FILE_SUFFIX,
  SCENARIO_PACK_SEARCH,
  findScenarioPack,
  findScenarioPackFiles,
  listScenarioPacks,
  nodeScenarioPackFiles,
  readScenarioPackText,
  saveScenarioPack,
  scenarioPackText,
} from './scenarioPackFiles';
import { scenarioPackFingerprint } from './scenarioRunSidecar';

/** A pack of the user's: the retail pack under another id and name. */
const OWN_PACK: ScenarioPack = { ...RETAIL_ORDERS_PACK, id: 'own-shop', name: 'Our shop' };

describe('scenario pack files, in a workspace on disk', () => {
  let root: string;
  const files = nodeScenarioPackFiles();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sandforge-scenarios-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the shipped packs first, then the workspace files read, one that does not hold said with its field', async () => {
    mkdirSync(join(root, 'scenarios'));
    writeFileSync(
      join(root, 'scenarios', `own-shop${SCENARIO_PACK_FILE_SUFFIX}`),
      scenarioPackText(OWN_PACK),
    );
    writeFileSync(
      join(root, `broken${SCENARIO_PACK_FILE_SUFFIX}`),
      JSON.stringify({ ...OWN_PACK, id: 'Broken Id' }),
    );
    writeFileSync(join(root, 'notes.json'), '{}');

    const entries = await listScenarioPacks(files, [root]);

    expect(entries.slice(0, BUILT_IN_SCENARIO_PACKS.length)).toEqual(
      BUILT_IN_SCENARIO_PACKS.map((pack) => ({ source: 'built-in', pack })),
    );
    const workspace = entries.slice(BUILT_IN_SCENARIO_PACKS.length);
    expect(workspace.map((entry) => 'relativePath' in entry && entry.relativePath)).toEqual([
      `broken${SCENARIO_PACK_FILE_SUFFIX}`,
      `scenarios/own-shop${SCENARIO_PACK_FILE_SUFFIX}`,
    ]);
    expect(workspace[0]).toMatchObject({
      source: 'workspace',
      issues: [expect.stringMatching(/^id: /)],
    });
    expect(workspace[1]).toMatchObject({ source: 'workspace', pack: OWN_PACK });
  });

  it('does not walk dependencies, hidden folders, or deeper than the search goes', async () => {
    for (const dir of ['node_modules', '.sfdx', 'a/b/c/d']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, `own-shop${SCENARIO_PACK_FILE_SUFFIX}`),
        scenarioPackText(OWN_PACK),
      );
    }
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c', `deep${SCENARIO_PACK_FILE_SUFFIX}`), '{}');

    const found = await findScenarioPackFiles(files, [root]);

    expect(SCENARIO_PACK_SEARCH.depth).toBe(3);
    expect(found.map((file) => file.relativePath)).toEqual([
      `a/b/c/deep${SCENARIO_PACK_FILE_SUFFIX}`,
    ]);
  });

  it('saves a pack at the first folder root, never over a file there unless told to', async () => {
    const saved = await saveScenarioPack(files, [root], OWN_PACK);
    expect(saved).toEqual({
      kind: 'saved',
      path: join(root, `own-shop${SCENARIO_PACK_FILE_SUFFIX}`),
      relativePath: `own-shop${SCENARIO_PACK_FILE_SUFFIX}`,
    });

    const edited = { ...OWN_PACK, name: 'Our shop, edited' };
    expect((await saveScenarioPack(files, [root], edited)).kind).toBe('exists');
    expect(
      readScenarioPackText(
        readFileSync(join(root, `own-shop${SCENARIO_PACK_FILE_SUFFIX}`), 'utf8'),
      ),
    ).toEqual({
      pack: OWN_PACK,
    });

    expect((await saveScenarioPack(files, [root], edited, true)).kind).toBe('saved');
    expect(
      readScenarioPackText(
        readFileSync(join(root, `own-shop${SCENARIO_PACK_FILE_SUFFIX}`), 'utf8'),
      ),
    ).toEqual({
      pack: edited,
    });
  });

  it('saves nowhere with no folder open', async () => {
    expect(await saveScenarioPack(files, [], OWN_PACK)).toEqual({ kind: 'no-workspace' });
  });

  it("finds a run's pack by its id and fingerprint, shipped or saved, and none edited since", async () => {
    await saveScenarioPack(files, [root], OWN_PACK);

    expect(
      await findScenarioPack(
        files,
        [root],
        SAAS_SUPPORT_PACK.id,
        scenarioPackFingerprint(SAAS_SUPPORT_PACK),
      ),
    ).toBe(SAAS_SUPPORT_PACK);
    expect(
      await findScenarioPack(files, [root], 'own-shop', scenarioPackFingerprint(OWN_PACK)),
    ).toEqual(OWN_PACK);
    const before = scenarioPackFingerprint({ ...OWN_PACK, name: 'Our shop, as it ran' });
    expect(await findScenarioPack(files, [root], 'own-shop', before)).toBeUndefined();
  });
});

describe('readScenarioPackText', () => {
  it('says a file that is not JSON is not', () => {
    expect(readScenarioPackText('{ not json')).toEqual({ issues: ['The file is not JSON'] });
  });

  it('names each field a pack breaks', () => {
    const read = readScenarioPackText(JSON.stringify({ ...OWN_PACK, topics: [] }));

    expect('issues' in read && read.issues).toEqual([
      expect.stringMatching(/^topics: /),
      expect.stringMatching(/^decoy\.resembles: /),
    ]);
  });
});
