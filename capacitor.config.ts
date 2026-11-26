import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor packaging contract for the Android shell.
 *
 * The origin is intentionally fixed because Capacitor WebView storage is scoped
 * to it; changing the scheme or hostname would make existing projects appear to
 * disappear after an app update. The web build also remains the only source of
 * native app assets, avoiding a second UI implementation.
 */
const config: CapacitorConfig = {
  appId: 'io.github.monicariverawork.reelforge',
  appName: 'ReelForge',
  webDir: 'dist',
  backgroundColor: '#0b0b0f',
  server: {
    // Projects live in the WebView's IndexedDB, which is keyed by this origin (https://localhost).
    // These are Capacitor's defaults, pinned so an upgrade can never move the app to another origin
    // and strand everyone's saved projects.
    androidScheme: 'https',
    hostname: 'localhost',
  },
  android: {
    // Lets you inspect the app from desktop Chrome (chrome://inspect) when it misbehaves.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
