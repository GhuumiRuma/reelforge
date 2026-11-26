/**
 * Transient application-shell state. These values describe PWA installation and
 * update events rather than editor data, so they intentionally are not persisted.
 */
import { create } from 'zustand';

/** Browser install prompt retained until the Home screen can present a custom action. */
export interface BeforeInstallPromptEvent extends Event {
  /** Opens the browser's installation UI; it must be called from a user gesture. */
  prompt(): Promise<void>;
  /** Resolves after the user accepts or dismisses that installation UI. */
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface AppState {
  /** a new version of the app has been downloaded and is waiting */
  needRefresh: boolean;
  /** Android/desktop Chrome install prompt, captured for a custom Install button */
  installEvent: BeforeInstallPromptEvent | null;
  updateSW: ((reload?: boolean) => Promise<void>) | null;
}

/** Global read/write bridge for service-worker updates and PWA installation events. */
export const useApp = create<AppState>()(() => ({
  needRefresh: false,
  installEvent: null,
  updateSW: null,
}));

/*
 * Capture install events at module load so a prompt triggered before Home mounts is
 * still available there. An installed app clears the stale prompt from the store.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    useApp.setState({ installEvent: e as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => useApp.setState({ installEvent: null }));
}
