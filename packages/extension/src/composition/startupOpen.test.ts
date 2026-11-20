import { describe, expect, it } from 'vitest';

import { LANDING_COMMAND } from './moduleCommands';
import {
  bringsWhatsNew,
  homeOnSidePanelShown,
  openOnStartup,
  RESTORED_VIEW_MS,
  SIDE_PANEL_COMMAND,
  type StartupOpenDeps,
} from './startupOpen';

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
      whatsNewWanted: () => true,
      isFirstLaunch: () => false,
      isUpdate: () => true,
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
  it('shows the side panel, then opens Home, as a window starts after an update', async () => {
    const { deps: d, ran } = deps();
    await openOnStartup(d);
    expect(ran).toEqual([SIDE_PANEL_COMMAND, LANDING_COMMAND]);
    expect(SIDE_PANEL_COMMAND).toBe('workbench.view.extension.sandforge');
    expect(LANDING_COMMAND).toBe('sandforge.openHome');
  });

  it('opens nothing as a window starts on the version that ran last', async () => {
    const { deps: d, ran } = deps({ isUpdate: () => false });
    await openOnStartup(d);
    expect(ran).toEqual([]);
  });

  it("opens nothing after an update when What's New is turned off", async () => {
    const { deps: d, ran } = deps({ whatsNewWanted: () => false });
    await openOnStartup(d);
    expect(ran).toEqual([]);
  });

  it('leaves the walkthrough in front on the first start after install', async () => {
    const { deps: d, ran } = deps({ isFirstLaunch: () => true, isUpdate: () => false });
    await openOnStartup(d);
    expect(ran).toEqual([SIDE_PANEL_COMMAND]);
  });

  it('reads the start before opening Home, which records the version', async () => {
    let versionSeen = false;
    const order: string[] = [];
    const { deps: d } = deps({
      isFirstLaunch: () => {
        order.push('first');
        return false;
      },
      isUpdate: () => {
        order.push('update');
        return !versionSeen;
      },
      executeCommand: (command) => {
        order.push(command);
        if (command === LANDING_COMMAND) versionSeen = true;
        return Promise.resolve(undefined);
      },
    });
    await openOnStartup(d);
    expect(order).toEqual(['first', 'update', SIDE_PANEL_COMMAND, LANDING_COMMAND]);
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

describe('homeOnSidePanelShown', () => {
  function shown(start = 10_000): {
    tell: () => void;
    clock: { at: number };
    ran: string[];
    logged: string[];
    refuse: { next: boolean };
  } {
    const clock = { at: start };
    const ran: string[] = [];
    const logged: string[] = [];
    const refuse = { next: false };
    const tell = homeOnSidePanelShown({
      now: () => clock.at,
      executeCommand: (command) => {
        ran.push(command);
        if (refuse.next) return Promise.reject(new Error('no panel'));
        return Promise.resolve(undefined);
      },
      log: (line) => logged.push(line),
    });
    return { tell, clock, ran, logged, refuse };
  }

  it('opens Home when the side panel is shown by a click', () => {
    const { tell, clock, ran } = shown();
    clock.at += RESTORED_VIEW_MS + 1;
    tell();
    expect(ran).toEqual([LANDING_COMMAND]);
  });

  it('opens nothing for the side panel VS Code restores with the window', () => {
    const { tell, clock, ran } = shown();
    tell();
    clock.at += RESTORED_VIEW_MS - 1;
    tell();
    expect(ran).toEqual([]);
  });

  it('opens Home once for one showing told twice, and again at the next click', () => {
    const { tell, clock, ran } = shown();
    clock.at += RESTORED_VIEW_MS + 1;
    tell();
    clock.at += 200;
    tell();
    expect(ran).toEqual([LANDING_COMMAND]);
    clock.at += 5_000;
    tell();
    expect(ran).toEqual([LANDING_COMMAND, LANDING_COMMAND]);
  });

  it('logs a Home the editor could not open', async () => {
    const { tell, clock, logged, refuse } = shown();
    clock.at += RESTORED_VIEW_MS + 1;
    refuse.next = true;
    tell();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logged).toEqual(['[sidebar] Could not run sandforge.openHome: no panel']);
  });
});

describe('bringsWhatsNew', () => {
  it('is an update to a later minor or major version', () => {
    expect(bringsWhatsNew('1.83.0', '1.84.0')).toBe(true);
    expect(bringsWhatsNew('1.83.2', '1.84.1')).toBe(true);
    expect(bringsWhatsNew('1.99.0', '2.0.0')).toBe(true);
  });

  it('is not a patch, a downgrade, the same version or one that does not read', () => {
    expect(bringsWhatsNew('1.84.0', '1.84.1')).toBe(false);
    expect(bringsWhatsNew('1.84.1', '1.84.0')).toBe(false);
    expect(bringsWhatsNew('1.84.0', '1.83.0')).toBe(false);
    expect(bringsWhatsNew('2.0.0', '1.99.0')).toBe(false);
    expect(bringsWhatsNew('1.84.0', '1.84.0')).toBe(false);
    expect(bringsWhatsNew(undefined, '1.84.0')).toBe(false);
    expect(bringsWhatsNew('dev', '1.84.0')).toBe(false);
  });
});
