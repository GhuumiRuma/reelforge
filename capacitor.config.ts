import type { CapacitorConfig } from '@capacitor/cli';

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
