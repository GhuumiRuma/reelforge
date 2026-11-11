import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOK, lookBackground, lookCss, serializeLook } from '../state/appearance';
import type { Look } from '../state/appearance';
import { LOOK_KEY, THEME_KEY } from '../state/theme';
import { BlobSink, openBackup, restoreBackup, writeBackup } from './backup';

// appStore is what a backup reads and writes of the app's own settings. These tests run it against the real theme
// module and a small stand-in for the page (as themeStore.test.ts does). They are only about settings, so db.ts is
// given an empty library instead of IndexedDB, which the test environment doesn't have.
vi.mock('./db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db')>()),
  listProjects: async () => [],
  listFolders: async () => [],
  listClipIds: async () => [],
}));

interface FakeStyle {
  id: string;
  textContent: string;
  remove(): void;
}

function installBrowser(opts: { storage?: Record<string, string>; blocked?: boolean } = {}) {
  const storage: Record<string, string> = { ...opts.storage };
  const head: FakeStyle[] = [];
  const meta: Record<string, string> = { 'theme-color': '#0b0b0f', 'color-scheme': 'dark' };
  const dataset: Record<string, string> = {};
  const guard = () => {
    if (opts.blocked) throw new Error('storage is blocked');
  };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      guard();
      return key in storage ? storage[key] : null;
    },
    setItem: (key: string, value: string) => {
      guard();
      storage[key] = value;
    },
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => undefined }) });
  vi.stubGlobal('document', {
    documentElement: { dataset },
    head: { appendChild: (el: FakeStyle) => void head.push(el) },
    createElement: (): FakeStyle => ({
      id: '',
      textContent: '',
      remove() {
        const i = head.indexOf(this);
        if (i >= 0) head.splice(i, 1);
      },
    }),
    getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
      return name ? { setAttribute: (_: string, value: string) => (meta[name] = value) } : null;
    },
  });
  return { storage, head, meta, dataset };
}

type Page = ReturnType<typeof installBrowser>;

/** The CSS in the page's look element, one entry per element. */
const cssOf = (page: Page) => page.head.map((el) => el.textContent);

