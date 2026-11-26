import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type Alias } from 'vite';
import { describe, expect, it } from 'vitest';
import config, { experimentalOnly } from '../../vite.config';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(new URL(path, new URL('../../', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** Bundles one file of this section on its own, the way `vite build --mode <mode>` would. */
const bundle = (file: string, mode: string) =>
  build({
    root,
    mode,
    configFile: false,
    logLevel: 'silent',
    plugins: [experimentalOnly()],
    build: { write: false, emptyOutDir: false, rollupOptions: { input: fileURLToPath(new URL(file, import.meta.url)) } },
  });

describe('the Experimental features section', () => {
  it('stops every build but the experimental one that would include it', async () => {
    await expect(bundle('./features.ts', 'production')).rejects.toThrow(/only the experimental build/);
    await expect(bundle('./off.ts', 'production')).resolves.toBeTruthy();
    await expect(bundle('./features.ts', 'experimental')).resolves.toBeTruthy();
  });

  it('gives the public builds the empty stub for @experimental', () => {
    const target = (mode: string) => {
      const alias = config({ command: 'build', mode }).resolve?.alias as readonly Alias[];
      return alias[0].replacement.replaceAll('\\', '/');
    };
    expect(target('production')).toMatch(/\/src\/experimental\/off\.ts$/);
    expect(target('experimental')).toMatch(/\/src\/experimental\/index\.ts$/);
  });

  it('is never published from this public repository', () => {
    const workflow = read('.github/workflows/experimental.yml');
    // An artifact or a release here would be public: the APK goes only to private storage.
    expect(workflow).not.toMatch(/upload-artifact|gh release|action-gh-release/);
    // Azure takes uploads only from this environment's jobs; its federated credential names it.
    expect(workflow).toMatch(/^ {4}environment: experimental$/m);
  });
});
