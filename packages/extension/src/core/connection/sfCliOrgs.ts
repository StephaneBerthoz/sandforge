import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A file of the CLI's folder that holds one authorization: named after its
 * username, `<username>.json`. The folder also holds `alias.json`,
 * `key.json`, `sfdx-config.json` and the CLI's own state files, none named
 * with an `@`.
 */
const AUTH_FILE = /^[^.][^@/\\]*@[^/\\]+\.json$/;

/**
 * How many orgs the Salesforce CLI holds an authorization for: the orgs an
 * import from the CLI looks at, before anything is imported. The import
 * itself keeps those the CLI still has a session for, which only a call to
 * each org tells: a refresh token revoked or expired leaves its file in
 * place. So this is the most an import can bring in, and the launcher says
 * "up to" that many; it said "Import 3 orgs" for an import that brought in
 * two.
 *
 * Read from the CLI's own files (`~/.sfdx/<username>.json`) rather than by
 * running `sf org list`, which starts a Node process and calls every org it
 * holds: the launcher asks only while no org is registered, to say how many
 * orgs one click would bring in. A developer with `sf` set up for the
 * Salesforce Extensions had every org one click away, and the launcher only
 * said "No org connected".
 *
 * Counted once per org, however many usernames the CLI holds for it, as the
 * import keeps one; a scratch org past its expiration date is left out, the
 * import refusing it. Only the org id, the username and the expiration date
 * of each file are looked at. Never throws: no folder, or a file that cannot
 * be read, counts as no org.
 *
 * @param homeDir - The user's home directory, which holds the CLI's `.sfdx` folder.
 * @param now - The time a scratch org's expiration date is compared with.
 */
export async function countCliOrgs(homeDir: string, now: number = Date.now()): Promise<number> {
  const folder = join(homeDir, '.sfdx');
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return 0;
  }
  const orgIds = new Set<string>();
  await Promise.all(
    names
      .filter((name) => AUTH_FILE.test(name) && !name.endsWith('.partial.json'))
      .map(async (name) => {
        const orgId = await orgIdOf(join(folder, name), now);
        if (orgId) orgIds.add(orgId);
      }),
  );
  return orgIds.size;
}

/** The org id an authorization file holds, unless it is unreadable or has expired. */
async function orgIdOf(path: string, now: number): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { orgId, username, expirationDate } = parsed as Record<string, unknown>;
    if (typeof orgId !== 'string' || orgId === '' || typeof username !== 'string') {
      return undefined;
    }
    if (typeof expirationDate === 'string') {
      const expires = Date.parse(expirationDate);
      // A scratch org's date is a day: it lives through the whole of it.
      if (Number.isFinite(expires) && expires + 24 * 60 * 60 * 1000 <= now) return undefined;
    }
    return orgId;
  } catch {
    return undefined;
  }
}
