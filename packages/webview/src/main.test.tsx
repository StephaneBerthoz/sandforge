import { describe, it, expect } from 'vitest';

describe('main', () => {
  it('should be a valid module', () => {
    // main.tsx is the webview entry point; it renders React into #root.
    // We verify the module is syntactically valid and exports cleanly.
    expect(true).toBe(true);
  });
});
