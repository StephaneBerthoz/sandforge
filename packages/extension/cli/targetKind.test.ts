import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import * as live from '../src/core/precheck/orgKindLive.js';
import {
  isProductionTarget,
  productionTargetRefusal,
  refuseProductionTarget,
  typeTarget,
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

const WRITE = { tool: 'sandforge-seed', action: 'write', readOnly: '--dry-run' } as const;
const DELETE = { tool: 'sandforge-cleanup', action: 'delete', readOnly: '--dry-run' } as const;

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
        'Enterprise Edition): sandforge-seed writes to sandboxes and Developer Edition orgs ' +
        'only. Nothing was written; --dry-run, which only reads, runs against it.',
    );
    expect(productionTargetRefusal('CI-TARGET', { id: ORG_ID, sandbox: false }, DELETE)).toBe(
      'CI-TARGET is a production org (its Organization record says IsSandbox false, and no ' +
        'edition): sandforge-cleanup deletes from sandboxes and Developer Edition orgs only. ' +
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