/** A fresh copy of the app's modules, as after a restart: the stores are built from what the page has saved. */
async function load() {
  vi.resetModules();
  const [{ appStore }, theme] = await Promise.all([import('./backupStore'), import('../state/theme')]);
  return { appStore, ...theme };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const SLATE_SKY: Look = { style: 'slate', accent: '#00b2ff', corners: 'round' };

describe('restoring a look', () => {
  it('applies it now and saves it', async () => {
    const page = installBrowser();
    const { appStore, useTheme } = await load();
    await appStore.setSetting(LOOK_KEY, serializeLook(SLATE_SKY));
    expect(useTheme.getState().look).toEqual(SLATE_SKY);
    expect(cssOf(page)).toEqual([lookCss(SLATE_SKY)]);
    expect(page.meta['theme-color']).toBe(lookBackground(SLATE_SKY, 'dark'));
    expect(page.storage[LOOK_KEY]).toBe(serializeLook(SLATE_SKY));
  });

  it('does not trust the CSS or page colors saved with it', async () => {
    const page = installBrowser();
    const { appStore, useTheme } = await load();
    const fromFile = { ...JSON.parse(serializeLook(SLATE_SKY)), css: 'body{display:none}', bg: { dark: '#ff0000', light: '#ff0000' } };
    await appStore.setSetting(LOOK_KEY, JSON.stringify(fromFile));
    expect(useTheme.getState().look).toEqual(SLATE_SKY);
    expect(cssOf(page)).toEqual([lookCss(SLATE_SKY)]);
    expect(page.storage[LOOK_KEY]).toBe(serializeLook(SLATE_SKY));
  });

  const invalid: [string, string, Look][] = [
    ['text that is not JSON', 'slate, please', DEFAULT_LOOK],
    ['an empty value', '', DEFAULT_LOOK],
    ['JSON that is not a look', '["slate"]', DEFAULT_LOOK],
    ['an unknown version', JSON.stringify({ ...SLATE_SKY, v: 2 }), DEFAULT_LOOK],
    ['an unknown style', JSON.stringify({ ...SLATE_SKY, v: 1, style: 'neon' }), { ...SLATE_SKY, style: DEFAULT_LOOK.style }],
    ['a bad accent', JSON.stringify({ ...SLATE_SKY, v: 1, accent: 'red' }), { ...SLATE_SKY, accent: DEFAULT_LOOK.accent }],
    ['unknown corners', JSON.stringify({ ...SLATE_SKY, v: 1, corners: 'huge' }), { ...SLATE_SKY, corners: DEFAULT_LOOK.corners }],
  ];

  it.each(invalid)('falls back to the default, one field at a time, for %s', async (_, raw, expected) => {
    const page = installBrowser();
    const { appStore, useTheme } = await load();
    await expect(appStore.setSetting(LOOK_KEY, raw)).resolves.toBeUndefined();
    expect(useTheme.getState().look).toEqual(expected);
    expect(page.storage[LOOK_KEY]).toBe(serializeLook(expected));
    expect(cssOf(page).join('')).toBe(lookCss(expected));
  });

  it('still applies it when storage is blocked or full', async () => {
    const page = installBrowser({ blocked: true });
    const { appStore, useTheme } = await load();
    await expect(appStore.setSetting(LOOK_KEY, serializeLook(SLATE_SKY))).resolves.toBeUndefined();
    expect(useTheme.getState().look).toEqual(SLATE_SKY);
    expect(cssOf(page)).toEqual([lookCss(SLATE_SKY)]);
    expect(page.storage).toEqual({});
  });
});

describe('restoring the other settings', () => {
  it('still applies the mode', async () => {
    const page = installBrowser();
    const { appStore, useTheme } = await load();
    await appStore.setSetting(THEME_KEY, 'light');
    expect(useTheme.getState().pref).toBe('light');
    expect(useTheme.getState().theme).toBe('light');
    expect(page.dataset.theme).toBe('light');
    expect(page.meta['color-scheme']).toBe('light');
    // The mode is saved alone; a look is only saved once there is one to save.
    expect(page.storage).toEqual({ [THEME_KEY]: 'light' });
  });

  it('saves the rest as they are', async () => {
    const page = installBrowser();
    const { appStore } = await load();
    await appStore.setSetting('rf-export', '{"quality":"high"}');
    expect(page.storage).toEqual({ 'rf-export': '{"quality":"high"}' });
    expect(await appStore.getSetting('rf-export')).toBe('{"quality":"high"}');
    expect(await appStore.getSetting(LOOK_KEY)).toBeNull();
  });
});

describe('backing up and restoring the appearance', () => {
  /** Chooses a mode and a look on one page and backs that page up. */
  async function backUpChoices() {
    installBrowser();
    const { appStore, setLook, setThemePref } = await load();
    setThemePref('light');
    setLook(SLATE_SKY);
    const sink = new BlobSink();
    await writeBackup(appStore, sink, { files: false, build: 'test' });
    return sink.toBlob();
  }

  it('brings the mode and the look back on a fresh install and applies them', async () => {
    const backup = await backUpChoices();

    const page = installBrowser();
    const { appStore, useTheme } = await load();
    const opened = await openBackup(backup);
    expect(opened.index.settings).toEqual({ [THEME_KEY]: 'light', [LOOK_KEY]: serializeLook(SLATE_SKY) });

    const sum = await restoreBackup(opened, appStore);

    expect(sum.settings).toBe(2);
    const s = useTheme.getState();
    expect([s.pref, s.theme, s.look]).toEqual(['light', 'light', SLATE_SKY]);
    expect(page.dataset.theme).toBe('light');
    expect(cssOf(page)).toEqual([lookCss(SLATE_SKY)]);
    expect(page.meta['theme-color']).toBe(lookBackground(SLATE_SKY, 'light'));
    expect(page.storage).toEqual({ [THEME_KEY]: 'light', [LOOK_KEY]: serializeLook(SLATE_SKY) });
  });

  it('changes nothing when the same backup is restored again', async () => {
    const backup = await backUpChoices();
    const page = installBrowser();
    const { appStore, useTheme } = await load();
    const opened = await openBackup(backup);
    await restoreBackup(opened, appStore);

    const state = useTheme.getState();
    const saved = { ...page.storage };
    const style = page.head[0];

    const again = await restoreBackup(opened, appStore);

    expect(again.settings).toBe(0);
    expect(useTheme.getState()).toBe(state);
    expect(page.storage).toEqual(saved);
    expect(page.head).toHaveLength(1);
    expect(page.head[0]).toBe(style);
  });

  it('leaves a look that is already saved on the device alone', async () => {
    const opened = await openBackup(await backUpChoices());
    expect(opened.index.settings[LOOK_KEY]).toBe(serializeLook(SLATE_SKY));

    const mine: Look = { style: 'warm', accent: '#33c98a', corners: 'sharp' };
    const page = installBrowser({ storage: { [LOOK_KEY]: serializeLook(mine) } });
    const { appStore, initTheme, useTheme } = await load();
    initTheme();

    const sum = await restoreBackup(opened, appStore);

    // Only the mode was missing.
    expect(sum.settings).toBe(1);
    expect(useTheme.getState().pref).toBe('light');
    expect(useTheme.getState().look).toEqual(mine);
    expect(page.storage[LOOK_KEY]).toBe(serializeLook(mine));
    expect(cssOf(page)).toEqual([lookCss(mine)]);
    expect(page.meta['theme-color']).toBe(lookBackground(mine, 'light'));
  });
});
