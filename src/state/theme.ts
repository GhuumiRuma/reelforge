import { create } from 'zustand';
import { isNativeApp } from '../lib/util';

/**
 * Light / dark appearance. The saved preference is System, Light or Dark; the theme it resolves to is
 * written to <html data-theme> so styles.css can swap its color tokens.
 *
 * index.html repeats the resolve step in an inline script so the first paint already has the right
 * colors. If the storage key, default or colors change here, change them there too.
 */
export type Theme = 'light' | 'dark';
export type ThemePref = Theme | 'system';

export const THEME_KEY = 'rf-theme';
export const DEFAULT_PREF: ThemePref = 'system';

/** The page background of each theme (--stage in styles.css), used to tint the browser's own chrome. */
export const THEME_COLORS: Record<Theme, string> = { dark: '#0b0b0f', light: '#f4f4f8' };

export function parsePref(raw: string | null | undefined): ThemePref {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_PREF;
}

export function resolveTheme(pref: ThemePref, systemIsLight: boolean): Theme {
  return pref === 'system' ? (systemIsLight ? 'light' : 'dark') : pref;
}

interface ThemeState {
  pref: ThemePref;
  /** what's actually showing */
  theme: Theme;
}

const systemQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

function readPref(): ThemePref {
  try {
    return parsePref(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_PREF;
  }
}

function initialState(): ThemeState {
  const pref = readPref();
  return { pref, theme: resolveTheme(pref, !!systemQuery()?.matches) };
}

export const useTheme = create<ThemeState>()(initialState);

function setMeta(name: string, content: string) {
  document.querySelector(`meta[name="${name}"]`)?.setAttribute('content', content);
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  setMeta('theme-color', THEME_COLORS[theme]);
  setMeta('color-scheme', theme);
  // Only the Android app has system bars of its own to restyle; keep that code out of the web bundle.
  if (isNativeApp()) void import('../lib/native').then((n) => n.nativeSystemBars(theme)).catch(() => undefined);
}

function commit(pref: ThemePref) {
  const theme = resolveTheme(pref, !!systemQuery()?.matches);
  useTheme.setState({ pref, theme });
  applyTheme(theme);
}

/** Saves and applies the user's choice. */
export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage can be blocked or full; the choice then lasts until the app closes.
  }
  commit(pref);
}

let started = false;

/** Applies the saved theme and keeps "System" following the device. Call once at startup. */
export function initTheme() {
  if (started) return;
  started = true;
  applyTheme(useTheme.getState().theme);
  systemQuery()?.addEventListener('change', () => {
    if (useTheme.getState().pref === 'system') commit('system');
  });
}
