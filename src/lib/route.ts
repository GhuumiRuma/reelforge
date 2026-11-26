/**
 * Hash-based application routing with a small React subscription bridge.
 *
 * Hash URLs work in static/PWA deployments without server rewrites. This module owns only route
 * transitions and browser history; screens perform the data loading for their selected project.
 */
import { useSyncExternalStore } from 'react';

/** Reachable top-level routes; project-specific URLs carry the stable project ID in the hash. */
export type Route = { name: 'home' } | { name: 'editor'; id: string } | { name: 'studio' };

/** Parses the current hash, falling back to Home for unknown or incomplete paths. */
function parse(): Route {
  if (/^#\/studio\b/.test(location.hash)) return { name: 'studio' };
  const m = /^#\/p\/([\w-]+)/.exec(location.hash);
  return m ? { name: 'editor', id: m[1] } : { name: 'home' };
}

/** Current route snapshot consumed by `useSyncExternalStore`. */
let current: Route = typeof location !== 'undefined' ? parse() : { name: 'home' };
/** Subscribers notified only after the hash changes to a meaningfully different route. */
const listeners = new Set<() => void>();
/** Whether the editor entry was pushed on top of Home (so leaving can simply go back). */
let pushedFromHome = false;

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const next = parse();
    if (next.name === 'home') pushedFromHome = false;
    if (next.name !== current.name || (next.name === 'editor' && current.name === 'editor' && next.id !== current.id)) {
      current = next;
      listeners.forEach((l) => l());
    }
  });
}

/**
 * Registers a React external-store listener and supplies its unsubscription cleanup.
 * The module-level listener set avoids routing state living in a React provider.
 */
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Subscribes a React component to the current route snapshot.
 * Only actual route-name/project-ID changes trigger external-store updates.
 */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Opens a project by appending a hash-history entry from the current screen.
 * The entry is marked as having a previous in-app screen so `goHome` can try one history rewind.
 */
export function openProject(id: string) {
  pushedFromHome = true;
  location.hash = `#/p/${id}`;
}

/** Opens the studio hash route and records that a previous in-app history entry may be available. */
export function openStudio() {
  pushedFromHome = true;
  location.hash = '#/studio';
}

/**
 * Returns to Home through history when this module opened a detail screen from Home.
 * Otherwise it replaces the hash, avoiding an unexpected jump through an external history entry.
 */
export function goHome() {
  if (pushedFromHome) {
    pushedFromHome = false;
    history.back();
  } else {
    location.replace('#/');
  }
}
