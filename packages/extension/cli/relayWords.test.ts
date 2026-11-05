import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownOptionWords, relayTakes, relayedBy } from './relayWords.js';
import { RELAYED_BY_VARIABLE } from './scriptRunner.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('relayWords', () => {
  it('reads no relay from an unset or empty variable, and names every option as itself', () => {
    vi.stubEnv(RELAYED_BY_VARIABLE, '  ');

    expect(relayedBy()).toBeUndefined();
    expect(relayTakes('--leave-undeletable')).toBe(true);
    expect(ownOptionWords('--max-total')).toBe('--max-total');
  });

  it('names an option the MCP server takes as itself, and one it does not as this script’s own', () => {
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge-mcp');

    expect(relayTakes('--mute-automation')).toBe(true);
    expect(ownOptionWords('--leave-undeletable', 'removal')).toBe('--leave-undeletable');
    expect(ownOptionWords('--store')).toBe('--store');
    expect(ownOptionWords('--max-total')).toBe("this script's own --max-total");
    expect(ownOptionWords('--sweep', 'removal')).toBe("this script's own removal with --sweep");
  });

  it('takes the sweep alone for an environment’s destroy, and nothing for its apply, or for an environment the MCP server runs', () => {
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge-env');
    expect(relayTakes('--sweep')).toBe(true);
    expect(relayTakes('--mute-automation')).toBe(false);
    expect(ownOptionWords('--leave-undeletable', 'removal')).toBe(
      "this script's own removal with --leave-undeletable",
    );

    for (const relay of ['sandforge-env apply', 'sandforge-env, relayed by sandforge-mcp']) {
      vi.stubEnv(RELAYED_BY_VARIABLE, relay);
      expect(relayTakes('--sweep')).toBe(false);
      expect(relayTakes('--mute-automation')).toBe(false);
    }
  });
});
