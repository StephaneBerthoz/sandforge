import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './zodJitless';

describe('zod without eval in the webview', () => {
  it('turns the compiled parsers off, which the webview policy would refuse', () => {
    expect(z.config().jitless).toBe(true);
  });

  it.each(['main.tsx', 'main.sidepanel.tsx'])(
    'is the first thing %s imports, ahead of any schema',
    (entry) => {
      const source = readFileSync(resolve(__dirname, entry), 'utf8');
      const imports = [...source.matchAll(/^import\s.*$/gm)].map((match) => match[0]);
      expect(imports[0]).toBe("import './zodJitless';");
    },
  );
});
