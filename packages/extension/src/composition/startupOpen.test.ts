import { describe, expect, it } from 'vitest';

import { LANDING_COMMAND } from './moduleCommands';
import { openOnStartup, SIDE_PANEL_COMMAND, type StartupOpenDeps } from './startupOpen';

function deps(overrides: Partial<StartupOpenDeps> = {}): {
  deps: StartupOpenDeps;
  ran: string[];
  logged: string[];
} {
  const ran: string[] = [];
  const logged: string[] = [];
  return {
    ran,
    logged,
    deps: {
      wanted: () => true,
      isFirstLaunch: () => false,
      executeCommand: (command) => {
        ran.push(command);
        return Promise.resolve(undefined);
      },
      log: (line) => logged.push(line),
      ...overrides,
    },
  };
}

describe('openOnStartup', () => {
  it('shows the side panel, then opens Home', async () => {
    const { deps: d, ran } = deps();
    await openOnStartup(d);
    expect(ran).toEqual([SIDE_PANEL_COMMAND, LANDING_COMMAND]);
    expect(SIDE_PANEL_COMMAND).toBe('workbench.view.extension.sandforge');
    expect(LANDING_COMMAND).toBe('sandforge.openHome');
  });

  it('opens nothing when the setting is off', async () => {
    const { deps: d, ran } = deps({ wanted: () => false });
    await openOnStartup(d);
    expect(ran).toEqual([]);
  });

  it('leaves the walkthrough in front on the first start after install', async () => {
    const { deps: d, ran } = deps({ isFirstLaunch: () => true });
    await openOnStartup(d);
    expect(ran).toEqual([SIDE_PANEL_COMMAND]);
  });

  it('reads the first start before opening Home, which records the version', async () => {
    let versionSeen = false;
    const order: string[] = [];
    const { deps: d } = deps({
      isFirstLaunch: () => {
        order.push('read');
        return !versionSeen;
      },
      executeCommand: (command) => {
        order.push(command);
        if (command === LANDING_COMMAND) versionSeen = true;
        return Promise.resolve(undefined);
      },
    });
    versionSeen = true;
    await openOnStartup(d);
    expect(order).toEqual(['read', SIDE_PANEL_COMMAND, LANDING_COMMAND]);
  });

  it('still opens Home when the side panel command is refused, and logs it', async () => {
    const {
      deps: d,
      ran,
      logged,
    } = deps({
      executeCommand: (command) => {
        ran.push(command);
        return command === SIDE_PANEL_COMMAND
          ? Promise.reject(new Error('command not found'))
          : Promise.resolve(undefined);
      },
    });
    await openOnStartup(d);
    expect(ran).toEqual([SIDE_PANEL_COMMAND, LANDING_COMMAND]);
    expect(logged).toEqual([
      '[startup] Could not run workbench.view.extension.sandforge: command not found',
    ]);
  });
});
