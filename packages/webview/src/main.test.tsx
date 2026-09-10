import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Entry-point tests for `main.tsx`.
 *
 * What stood here was nine lines that never imported the module: a comment
 * promising to "verify the module is syntactically valid and exports cleanly"
 * over a bare `expect(true).toBe(true)`. It counted as a passing test in every
 * run while asserting nothing about the file it named — the failure this repo
 * has now paid for several times, in its purest form.
 *
 * `main.tsx` runs entirely at import time, so the module *is* the behaviour:
 * it picks a root component from `window.__SANDFORGE_MODULE__` and mounts it
 * into `#root`, but only once the i18n bundle has crossed the bridge. Each
 * test resets the module registry and imports it fresh, captures the element
 * handed to `createRoot(...).render(...)`, and mounts that element to see what
 * the host would actually have got.
 */

/** The element `main.tsx` handed to the React root, per import. */
let rendered: React.ReactElement | null = null;
const rootRender = vi.fn((element: React.ReactElement) => {
  rendered = element;
});
const createRoot = vi.fn(() => ({ render: rootRender, unmount: vi.fn() }));

vi.mock('react-dom/client', () => ({
  default: { createRoot },
  createRoot,
}));

/* The real panels drag in the bridge provider stack and the whole page tree;
   what is under test is which one main.tsx chooses, not what it renders. */
vi.mock('./PanelApp', () => ({
  PanelApp: ({ moduleId }: { moduleId: string }) => (
    <div data-testid="panel-app">{`module:${moduleId}`}</div>
  ),
}));
vi.mock('./SidePanel', () => ({
  SidePanel: () => <div data-testid="side-panel" />,
}));

/**
 * The anti-flash gate, under this test's control.
 *
 * `main.tsx` renders inside `i18nReady.then(...)`. A settled stand-in would
 * make the gate untestable — awaiting the dynamic import already turns the
 * microtask queue enough times to run the continuation, so the render would
 * look synchronous. `vi.resetModules()` re-runs this factory, so each import
 * picks up a fresh unresolved promise that only `gate.release()` settles.
 */
const gate = vi.hoisted(() => {
  let release: () => void = () => {};
  let promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    get promise() {
      return promise;
    },
    release: () => release(),
    reset: () => {
      promise = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
});

/* A getter, not a value: vitest memoises the factory's module object, so a
   plain `i18nReady: gate.promise` would freeze the first promise — already
   released by the first test — and every later import would render at once. */
vi.mock('./i18n', () => ({
  get i18nReady() {
    return gate.promise;
  },
}));

/** Let the `i18nReady.then(...)` continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Import a fresh copy of the entry point with the gate still shut. */
async function importEntryPoint(): Promise<void> {
  vi.resetModules();
  gate.reset();
  await import('./main');
}

/** Import it and let the i18n gate through, which is what triggers the render. */
async function importAndOpenGate(): Promise<void> {
  await importEntryPoint();
  gate.release();
  await flush();
}

describe('main.tsx entry point', () => {
  beforeEach(() => {
    rendered = null;
    rootRender.mockClear();
    createRoot.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
    delete (window as { __SANDFORGE_MODULE__?: string }).__SANDFORGE_MODULE__;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts into the #root element the host provides', async () => {
    await importAndOpenGate();

    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(rootRender).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Home panel when the host injected no module id', async () => {
    await importAndOpenGate();

    render(rendered as React.ReactElement);
    expect(screen.getByTestId('panel-app').textContent).toBe('module:home');
    expect(screen.queryByTestId('side-panel')).toBeNull();
  });

  it('mounts the side panel for the sidepanel module id', async () => {
    (window as { __SANDFORGE_MODULE__?: string }).__SANDFORGE_MODULE__ = 'sidepanel';
    await importAndOpenGate();

    render(rendered as React.ReactElement);
    expect(screen.getByTestId('side-panel')).toBeDefined();
    expect(screen.queryByTestId('panel-app')).toBeNull();
  });

  it('mounts the requested module for any other module id', async () => {
    (window as { __SANDFORGE_MODULE__?: string }).__SANDFORGE_MODULE__ = 'monitor';
    await importAndOpenGate();

    render(rendered as React.ReactElement);
    expect(screen.getByTestId('panel-app').textContent).toBe('module:monitor');
  });

  it('renders nothing when the document carries no #root', async () => {
    // The VSCode host owns the HTML; a panel whose template lost the div must
    // not throw on import, or the whole webview dies before the error surfaces.
    document.body.innerHTML = '';
    await importAndOpenGate();

    expect(createRoot).not.toHaveBeenCalled();
    expect(rootRender).not.toHaveBeenCalled();
  });

  it('holds the first render until the i18n gate settles', async () => {
    // Render at import time instead and a restored non-English UI paints
    // English first — the flash the gate exists to prevent.
    await importEntryPoint();
    await flush();
    expect(rootRender).not.toHaveBeenCalled();

    gate.release();
    await flush();
    expect(rootRender).toHaveBeenCalledTimes(1);
  });
});
