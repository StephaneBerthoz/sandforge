import { afterEach, describe, expect, it, vi } from 'vitest';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { reloadPanel } from './reloadPanel';

describe('reloadPanel', () => {
  afterEach(() => {
    mockPostMessage.mockClear();
    delete window.__SANDFORGE_MODULE__;
  });

  it('asks the extension for the shell of the panel it opened on this module', () => {
    window.__SANDFORGE_MODULE__ = 'forge';

    reloadPanel();

    expect(mockPostMessage).toHaveBeenCalledOnce();
    expect(mockPostMessage.mock.calls[0][0]).toMatchObject({
      payload: { type: 'panel:reload', payload: { moduleId: 'forge' } },
    });
  });

  it('names Home on a page the extension injected no module into, as the panel then shows it', () => {
    reloadPanel();

    expect(mockPostMessage.mock.calls[0][0]).toMatchObject({
      payload: { type: 'panel:reload', payload: { moduleId: 'home' } },
    });
  });
});
