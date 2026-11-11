import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOK, STYLES, lookBackground, lookCss, parseLook, serializeLook } from './appearance';
import type { Look } from './appearance';

// theme.ts keeps the mode and look in a zustand store, in localStorage and on the page. There is no DOM in these
// tests, so a small stand-in provides just what it touches, and each test loads a fresh copy of the module.

interface FakeElement {
  id: string;
  textContent: string;
  remove(): void;
}

function installBrowser(opts: { storage?: Record<string, string>; blocked?: boolean; systemLight?: boolean; native?: boolean } = {}) {
  const storage: Record<string, string> = { ...opts.storage };
  const head: FakeElement[] = [];
  const meta: Record<string, string> = { 'theme-color': '#0b0b0f', 'color-scheme': 'dark' };
  const dataset: Record<string, string> = {};
  const listeners: (() => void)[] = [];
  const query = {
    matches: !!opts.systemLight,
    addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
  };
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
    removeItem: (key: string) => {
      guard();
      delete storage[key];
    },
  });
  vi.stubGlobal('window', {
    matchMedia: () => query,
    ...(opts.native ? { Capacitor: { isNativePlatform: () => true } } : {}),
  });
  vi.stubGlobal('document', {
    documentElement: { dataset },
    head: { appendChild: (el: FakeElement) => void head.push(el) },
    createElement: (): FakeElement => ({
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
  return {
    storage,
    head,
    meta,
    dataset,
    /** the device switches between its light and dark appearance */
    setSystemLight(light: boolean) {
      query.matches = light;
      for (const fn of listeners) fn();
    },
  };
}

async function load() {
  vi.resetModules();
  return import('./theme');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../lib/native');
  vi.resetModules();
});

const SLATE_SKY: Look = { style: 'slate', accent: '#00b2ff', corners: 'round' };

describe('a first run', () => {
  it('starts on System with the default look and saves nothing', async () => {
    const page = installBrowser();
    const { initTheme, useTheme } = await load();
    initTheme();
    const s = useTheme.getState();
    expect(s.pref).toBe('system');
    expect(s.theme).toBe('dark');
    expect(s.look).toEqual(DEFAULT_LOOK);
    expect(page.storage).toEqual({});
    expect(page.head).toEqual([]);
    expect(page.dataset.theme).toBe('dark');
    expect(page.meta).toEqual({ 'theme-color': '#0b0b0f', 'color-scheme': 'dark' });
  });

  it('follows the device in System, but not once a mode is chosen', async () => {
    const page = installBrowser({ systemLight: true });
    const { initTheme, setThemePref, useTheme } = await load();
    initTheme();
    expect(useTheme.getState().theme).toBe('light');
    expect(page.meta['theme-color']).toBe('#f4f4f8');
    page.setSystemLight(false);
    expect(useTheme.getState().theme).toBe('dark');
    expect(page.dataset.theme).toBe('dark');
    expect(page.meta['color-scheme']).toBe('dark');
    setThemePref('light');
    page.setSystemLight(false);
    page.setSystemLight(true);
    expect(useTheme.getState().theme).toBe('light');
    setThemePref('dark');
    page.setSystemLight(true);
    expect(useTheme.getState().theme).toBe('dark');
  });
});

describe('a saved look', () => {
  it('is read at startup and applied to the page', async () => {
    const page = installBrowser({ storage: { 'rf-look': serializeLook(SLATE_SKY) } });
    const { initTheme, useTheme } = await load();
    expect(useTheme.getState().look).toEqual(SLATE_SKY);
    initTheme();
    expect(page.head.map((el) => el.id)).toEqual(['rf-look']);
    expect(page.head[0].textContent).toBe(lookCss(SLATE_SKY));
    expect(page.meta['theme-color']).toBe(STYLES.slate.dark.stage);
  });

  it('falls back field by field when a saved value is not valid', async () => {
    installBrowser({ storage: { 'rf-look': JSON.stringify({ v: 1, style: 'neon', accent: 'red', corners: 'round' }) } });
    const { useTheme } = await load();
    expect(useTheme.getState().look).toEqual({ ...DEFAULT_LOOK, corners: 'round' });
  });

  it('is rebuilt at startup, in place of the copy the first-paint script applied', async () => {
    const stale = JSON.stringify({ ...JSON.parse(serializeLook(SLATE_SKY)), css: 'html{--stage:#123456}' });
    const page = installBrowser({ storage: { 'rf-look': stale } });
    const first = { id: 'rf-look', textContent: 'html{--stage:#123456}', remove: () => undefined };
    page.head.push(first);
    const { initTheme } = await load();
    initTheme();
    expect(page.head).toEqual([first]);
    expect(first.textContent).toBe(lookCss(SLATE_SKY));
    expect(page.storage['rf-look']).toBe(serializeLook(SLATE_SKY));
  });

  it('is only refreshed when one was saved', async () => {
    const page = installBrowser();
    const { initTheme } = await load();
    initTheme();
    expect('rf-look' in page.storage).toBe(false);
  });
});

describe('setLook', () => {
  it('saves the choice and applies it', async () => {
    const page = installBrowser();
    const { setLook, useTheme } = await load();
    setLook({ style: 'warm', accent: '#00b2ff' });
    const look: Look = { style: 'warm', accent: '#00b2ff', corners: 'standard' };
    expect(useTheme.getState().look).toEqual(look);
    expect(parseLook(page.storage['rf-look'])).toEqual(look);
    expect(JSON.parse(page.storage['rf-look']).css).toBe(lookCss(look));
    expect(page.head.map((el) => el.textContent)).toEqual([lookCss(look)]);
    expect(page.meta['theme-color']).toBe(lookBackground(look, 'dark'));
    // The mode is a separate choice and is left alone.
    expect('rf-theme' in page.storage).toBe(false);
  });

  it('keeps what was chosen before, and the page color follows the theme', async () => {
    const page = installBrowser();
    const { setLook, setThemePref, useTheme } = await load();
    setLook({ style: 'pure' });
    setLook({ corners: 'sharp' });
    expect(useTheme.getState().look).toEqual({ style: 'pure', accent: DEFAULT_LOOK.accent, corners: 'sharp' });
    expect(page.meta['theme-color']).toBe(STYLES.pure.dark.stage);
    setThemePref('light');
    expect(page.meta['theme-color']).toBe(STYLES.pure.light.stage);
    expect(page.meta['color-scheme']).toBe('light');
    expect(useTheme.getState().look.style).toBe('pure');
  });

  it('ignores values that are not valid', async () => {
    installBrowser();
    const { setLook, useTheme } = await load();
    setLook({ style: 'warm' });
    const before = useTheme.getState().look;
    setLook({ style: 'neon' as Look['style'], accent: 'red', corners: 'huge' as Look['corners'] });
    expect(useTheme.getState().look).toEqual(before);
  });

  it('keeps the same look object when nothing changed, so nothing redraws', async () => {
    installBrowser();
    const { setLook, useTheme } = await load();
    setLook({ style: 'slate' });
    const before = useTheme.getState().look;
    setLook({ style: 'slate' });
    expect(useTheme.getState().look).toBe(before);
  });

  it('takes the CSS off the page when the default look is chosen again', async () => {
    const page = installBrowser();
    const { setLook } = await load();
    setLook(SLATE_SKY);
    expect(page.head).toHaveLength(1);
    setLook(DEFAULT_LOOK);
    expect(page.head).toEqual([]);
    expect(page.meta['theme-color']).toBe('#0b0b0f');
  });

  it('replaces the CSS in one element instead of piling elements up', async () => {
    const page = installBrowser();
    const { setLook } = await load();
    setLook({ style: 'warm' });
    const el = page.head[0];
    setLook({ accent: '#33c98a' });
    setLook({ style: 'contrast' });
    expect(page.head).toEqual([el]);
    expect(el.textContent).toBe(lookCss({ style: 'contrast', accent: '#33c98a', corners: 'standard' }));
  });
});

describe('resetAppearance', () => {
  it('removes everything saved and restores the default look and System', async () => {
    const page = installBrowser({ systemLight: true });
    const { initTheme, resetAppearance, setLook, setThemePref, useTheme } = await load();
    initTheme();
    setThemePref('dark');
    setLook(SLATE_SKY);
    expect(Object.keys(page.storage).sort()).toEqual(['rf-look', 'rf-theme']);
    resetAppearance();
    expect(page.storage).toEqual({});
    expect(page.head).toEqual([]);
    const s = useTheme.getState();
    expect(s.pref).toBe('system');
    expect(s.theme).toBe('light');
    expect(s.look).toEqual(DEFAULT_LOOK);
    expect(page.dataset.theme).toBe('light');
    expect(page.meta).toEqual({ 'theme-color': '#f4f4f8', 'color-scheme': 'light' });
  });

  it('is a copy of the default look, not the shared object', async () => {
    installBrowser();
    const { resetAppearance, useTheme } = await load();
    resetAppearance();
    expect(useTheme.getState().look).not.toBe(DEFAULT_LOOK);
  });
});

describe('when storage is blocked', () => {
  it('still starts, saves nothing and applies changes until the app closes', async () => {
    const page = installBrowser({ blocked: true });
    const { initTheme, resetAppearance, setLook, setThemePref, useTheme } = await load();
    expect(() => initTheme()).not.toThrow();
    expect(useTheme.getState().look).toEqual(DEFAULT_LOOK);

    expect(() => setThemePref('light')).not.toThrow();
    expect(useTheme.getState().theme).toBe('light');
    expect(page.dataset.theme).toBe('light');

    expect(() => setLook(SLATE_SKY)).not.toThrow();
    expect(useTheme.getState().look).toEqual(SLATE_SKY);
    expect(page.head.map((el) => el.textContent)).toEqual([lookCss(SLATE_SKY)]);
    expect(page.meta['theme-color']).toBe(STYLES.slate.light.stage);

    expect(() => resetAppearance()).not.toThrow();
    expect(useTheme.getState().look).toEqual(DEFAULT_LOOK);
    expect(useTheme.getState().pref).toBe('system');
    expect(page.head).toEqual([]);
  });
});

describe('the Android system bars', () => {
  it('follow the theme, whatever the look', async () => {
    const bars = vi.fn((_theme: string) => Promise.resolve());
    vi.doMock('../lib/native', () => ({ nativeSystemBars: bars }));
    installBrowser({ native: true });
    const { initTheme, setLook, setThemePref } = await load();
    // The bars are set through a dynamic import, so each step waits for its own call before the next change.
    const calls = () => bars.mock.calls.map(([theme]) => theme);
    initTheme();
    await vi.waitFor(() => expect(calls()).toEqual(['dark']));
    setThemePref('light');
    await vi.waitFor(() => expect(calls()).toEqual(['dark', 'light']));
    setLook({ style: 'contrast' });
    await vi.waitFor(() => expect(calls()).toEqual(['dark', 'light', 'light']));
    setThemePref('dark');
    await vi.waitFor(() => expect(calls()).toEqual(['dark', 'light', 'light', 'dark']));
  });

  it('are left to the web page in a browser', async () => {
    const bars = vi.fn((_theme: string) => Promise.resolve());
    vi.doMock('../lib/native', () => ({ nativeSystemBars: bars }));
    installBrowser();
    const { initTheme, setThemePref } = await load();
    initTheme();
    setThemePref('light');
    await new Promise((r) => setTimeout(r, 20));
    expect(bars).not.toHaveBeenCalled();
  });
});
