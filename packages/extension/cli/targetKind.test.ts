import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import * as live from '../src/core/precheck/orgKindLive.js';
import {
  isProductionTarget,
  productionTargetRefusal,
  refuseProductionTarget,
  typeTarget,
  untypedTargetRefusal,
} from './targetKind.js';

const ORG_ID = '00D000000000001AAA';

/** An org whose Organization record says `row`, and whose edition reads `edition`. */
function org(row: Record<string, unknown> | undefined, edition?: string | Error) {
  const asked: string[] = [];
  const conn = {
    query: vi.fn(async (soql: string) => {
      asked.push(soql);
      if (soql.startsWith('SELECT OrganizationType')) {
        if (edition instanceof Error) throw edition;
        return { records: [{ OrganizationType: edition }], totalSize: 1 };
      }
      return { records: row ? [row] : [], totalSize: row ? 1 : 0 };
    }),
  } as unknown as Pick<Connection, 'query'>;
  return { conn, asked };
}

const WRITE = { tool: 'sandforge seed', action: 'write', readOnly: '--dry-run' } as const;
const DELETE = { tool: 'sandforge cleanup', action: 'delete', readOnly: '--dry-run' } as const;

describe('what a command line takes its target for', () => {
  it("types the org with the extension's own reading, so a command line and a checkpoint agree", () => {
    expect(typeTarget).toBe(live.typeTarget);
    expect(isProductionTarget).toBe(live.isProductionTarget);
  });

  it('says why it refuses, what it did not do and what runs against the org instead', () => {
    expect(
      productionTargetRefusal(
        'CI-TARGET',
        { id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' },
        WRITE,
      ),
    ).toBe(
      'CI-TARGET is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge seed writes to sandboxes and Developer Edition orgs ' +
        'only. Nothing was written; --dry-run, which only reads, runs against it.',
    );
    expect(productionTargetRefusal('CI-TARGET', { id: ORG_ID, sandbox: false }, DELETE)).toBe(
      'CI-TARGET is a production org (its Organization record says IsSandbox false, and no ' +
        'edition): sandforge cleanup deletes from sandboxes and Developer Edition orgs only. ' +
        'Nothing was deleted; --dry-run, which only reads, runs against it.',
    );
    expect(
      productionTargetRefusal(
        'DEV',
        { id: ORG_ID, sandbox: false, edition: 'Developer Edition' },
        DELETE,
      ),
    ).toBeUndefined();
  });
});

describe('the refusal before a command writes or deletes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run the refusal, `process.exit` stopping it where it would end the command. */
  async function refused(conn: Pick<Connection, 'query'>, command: typeof WRITE | typeof DELETE) {
    let code: number | undefined;
    let stderr = '';
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c;
      throw new Error('exit');
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    await refuseProductionTarget(conn, 'CI-TARGET', command).catch(() => undefined);
    return { code, stderr };
  }

  it('stops the command with exit 1 on a production org, and says nothing was written', async () => {
    const { code, stderr } = await refused(
      org({ Id: ORG_ID, IsSandbox: false }, 'Enterprise Edition').conn,
      WRITE,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('CI-TARGET is a production org');
    expect(stderr).toContain('Nothing was written');
  });

  it('stops it too on an org that will not say what it is', async () => {
    const { code, stderr } = await refused(org(undefined).conn, DELETE);
    expect(code).toBe(1);
    expect(stderr).toContain('CI-TARGET did not say what org it is');
    expect(stderr).toContain('Nothing was deleted.');
  });

  /** An org whose Organization record could not be read: the query fails with `err`. */
  function failing(err: Error): Pick<Connection, 'query'> {
    return {
      query: vi.fn(async () => {
        throw err;
      }),
    } as unknown as Pick<Connection, 'query'>;
  }

  it("names sf's sign-in when the org refused the session, which no permission would lift", async () => {
    const expired = Object.assign(new Error('INVALID_SESSION_ID: Session expired or invalid'), {
      errorCode: 'INVALID_SESSION_ID',
    });

    const { code, stderr } = await refused(failing(expired), WRITE);

    expect(code).toBe(1);
    expect(stderr).toBe(
      'CI-TARGET refused the session sf gave for it (INVALID_SESSION_ID: Session expired or ' +
        'invalid), and sandforge seed writes to no org it cannot tell from a production one. ' +
        '"sf org display --target-org CI-TARGET" says what sf holds for it; "sf org login web ' +
        '--alias CI-TARGET" signs in again (in a CI job, "sf org login jwt" or "sf org login ' +
        'sfdxurl"); then run the command again. Nothing was written.\n',
    );
  });

  it('says to run again when the org did not answer', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

    const { code, stderr } = await refused(failing(reset), DELETE);

    expect(code).toBe(1);
    expect(stderr).toMatch(/^CI-TARGET did not answer \(socket hang up\), and sandforge cleanup/);
    expect(stderr).toContain('Run the command again once it answers. Nothing was deleted.');
    expect(stderr).not.toMatch(/sf org login|View Setup/);
  });

  it('names View Setup and Configuration when the user may not read the Organization record', async () => {
    for (const denied of [
      Object.assign(new Error('INSUFFICIENT_ACCESS: insufficient access rights on object id'), {
        errorCode: 'INSUFFICIENT_ACCESS',
      }),
      Object.assign(new Error("INVALID_TYPE: sObject type 'Organization' is not supported."), {
        errorCode: 'INVALID_TYPE',
      }),
    ]) {
      const { code, stderr } = await refused(failing(denied), WRITE);

      expect(code).toBe(1);
      expect(stderr).toMatch(/^CI-TARGET would not show its Organization record/);
      expect(stderr).toContain(
        'Reading it takes the View Setup and Configuration permission: give it to the user the ' +
          'alias signs in as, or name an alias of a user who has it. Nothing was written.',
      );
      expect(stderr).not.toMatch(/sf org login/);
    }
  });

  it('keeps its first words for an org that answered and said nothing of itself', () => {
    expect(
      untypedTargetRefusal('CI-TARGET', new Error('the query timed out on the server'), WRITE),
    ).toMatch(/did not answer/);
    expect(
      untypedTargetRefusal('CI-TARGET', new Error('MALFORMED_QUERY: unexpected token'), WRITE),
    ).toBe(
      'CI-TARGET did not say what org it is (MALFORMED_QUERY: unexpected token), and sandforge ' +
        'seed writes to no org it cannot tell from a production one. Nothing was written.',
    );
  });

  it('hands back a sandbox or a Developer Edition org as typed, and goes on', async () => {
    const exit = vi.spyOn(process, 'exit');
    await expect(
      refuseProductionTarget(org({ Id: ORG_ID, IsSandbox: true }).conn, 'SBX', WRITE),
    ).resolves.toEqual({ id: ORG_ID, sandbox: true });
    await expect(
      refuseProductionTarget(
        org({ Id: ORG_ID, IsSandbox: false }, 'Developer Edition').conn,
        'DE',
        DELETE,
      ),
    ).resolves.toEqual({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' });
    expect(exit).not.toHaveBeenCalled();
  });
});
