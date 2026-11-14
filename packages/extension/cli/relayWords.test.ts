import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  envWords,
  ownOptionWords,
  relayTakes,
  relayedBy,
  relayedByAnEnvironment,
} from './relayWords.js';
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
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge mcp');

    expect(relayTakes('--mute-automation')).toBe(true);
    expect(ownOptionWords('--leave-undeletable', 'removal')).toBe('--leave-undeletable');
    expect(ownOptionWords('--store')).toBe('--store');
    expect(ownOptionWords('--max-total')).toBe("this script's own --max-total");
    expect(ownOptionWords('--sweep', 'removal')).toBe("this script's own removal with --sweep");
  });

  it('takes the sweep alone for an environment’s destroy, and nothing for its apply, or for an environment the MCP server runs', () => {
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge env');
    expect(relayTakes('--sweep')).toBe(true);
    expect(relayTakes('--mute-automation')).toBe(false);
    expect(ownOptionWords('--leave-undeletable', 'removal')).toBe(
      "this script's own removal with --leave-undeletable",
    );

    for (const relay of ['sandforge env apply', 'sandforge env, relayed by sandforge mcp']) {
      vi.stubEnv(RELAYED_BY_VARIABLE, relay);
      expect(relayTakes('--sweep')).toBe(false);
      expect(relayTakes('--mute-automation')).toBe(false);
    }
  });

  it('takes --include-changed where the removal it hands it to does: a destroy, env_destroy and run_remove, never an apply', () => {
    // A removal an apply's replace ran said "(--include-changed takes them)",
    // which no apply takes; the destroy, which takes it, was told it did not.
    for (const relay of [
      'sandforge env',
      'sandforge env, relayed by sandforge mcp',
      'sandforge mcp',
    ]) {
      vi.stubEnv(RELAYED_BY_VARIABLE, relay);
      expect(relayTakes('--include-changed'), relay).toBe(true);
    }
    for (const relay of [
      'sandforge env apply',
      'sandforge env plan',
      'sandforge env apply, relayed by sandforge mcp',
    ]) {
      vi.stubEnv(RELAYED_BY_VARIABLE, relay);
      expect(relayTakes('--include-changed'), relay).toBe(false);
      expect(ownOptionWords('--include-changed', 'removal')).toBe(
        "this script's own removal with --include-changed",
      );
    }
  });

  it('says an option in the words of an environment that relays the script, whichever its verb and whoever relays it, and as itself otherwise', () => {
    // Relayed by an environment's plan, a clone said "choices from --template
    // …" and "(--keep-contact-points)": options its file set, no flag its reader gave.
    for (const relay of [
      'sandforge env',
      'sandforge env plan',
      'sandforge env apply',
      'sandforge env apply, relayed by sandforge mcp',
    ]) {
      vi.stubEnv(RELAYED_BY_VARIABLE, relay);
      expect(relayedByAnEnvironment(), relay).toBe(true);
      expect(envWords('--keep-contact-points', 'keepContactPoints'), relay).toBe(
        'keepContactPoints',
      );
    }
    for (const relay of ['sandforge mcp', '']) {
      vi.stubEnv(RELAYED_BY_VARIABLE, relay);
      expect(relayedByAnEnvironment(), relay).toBe(false);
      expect(envWords('--keep-contact-points', 'keepContactPoints'), relay).toBe(
        '--keep-contact-points',
      );
    }
  });
});
