import { create } from 'zustand';
import { isNativeApp } from '../lib/util';
import { DEFAULT_LOOK, lookBackground, lookCss, mergeLook, parseLook, serializeLook } from './appearance';
import type { Look } from './appearance';

/**
 * How the app looks. Two things are saved: the mode (System, Light or Dark) and the look (surface style,
 * accent color and corner roundness, see appearance.ts). The theme the mode resolves to is written to
 * <html data-theme> so styles.css can swap its color tokens, and the look is written as CSS into
 * <style id="rf-look"> on top of that.
 *
 * index.html repeats the resolve step and applies the saved look in an inline script so the first paint
 * already has the right colors (prepaint.test.ts runs it). If a storage key, the default mode or the shape
 * of the saved look changes here, change it there too.
 */
export type Theme = 'light' | 'dark';
export type ThemePref = Theme | 'system';

export const THEME_KEY = 'rf-theme';
export const LOOK_KEY = 'rf-look';
export const DEFAULT_PREF: ThemePref = 'system';

/** The default look's page background in each theme (--stage in styles.css). Other styles differ, see lookBackground. */
export const THEME_COLORS: Record<Theme, string> = { dark: '#0b0b0f', light: '#f4f4f8' };

/** The id of the <style> element that holds the look. index.html creates it before the first paint. */
export const LOOK_STYLE_ID = 'rf-look';

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
  look: Look;
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

function readLook(): Look {
  try {
    return parseLook(localStorage.getItem(LOOK_KEY));
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

function initialState(): ThemeState {
  const pref = readPref();
  return { pref, theme: resolveTheme(pref, !!systemQuery()?.matches), look: readLook() };
}

export const useTheme = create<ThemeState>()(initialState);

function setMeta(name: string, content: string) {
  document.querySelector(`meta[name="${name}"]`)?.setAttribute('content', content);
}

/** Puts the look's CSS in <style id="rf-look">, and takes the element out for the default look, which has none. */
function applyLook(look: Look) {
  const css = lookCss(look);
  let el = document.getElementById(LOOK_STYLE_ID);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = LOOK_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

function apply(theme: Theme, look: Look) {
  document.documentElement.dataset.theme = theme;
  applyLook(look);
  setMeta('theme-color', lookBackground(look, theme));
  setMeta('color-scheme', theme);
  // Only the Android app has system bars of its own to restyle; keep that code out of the web bundle.
  // Every style is light in the light theme and dark in the dark one, so the bar icons follow the theme alone.
  if (isNativeApp()) void import('../lib/native').then((n) => n.nativeSystemBars(theme)).catch(() => undefined);
}

function commit(pref: ThemePref, look: Look) {
  const theme = resolveTheme(pref, !!systemQuery()?.matches);
  useTheme.setState({ pref, theme, look });
  apply(theme, look);
}

/** Saves and applies the user's choice of System, Light or Dark. */
export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage can be blocked or full; the choice then lasts until the app closes.
  }
  commit(pref, useTheme.getState().look);
}

const sameLook = (a: Look, b: Look) => a.style === b.style && a.accent === b.accent && a.corners === b.corners;

/** Saves and applies a change to the look. Fields that aren't valid are ignored. */
export function setLook(patch: Partial<Look>) {
  const current = useTheme.getState().look;
  const merged = mergeLook(current, patch);
  const look = sameLook(current, merged) ? current : merged;
  try {
    localStorage.setItem(LOOK_KEY, serializeLook(look));
  } catch {
    // As in setThemePref: the choice then lasts until the app closes.
  }
  commit(useTheme.getState().pref, look);
}

/** Back to System with the default look and nothing left in storage, as on a first run. */
export function resetAppearance() {
  for (const key of [THEME_KEY, LOOK_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage can't be reached, so there is nothing saved to undo.
    }
  }
  commit(DEFAULT_PREF, { ...DEFAULT_LOOK });
}

/**
 * Refreshes the CSS saved beside a look, if one is saved. index.html applies that copy before the app has
 * loaded, so after an update that changes how a look is built it is rebuilt here for the next launch.
 */
function refreshSavedLook(look: Look) {
  try {
    const saved = localStorage.getItem(LOOK_KEY);
    if (saved === null) return;
    const fresh = serializeLook(look);
    if (saved !== fresh) localStorage.setItem(LOOK_KEY, fresh);
  } catch {
    // Storage can't be reached; the app still has the look in memory.
  }
}

let started = false;

/** Applies the saved look and theme and keeps "System" following the device. Call once at startup. */
export function initTheme() {
  if (started) return;
  started = true;
  const { theme, look } = useTheme.getState();
  apply(theme, look);
  refreshSavedLook(look);
  systemQuery()?.addEventListener('change', () => {
    const state = useTheme.getState();
    if (state.pref === 'system') commit('system', state.look);
  });
}
