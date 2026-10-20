import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCliOrgs } from './sfCliOrgs';

let home: string;

/** Write one file of the CLI's `.sfdx` folder. */
async function cliFile(name: string, value: unknown): Promise<void> {
  await mkdir(join(home, '.sfdx'), { recursive: true });
  await writeFile(
    join(home, '.sfdx', name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sf-cli-orgs-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('countCliOrgs', () => {
  it('counts each org the CLI holds an authorization for', async () => {
    await cliFile('admin@example.com.json', { orgId: 'org-a', username: 'admin@example.com' });
    await cliFile('dev@example.com.sandbox.json', {
      orgId: 'org-b',
      username: 'dev@example.com.sandbox',
    });

    await expect(countCliOrgs(home)).resolves.toBe(2);
  });

  it('counts an org once, however many of its users the CLI holds', async () => {
    await cliFile('admin@example.com.json', { orgId: 'org-a', username: 'admin@example.com' });
    await cliFile('second@example.com.json', { orgId: 'org-a', username: 'second@example.com' });

    await expect(countCliOrgs(home)).resolves.toBe(1);
  });

  it("leaves out the CLI's own files, which name no user", async () => {
    await cliFile('alias.json', { orgs: { dev: 'admin@example.com' } });
    await cliFile('sfdx-config.json', { defaultusername: 'admin@example.com' });
    await cliFile('key.json', { key: 'not-an-org' });

    await expect(countCliOrgs(home)).resolves.toBe(0);
  });

  it('leaves out a scratch org past its expiration date, and keeps one on its last day', async () => {
    const now = Date.parse('2026-10-20T15:00:00Z');
    await cliFile('gone@example.com.json', {
      orgId: 'org-gone',
      username: 'gone@example.com',
      expirationDate: '2026-10-18',
    });
    await cliFile('today@example.com.json', {
      orgId: 'org-today',
      username: 'today@example.com',
      expirationDate: '2026-10-20',
    });

    await expect(countCliOrgs(home, now)).resolves.toBe(1);
  });

  it('counts no org for an unreadable file, a file with no org id, or a partial one', async () => {
    await cliFile('broken@example.com.json', '{ not json');
    await cliFile('noid@example.com.json', { username: 'noid@example.com' });
    await cliFile('half@example.com.partial.json', {
      orgId: 'org-c',
      username: 'half@example.com',
    });

    await expect(countCliOrgs(home)).resolves.toBe(0);
  });

  it('counts no org when the CLI has never run', async () => {
    await expect(countCliOrgs(join(home, 'nobody'))).resolves.toBe(0);
  });
});
