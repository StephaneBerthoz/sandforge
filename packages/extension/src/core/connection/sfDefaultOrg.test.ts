import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSfDefaultOrg } from './sfDefaultOrg';

let base: string;
let home: string;
let project: string;

async function writeJson(path: string, value: unknown, writtenAt?: Date): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  if (writtenAt) await utimes(path, writtenAt, writtenAt);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sf-default-org-'));
  home = join(base, 'home');
  project = join(base, 'work', 'acme-project');
  await mkdir(home, { recursive: true });
  await writeJson(join(project, 'sfdx-project.json'), { packageDirectories: [] });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('readSfDefaultOrg', () => {
  it("reads the project's default org from a workspace folder inside the project", async () => {
    await writeJson(join(project, '.sf', 'config.json'), { 'target-org': 'project-dev' });
    await mkdir(join(project, 'force-app', 'main'), { recursive: true });

    await expect(
      readSfDefaultOrg({ folders: [join(project, 'force-app', 'main')], homeDir: home, env: {} }),
    ).resolves.toBe('project-dev');
  });

  it("prefers the project's default to the user's", async () => {
    await writeJson(join(project, '.sf', 'config.json'), { 'target-org': 'project-dev' });
    await writeJson(join(home, '.sf', 'config.json'), { 'target-org': 'global-dev' });

    await expect(readSfDefaultOrg({ folders: [project], homeDir: home, env: {} })).resolves.toBe(
      'project-dev',
    );
  });

  it("falls back to the user's default when the project sets none", async () => {
    await writeJson(join(project, '.sf', 'config.json'), { 'org-api-version': '62.0' });
    await writeJson(join(home, '.sf', 'config.json'), { 'target-org': 'global-dev' });

    await expect(readSfDefaultOrg({ folders: [project], homeDir: home, env: {} })).resolves.toBe(
      'global-dev',
    );
  });

  it("reads the user's default when no workspace folder sits in a project", async () => {
    await mkdir(join(base, 'loose'), { recursive: true });
    await writeJson(join(home, '.sfdx', 'sfdx-config.json'), { defaultusername: 'dev@acme.test' });

    await expect(
      readSfDefaultOrg({ folders: [join(base, 'loose')], homeDir: home, env: {} }),
    ).resolves.toBe('dev@acme.test');
    await expect(readSfDefaultOrg({ folders: [], homeDir: home, env: {} })).resolves.toBe(
      'dev@acme.test',
    );
  });

  it('takes the project of the first workspace folder that sits in one', async () => {
    await mkdir(join(base, 'notes'), { recursive: true });
    await writeJson(join(project, '.sf', 'config.json'), { 'target-org': 'project-dev' });

    await expect(
      readSfDefaultOrg({ folders: [join(base, 'notes'), project], homeDir: home, env: {} }),
    ).resolves.toBe('project-dev');
  });

  it('takes the file written last when both the sf and the older sfdx file name an org', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-02-01T00:00:00Z');
    await writeJson(join(project, '.sf', 'config.json'), { 'target-org': 'from-sf' }, earlier);
    await writeJson(
      join(project, '.sfdx', 'sfdx-config.json'),
      { defaultusername: 'from-sfdx' },
      later,
    );

    await expect(readSfDefaultOrg({ folders: [project], homeDir: home, env: {} })).resolves.toBe(
      'from-sfdx',
    );

    await utimes(join(project, '.sf', 'config.json'), later, new Date('2026-03-01T00:00:00Z'));
    await expect(readSfDefaultOrg({ folders: [project], homeDir: home, env: {} })).resolves.toBe(
      'from-sf',
    );
  });

  it('lets SF_TARGET_ORG override every file, as the CLI does', async () => {
    await writeJson(join(project, '.sf', 'config.json'), { 'target-org': 'project-dev' });

    await expect(
      readSfDefaultOrg({ folders: [project], homeDir: home, env: { SF_TARGET_ORG: 'from-env' } }),
    ).resolves.toBe('from-env');
  });

  it('answers undefined when nothing names a default, or a file cannot be read', async () => {
    await expect(
      readSfDefaultOrg({ folders: [project], homeDir: home, env: {} }),
    ).resolves.toBeUndefined();

    await writeJson(join(project, '.sf', 'config.json'), '{ not json');
    await writeJson(join(home, '.sf', 'config.json'), { 'target-org': 42 });
    await expect(
      readSfDefaultOrg({ folders: [project], homeDir: home, env: { SF_TARGET_ORG: '  ' } }),
    ).resolves.toBeUndefined();
  });
});
